import contracts from '../../contracts/contracts';
import { utils as ethersUtils } from 'ethers';
import { getCurrency, DAI, ETH, USD } from './Currency';

export default class ProxyCdp {
  constructor(
    cdpService,
    dsProxyAddress,
    cdpId,
    { lockAndDraw = false, amountEth = null, amountDai = null } = {}
  ) {
    this._cdpService = cdpService;
    this._smartContractService = this._cdpService.get('smartContract');
    this._transactionManager = this._smartContractService.get('transactionManager'); // prettier-ignore

    if (dsProxyAddress) this.dsProxyAddress = dsProxyAddress.toLowerCase();
    if (lockAndDraw) {
      this._create({ lockAndDraw, amountEth, amountDai });
    } else {
      if (!cdpId) this._create();
      else this.id = cdpId;
    }

    this._emitterInstance = this._cdpService.get('event').buildEmitter();
    this.on = this._emitterInstance.on;
    this._emitterInstance.registerPollEvents({
      COLLATERAL: {
        USD: () => this.getCollateralValue(USD),
        ETH: () => this.getCollateralValue()
      },
      DEBT: {
        dai: () => this.getDebtValue()
      }
    });
  }

  _getDsProxyAddress() {
    const dsProxyFactoryContract = this._smartContractService.getContractByName(contracts.DS_PROXY_FACTORY); // prettier-ignore
    const currentAccount = this._smartContractService
      .get('web3')
      .currentAccount();

    const self = this;
    return new Promise(resolve => {
      // sender = ProxyRegistry, owner = you, proxy = new DSProxy address, cache = DSProxyCache
      // eslint-disable-next-line
      dsProxyFactoryContract.oncreated = function(sender, owner, proxy, cache) {
        if (currentAccount.toLowerCase() == owner.toLowerCase()) {
          this.removeListener();
          self.dsProxyAddress = proxy.toLowerCase();
          resolve(self.getDsProxyAddress);
        }
      };
    });
  }

  _getCdpId(saiProxyAddress, tubContract, dsProxyAddressPromise) {
    return new Promise(resolve => {
      // If using an existing DSProxy, listen for the LogNewCup event
      const existingDsProxyAddress = this.dsProxyAddress;
      if (existingDsProxyAddress) {
        tubContract.onlognewcup = function(address, cdpIdBytes32) {
          if (existingDsProxyAddress == address.toLowerCase()) {
            const cdpId = ethersUtils.bigNumberify(cdpIdBytes32).toNumber();
            this.removeListener();
            resolve(cdpId);
          }
        };
      }
      // If a new DSProxy instance is being created at the same time as the cup,
      // listen for the give event (via DSNote) rather than the LogNewCup event
      else {
        console.log('subscribing!');
        const subscription = this._smartContractService
          .get('web3')
          .subscribe('logs', {
            topics: [
              ethersUtils.id('give(bytes32,address)').substring(0, 10) + '0'.repeat(56), // prettier-ignore
              '0x000000000000000000000000' + saiProxyAddress.substring(2)
            ]
          }, (err, result) => {
            console.log(err, result);
          })
          .on('data', log => {
            console.log('got logs:', log);
            Promise.resolve(dsProxyAddressPromise).then(() => {
              const proxyInLog = '0x' + log.topics[3].substr(26).toLowerCase();
              if (this.dsProxyAddress === proxyInLog) {
                resolve(ethersUtils.bigNumberify(log.topics[2]).toNumber());
                subscription.unsubscribe();
              }
            });
          });

        // provider.on(topics, log => {
        //   Promise.resolve(dsProxyAddressPromise).then(() => {
        //     const proxyInLog = '0x' + log.topics[3].substr(26).toLowerCase();
        //     if (this.dsProxyAddress === proxyInLog) {
        //       resolve(ethersUtils.bigNumberify(log.topics[2]).toNumber());
        //     }
        //   });
        // });
      }
    });
  }

  _create({ lockAndDraw = false, amountEth = null, amountDai = null } = {}) {
    const tub = this._smartContractService.getContractByName(contracts.SAI_TUB);
    const saiProxy = this._smartContractService.getContractByName(contracts.SAI_PROXY); // prettier-ignore

    let method, args, dsProxyAddressPromise;
    if (!this.dsProxyAddress) {
      const proxyRegistryAddress = this._smartContractService.getContractAddressByName(contracts.PROXY_REGISTRY); // prettier-ignore

      if (lockAndDraw) {
        const valueEth = getCurrency(amountEth, ETH).toEthersBigNumber('wei');
        const valueDai = getCurrency(amountDai, DAI).toEthersBigNumber('wei');
        method = 'createOpenLockAndDraw';
        args = [
          proxyRegistryAddress,
          tub.address,
          valueDai,
          {
            metadata: {
              action: {
                name: method,
                amountEth: getCurrency(amountEth, ETH),
                amountDai: getCurrency(amountDai, DAI)
              }
            },
            value: valueEth,
            promise
          }
        ];
      } else {
        method = 'createAndOpen';
        args = [
          proxyRegistryAddress,
          tub.address,
          {
            metadata: {
              action: {
                name: method
              }
            },
            promise
          }
        ];
      }
      dsProxyAddressPromise = this._getDsProxyAddress();
    } else {
      if (lockAndDraw) {
        const valueEth = getCurrency(amountEth, ETH).toEthersBigNumber('wei');
        const valueDai = getCurrency(amountDai, DAI).toEthersBigNumber('wei');
        method = 'lockAndDraw(address,uint256)';
        args = [
          tub.address,
          valueDai,
          {
            metadata: {
              action: {
                name: 'openLockAndDraw',
                amountEth: getCurrency(amountEth, ETH),
                amountDai: getCurrency(amountDai, DAI),
                proxy: this.dsProxyAddress
              }
            },
            value: valueEth,
            dsProxyAddress: this.dsProxyAddress,
            promise
          }
        ];
      } else {
        method = 'open';
        args = [
          tub.address,
          {
            metadata: {
              action: {
                name: method,
                proxy: this.dsProxyAddress
              }
            },
            dsProxyAddress: this.dsProxyAddress,
            promise
          }
        ];
      }
    }

    const promise = (async () => {
      // this "no-op await" is necessary for the inner reference to the
      // outer promise to become valid
      await 0;
      const results = await Promise.all([
        this._getCdpId(saiProxy.address, tub, dsProxyAddressPromise),
        saiProxy[method](...args)
      ]);
      this.id = results[0];
      return this;
    })();
    this._transactionObject = promise;
  }

  transactionObject() {
    return this._transactionObject;
  }
}

// Each of these passthrough methods gets called on the EthereumCdpService
// If the second array item is true then the method name with 'Proxy' appended is
// called and the DSProxy address and CDP id are passed as the first and second arg
// Otherwise the method name is called and the just CDP id is passed
const passthroughMethods = [
  ['bite', false],
  ['drawDai', true],
  ['enoughMkrToWipe', false],
  ['freeEth', true],
  // 'freePeth',
  ['getCollateralValue', false],
  ['getCollateralizationRatio', false],
  ['getDebtValue', false],
  ['getGovernanceFee', false],
  ['getInfo', false],
  ['getLiquidationPrice', false],
  ['isSafe', false],
  ['give', true],
  ['lockEth', true],
  // 'lockPeth',
  // 'lockWeth',
  ['shut', true],
  ['wipeDai', true],
  ['lockEthAndDrawDai', true]
];

Object.assign(
  ProxyCdp.prototype,
  passthroughMethods.reduce((acc, [name, useProxy]) => {
    acc[name] = useProxy
      ? function(...args) {
          return this._cdpService[name + 'Proxy'](
            this.dsProxyAddress,
            this.id,
            ...args
          );
        }
      : function(...args) {
          return this._cdpService[name](this.id, ...args);
        };

    return acc;
  }, {})
);
