import { createCurrencyRatio } from '@makerdao/currency';
import {
  mcdMaker,
  setupCollateral,
  setDebtCeiling,
  setLiquidationPenalty,
  setLiquidationRatio,
  setStabilityFee,
  setPar
} from './helpers';
import { RAY, ServiceRoles } from '../src/constants';
import { ETH, MDAI, MKR, USD, COL1 } from '../src';
import BigNumber from 'bignumber.js';
const { CDP_MANAGER, CDP_TYPE, QUERY_API } = ServiceRoles;

let maker, service;

// these CDP types should be available to the Maker instance because
// of the configuration passed into it (see test/helpers.js)
const scenarios = [['ETH-A', ETH], ['ETH-B', ETH], ['COL1-A', COL1]];

beforeAll(async () => {
  maker = await mcdMaker();
  await setDebtCeiling(maker, MDAI(100));
  jest.setTimeout(8000);
});

describe.each(scenarios)('%s', (ilk, GEM) => {
  let cdpType, ratio;

  beforeAll(async () => {
    service = maker.service(CDP_TYPE);
    cdpType = service.getCdpType(GEM, ilk);
    cdpType.reset();
    ratio = createCurrencyRatio(USD, GEM);

    // await setupPriceFeed(maker, ilk, GEM);
    await setLiquidationRatio(maker, ilk, ratio(1.5));
    await setPar(maker, 1.25);

    await setupCollateral(maker, ilk, { price: 10, debtCeiling: 111 });

    for (let i = 0; i < 2; i++) {
      await maker.service(CDP_MANAGER).openLockAndDraw(ilk, GEM(1), 2);
    }
  });

  test('get total collateral', async () => {
    const total = await cdpType.getTotalCollateral();
    expect(total).toEqual(GEM(2));
  });

  test('get total collateral in USD', async () => {
    const collateral = await cdpType.getTotalCollateral(USD);
    expect(collateral.toNumber()).toEqual(USD(20).toNumber());
  });

  test('throw error for invalid collateral type', async () => {
    expect.assertions(1);
    try {
      await cdpType.getTotalCollateral(MKR);
    } catch (err) {
      expect(err.message).toMatch(
        /Don't know how to get total collateral in MKR/
      );
    }
  });

  test('get total debt', async () => {
    const debt = await cdpType.getTotalDebt();
    expect(debt).toEqual(MDAI(4));
  });

  test('get debt ceiling', async () => {
    const ceiling = await cdpType.getDebtCeiling();
    expect(ceiling).toEqual(MDAI(111));
  });

  test('get liquidation ratio', async () => {
    const ratio = await cdpType.getLiquidationRatio();
    expect(ratio.toNumber()).toBe(1.5);
  });

  test('get price', async () => {
    const price = await cdpType.getPrice();
    expect(price.toNumber()).toBe(ratio(10).toNumber());
  });

  test('get liquidation penalty', async () => {
    const amount = BigNumber(1.13).multipliedBy(RAY);
    await setLiquidationPenalty(maker, amount, ilk);
    const penalty = await cdpType.getLiquidationPenalty();
    expect(penalty).toBe(0.13);
  });

  test('get annual stability fee', async () => {
    const amount = BigNumber(1.000000000472114805215157978).multipliedBy(RAY);
    await setStabilityFee(maker, amount, ilk);
    const penalty = await cdpType.getAnnualStabilityFee();
    expect((penalty * 100).toFixed(1)).toBe('1.5');
  });

  test('get price history', async () => {
    const dummyData = [
      {
        val: '177315000000000000000',
        blockNumber: '1'
      }
    ];
    const formattedDummyData = [
      {
        price: GEM(177.315),
        time: new Date(
          1000 * (await cdpType._web3Service.getBlock(1)).timestamp
        )
      }
    ];
    const mockFn = jest.fn(async () => dummyData);
    maker.service(QUERY_API).getPriceHistoryForPip = mockFn;
    const prices = await cdpType.getPriceHistory();
    expect(mockFn).toBeCalled();
    expect(prices).toEqual(formattedDummyData);
  });

  test('get ilk id', () => {
    expect(cdpType.ilk).toBe(ilk);
  });
});
