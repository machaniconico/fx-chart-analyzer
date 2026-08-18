import { describe, expect, it } from 'vitest';
import { generateMql4, generateMql5 } from './mql';
import { SAR_CONVERGENCE_WARMUP_BARS, SAR_MIN_STEP } from './indicators';
import type { EntryCondition, StrategyDefinition } from './strategy';

const fullStrategy: StrategyDefinition = {
  id: 'full-test',
  name: 'FullTestEA',
  direction: 'long',
  entryConditions: [
    {
      type: 'maCross',
      fastType: 'ema',
      fastPeriod: 8,
      slowType: 'sma',
      slowPeriod: 21,
    },
    {
      type: 'rsi',
      period: 14,
      threshold: 30,
      comparison: 'below',
    },
    {
      type: 'bollinger',
      period: 20,
      multiplier: 2,
      mode: 'touch',
      band: 'lower',
    },
    {
      type: 'macdCross',
      fastPeriod: 12,
      slowPeriod: 26,
      signalPeriod: 9,
    },
  ],
  exit: {
    stopLossPips: 25,
    takeProfitPips: 50,
    trailingStopPips: 15,
    closeOnOppositeSignal: true,
  },
  sessionFilter: {
    enabled: true,
    start: '08:00',
    end: '17:30',
    serverUtcOffsetMinutes: 120,
  },
  newsFilter: {
    enabled: true,
    blockMinutes: 45,
  },
  lotSize: 0.2,
  moneyManagement: {
    initialBalanceYen: 1_000_000,
    lotSizingMode: 'fixedLot',
    fixedLot: 0.2,
    riskPercent: 1,
    maxLot: 100,
  },
  magicNumber: 67890,
};

const expectBalanced = (source: string): void => {
  const pairs: Array<[string, string]> = [
    ['(', ')'],
    ['{', '}'],
  ];

  for (const [open, close] of pairs) {
    let depth = 0;
    for (const character of source) {
      if (character === open) {
        depth += 1;
      }
      if (character === close) {
        depth -= 1;
      }
      expect(depth).toBeGreaterThanOrEqual(0);
    }
    expect(depth).toBe(0);
  }
};

const mqlSnapshotPath = (name: string): string => `./__snapshots__/${name}.snap`;

describe('mql generation', () => {
  it('generates a complete MQL5 EA source with matching inputs and core functions', () => {
    const source = generateMql5(fullStrategy);

    expect(source).toContain('#include <Trade/Trade.mqh>');
    expect(source).toContain('Session filter uses broker server time via TimeCurrent()');
    expect(source).toContain('economic calendar data can be unavailable');
    expect(source).toContain('the MQL5 news filter blocks entries while NewsFilterEnable is true');
    expect(source).toContain('CTrade trade;');
    expect(source).toContain('void OnTick()');
    expect(source).toContain('bool IsNewBar()');
    expect(source).toContain('void ManageTrailingStop()');
    expect(source).toContain('input int InpLotSizingMode = 0;');
    expect(source).toContain('input double InpLots = 0.2;');
    expect(source).toContain('input double InpInitialBalance = 1000000;');
    expect(source).toContain('input double InpRiskPercent = 1;');
    expect(source).toContain('input double InpMaxLots = 100;');
    expect(source).toContain('input int InpMagicNumber = 67890;');
    expect(source).toContain('input bool InpSessionFilterEnable = true;');
    expect(source).toContain('input string InpSessionStart = "08:00";');
    expect(source).toContain('input string InpSessionEnd = "17:30";');
    expect(source).toContain('input bool NewsFilterEnable = true;');
    expect(source).toContain('input int NewsBlockMinutes = 45;');
    expect(source).toContain('input int InpStopLossPips = 25;');
    expect(source).toContain('input int InpTakeProfitPips = 50;');
    expect(source).toContain('input int InpTrailingStopPips = 15;');
    expect(source).toContain('input int InpMA1FastPeriod = 8;');
    expect(source).toContain('input ENUM_MA_METHOD InpMA1FastMethod = MODE_EMA;');
    expect(source).toContain('input double InpRSI2Threshold = 30;');
    expect(source).toContain('input double InpBB3Deviation = 2;');
    expect(source).toContain('input int InpMACD4SignalPeriod = 9;');
    expect(source).toContain('int ma1FastHandle = INVALID_HANDLE;');
    expect(source).toContain('int ma1SlowHandle = INVALID_HANDLE;');
    expect(source).toContain('int rsi2Handle = INVALID_HANDLE;');
    expect(source).toContain('int bb3Handle = INVALID_HANDLE;');
    expect(source).toContain('int macd4Handle = INVALID_HANDLE;');
    expect(source).toContain('int OnInit()');
    expect(source).toContain('void OnDeinit(const int reason)');
    expect(source).toContain('double LotSizeForEntry()');
    expect(source).toContain('AccountInfoDouble(ACCOUNT_BALANCE)');
    expect(source).toContain('SYMBOL_TRADE_TICK_VALUE');
    expect(source).toContain('SYMBOL_SPREAD');
    expect(source).toContain('trade.Buy(lots, _Symbol');
    expect(source).toContain('trade.Sell(lots, _Symbol');
    expect(source).toContain('ma1FastHandle = iMA(_Symbol, _Period, InpMA1FastPeriod');
    expect(source).toContain('rsi2Handle = iRSI(_Symbol, _Period, InpRSI2Period');
    expect(source).toContain('bb3Handle = iBands(_Symbol, _Period, InpBB3Period');
    expect(source).toContain('macd4Handle = iMACD(_Symbol, _Period, InpMACD4FastPeriod');
    expect(source).toContain('double previousFast = BufferValue(ma1FastHandle, 0, 2);');
    expect(source).toContain('double current = BufferValue(rsi2Handle, 0, 1);');
    expect(source).toContain('double upper = BufferValue(bb3Handle, 1, 1);');
    expect(source).toContain('double currentSignal = BufferValue(macd4Handle, 1, 1);');
    expect(source).toContain('if(copied <= 0)');
    expect(source).toContain('ReleaseIndicator(ma1FastHandle);');
    expect(source).toContain('bool IsInTradingSession()');
    expect(source).toContain('bool IsHighImpactNewsWindow()');
    expect(source).toContain('CalendarValueHistory(values, fromTime, toTime, NULL, currency)');
    expect(source).toContain('return true;');
    expect(source).toContain('eventInfo.importance == CALENDAR_IMPORTANCE_HIGH');
    expect(source).toContain('EntryFiltersAllow() && EntrySignal(InpTradeLong)');
    expect(source).not.toContain('double MAValue(');
    expect(source).not.toContain('double RSIValue(');
    expect(source).not.toContain('double BandUpper(');
    expect(source).not.toContain('double MACDMain(');
    expect(source).toContain('iMA(_Symbol, _Period');
    expect(source).toContain('iRSI(_Symbol, _Period');
    expect(source).toContain('iBands(_Symbol, _Period');
    expect(source).toContain('iMACD(_Symbol, _Period');
    expectBalanced(source);
  });

  it('generates a complete MQL4 EA source with matching inputs and core functions', () => {
    const source = generateMql4(fullStrategy);

    expect(source).toContain('Session filter uses broker server time via TimeCurrent()');
    expect(source).toContain('void OnTick()');
    expect(source).toContain('bool IsNewBar()');
    expect(source).toContain('int CurrentOrderTicket()');
    expect(source).toContain('void ManageTrailingStop()');
    expect(source).toContain('input int InpLotSizingMode = 0;');
    expect(source).toContain('input double InpLots = 0.2;');
    expect(source).toContain('input double InpInitialBalance = 1000000;');
    expect(source).toContain('input double InpRiskPercent = 1;');
    expect(source).toContain('input double InpMaxLots = 100;');
    expect(source).toContain('input int InpMagicNumber = 67890;');
    expect(source).toContain('input bool InpSessionFilterEnable = true;');
    expect(source).toContain('input string InpSessionStart = "08:00";');
    expect(source).toContain('input string InpSessionEnd = "17:30";');
    expect(source).not.toContain('input bool NewsFilterEnable');
    expect(source).not.toContain('input int NewsBlockMinutes');
    expect(source).toContain('input int InpStopLossPips = 25;');
    expect(source).toContain('input int InpTakeProfitPips = 50;');
    expect(source).toContain('input int InpTrailingStopPips = 15;');
    expect(source).toContain('input int InpMA1FastMethod = MODE_EMA;');
    expect(source).toContain('input double InpRSI2Threshold = 30;');
    expect(source).toContain('input double InpBB3Deviation = 2;');
    expect(source).toContain('input int InpMACD4SignalPeriod = 9;');
    expect(source).toContain('OrderSend(_Symbol, OP_BUY');
    expect(source).toContain('double LotSizeForEntry()');
    expect(source).toContain('AccountBalance()');
    expect(source).toContain('MODE_TICKVALUE');
    expect(source).toContain('MODE_SPREAD');
    expect(source).toContain('OrderSend(_Symbol, OP_BUY, lots');
    expect(source).toContain('OrderSend(_Symbol, OP_SELL, lots');
    expect(source).toContain('OrderSend(_Symbol, OP_SELL');
    expect(source).toContain('bool IsInTradingSession()');
    expect(source).toContain('MQL4 has no built-in economic calendar API');
    expect(source).toContain('EntryFiltersAllow() && EntrySignal(InpTradeLong)');
    expect(source).toContain('iMA(_Symbol, _Period');
    expect(source).toContain('iRSI(_Symbol, _Period');
    expect(source).toContain('iBands(_Symbol, _Period');
    expect(source).toContain('iMACD(_Symbol, _Period');
    expectBalanced(source);
  });

  // __snapshots__/ は生成物ではなく正典(手で消さない)。CI では snapshot 欠落=テスト失敗。
  it('keeps legacy condition generator output byte-stable via file snapshots', async () => {
    const legacyConditions: EntryCondition[] = [
      {
        type: 'maCross',
        fastType: 'ema',
        fastPeriod: 8,
        slowType: 'sma',
        slowPeriod: 21,
      },
      { type: 'rsi', period: 14, threshold: 30, comparison: 'below' },
      { type: 'bollinger', period: 20, multiplier: 2, mode: 'touch', band: 'lower' },
      { type: 'macdCross', fastPeriod: 12, slowPeriod: 26, signalPeriod: 9 },
      {
        type: 'ichimokuCross',
        conversionPeriod: 9,
        basePeriod: 26,
        spanBPeriod: 52,
        displacement: 26,
        requireCloudFilter: true,
      },
      { type: 'donchianBreak', period: 20 },
      {
        type: 'stochastic',
        kPeriod: 14,
        dPeriod: 3,
        smoothing: 3,
        threshold: 20,
        comparison: 'crossBelow',
      },
    ];
    for (const condition of legacyConditions) {
      const strategy: StrategyDefinition = {
        ...fullStrategy,
        id: `legacy-${condition.type}`,
        entryConditions: [condition],
      };
      await expect(generateMql4(strategy)).toMatchFileSnapshot(
        mqlSnapshotPath(`mql-legacy-${condition.type}.mq4`),
      );
      await expect(generateMql5(strategy)).toMatchFileSnapshot(
        mqlSnapshotPath(`mql-legacy-${condition.type}.mq5`),
      );
    }
  });

  it('emits no legacy NULL, 0 indicator arguments in MQL4 for any condition type', () => {
    const allConditions: EntryCondition[] = [
      { type: 'maCross', fastType: 'ema', fastPeriod: 8, slowType: 'sma', slowPeriod: 21 },
      { type: 'rsi', period: 14, threshold: 30, comparison: 'below' },
      { type: 'bollinger', period: 20, multiplier: 2, mode: 'touch', band: 'lower' },
      { type: 'macdCross', fastPeriod: 12, slowPeriod: 26, signalPeriod: 9 },
      {
        type: 'ichimokuCross',
        conversionPeriod: 9,
        basePeriod: 26,
        spanBPeriod: 52,
        displacement: 26,
        requireCloudFilter: true,
      },
      { type: 'donchianBreak', period: 20 },
      { type: 'stochastic', kPeriod: 14, dPeriod: 3, smoothing: 3, threshold: 20, comparison: 'crossBelow' },
      { type: 'stochCross', kPeriod: 14, dPeriod: 3, smoothing: 3 },
      { type: 'keltnerBreak', emaPeriod: 20, atrPeriod: 10, multiplier: 2 },
      { type: 'cciBreak', period: 14, level: 100 },
      { type: 'adxTrend', period: 14, threshold: 25 },
      { type: 'parabolicSar', step: 0.02, maximum: 0.2 },
      { type: 'momentum', period: 14 },
      { type: 'ao', fastPeriod: 5, slowPeriod: 34 },
      { type: 'rvi', period: 10 },
      { type: 'envelope', period: 14, deviation: 0.1 },
      { type: 'demarker', period: 14, threshold: 0.3, comparison: 'below' },
    ];
    for (const condition of allConditions) {
      const source = generateMql4({
        ...fullStrategy,
        id: `null-guard-${condition.type}`,
        entryConditions: [condition],
      });
      expect(source).not.toMatch(/\(NULL, *0\b/);
    }
  });

  it('rejects non-finite generated numeric values before emitting MQL', () => {
    expect(() =>
      generateMql5({
        ...fullStrategy,
        moneyManagement: {
          ...fullStrategy.moneyManagement!,
          fixedLot: Number.NaN,
        },
      }),
    ).toThrow(
      /non-finite value/,
    );
    expect(() =>
      generateMql4({
        ...fullStrategy,
        entryConditions: [
          {
            type: 'bollinger',
            period: 20,
            multiplier: Number.POSITIVE_INFINITY,
            mode: 'touch',
            band: 'upper',
          },
        ],
      }),
    ).toThrow(/non-finite value/);
  });

  it('generates account-balance risk lot sizing for fixed risk mode', () => {
    const strategy: StrategyDefinition = {
      ...fullStrategy,
      moneyManagement: {
        initialBalanceYen: 1_000_000,
        lotSizingMode: 'fixedRisk',
        fixedLot: 0.2,
        riskPercent: 1.5,
        maxLot: 20,
      },
    };

    const mql5 = generateMql5(strategy);
    const mql4 = generateMql4(strategy);

    expect(mql5).toContain('input int InpLotSizingMode = 1;');
    expect(mql5).toContain('input double InpRiskPercent = 1.5;');
    expect(mql5).toContain('input double InpMaxLots = 20;');
    expect(mql5).toContain('double balance = AccountInfoDouble(ACCOUNT_BALANCE);');
    expect(mql5).toContain('double spreadPips = (double)SymbolInfoInteger(_Symbol, SYMBOL_SPREAD) * _Point / PipPoint();');
    expect(mql5).toContain('double riskPips = InpStopLossPips + MathMax(0.0, spreadPips);');
    expect(mql5).toContain('riskAmount / (riskPips * pipValuePerLot)');
    expect(mql4).toContain('input int InpLotSizingMode = 1;');
    expect(mql4).toContain('double balance = AccountBalance();');
    expect(mql4).toContain('double spreadPips = MarketInfo(_Symbol, MODE_SPREAD) * Point / PipPoint();');
    expect(mql4).toContain('riskAmount / (riskPips * pipValuePerLot)');
  });

  it('generates balance-proportional lot sizing for compound mode', () => {
    const strategy: StrategyDefinition = {
      ...fullStrategy,
      moneyManagement: {
        initialBalanceYen: 1_000_000,
        lotSizingMode: 'compound',
        fixedLot: 0.2,
        riskPercent: 1.5,
        maxLot: 100,
      },
    };

    const mql5 = generateMql5(strategy);
    const mql4 = generateMql4(strategy);

    expect(mql5).toContain('input int InpLotSizingMode = 2;');
    expect(mql5).toContain('return NormalizeLots(InpLots * balance / InpInitialBalance);');
    expect(mql4).toContain('input int InpLotSizingMode = 2;');
    expect(mql4).toContain('return NormalizeLots(InpLots * balance / InpInitialBalance);');
  });

  it('generates look-ahead-safe Donchian and mirrored stochastic signals for MQL4 and MQL5', () => {
    const strategy: StrategyDefinition = {
      ...fullStrategy,
      entryConditions: [
        {
          type: 'donchianBreak',
          period: 20,
        },
        {
          type: 'stochastic',
          kPeriod: 14,
          dPeriod: 3,
          smoothing: 3,
          threshold: 20,
          comparison: 'crossBelow',
        },
      ],
    };

    for (const source of [generateMql4(strategy), generateMql5(strategy)]) {
      expect(source).toContain('input int InpDonchian1Period = 20;');
      expect(source).toContain('int period = InpDonchian1Period;');
      expect(source).toContain(
        'Warm-up behavior differs from the TypeScript backtest: TS assumes sufficient history;',
      );
      expect(source).toContain('if(period < 1)');
      expect(source).toContain('period = 1;');
      expect(source).toContain('if(iTime(_Symbol, _Period, period + 1) == 0)');
      expect(source).toContain('iHighest(_Symbol, _Period, MODE_HIGH, period, 2);');
      expect(source).toContain('iLowest(_Symbol, _Period, MODE_LOW, period, 2);');
      expect(source).toContain('return close1 > upper;');
      expect(source).toContain('return close1 < lower;');
      expect(source).toContain('input int InpStoch2KPeriod = 14;');
      expect(source).toContain('input int InpStoch2DPeriod = 3;');
      expect(source).toContain('input int InpStoch2Smoothing = 3;');
      expect(source).toContain('if(range == 0.0)');
      expect(source).toContain('return 50.0;');
      expect(source).toContain('previous > InpStoch2Threshold && current <= InpStoch2Threshold;');
      expect(source).toContain(
        'previous < 100.0 - InpStoch2Threshold && current >= 100.0 - InpStoch2Threshold;',
      );
      expectBalanced(source);
    }
  });

  it('generates self-calculated stochCross %K/%D crosses with exact SMA order and guards', async () => {
    const strategy: StrategyDefinition = {
      ...fullStrategy,
      entryConditions: [{ type: 'stochCross', kPeriod: 14, dPeriod: 3, smoothing: 3 }],
    };

    const mql5 = generateMql5(strategy);
    const mql4 = generateMql4(strategy);

    for (const source of [mql5, mql4]) {
      expect(source).toContain('input int InpStoch1KPeriod = 14;');
      expect(source).toContain('input int InpStoch1DPeriod = 3;');
      expect(source).toContain('input int InpStoch1Smoothing = 3;');
      expect(source).not.toContain('InpStoch1Threshold');
      expect(source).toContain('double StochCrossRawK1(int shift)');
      expect(source).toContain('double StochCrossK1(int shift)');
      expect(source).toContain('double StochCrossD1(int shift)');
      expect(source).toContain('if(range == 0.0)');
      expect(source).toContain('return 50.0;');
      // Both smoothed series must sum oldest-to-newest (largest shift first)
      // to match the TypeScript freshWindowSmaFromNullable operation order.
      expect(source).toContain('for(int offset = smoothing - 1; offset >= 0; offset--)');
      expect(source).toContain('for(int offset = dPeriod - 1; offset >= 0; offset--)');
      expect(source).not.toContain('for(int offset = 0; offset < smoothing; offset++)');
      expect(source).not.toContain('for(int offset = 0; offset < dPeriod; offset++)');
      expect(source).toContain('double previousK = StochCrossK1(signalShift + 1);');
      expect(source).toContain('double previousD = StochCrossD1(signalShift + 1);');
      expect(source).toContain('double currentK = StochCrossK1(signalShift);');
      expect(source).toContain('double currentD = StochCrossD1(signalShift);');
      expect(source).toContain('int currentKRequiredShift = signalShift + kPeriod + smoothing - 2;');
      expect(source).toContain('int previousDRequiredShift = signalShift + 1 + kPeriod + smoothing + dPeriod - 3;');
      expect(source).toContain('requires history through');
      expect(source).toContain('return previousK <= previousD && currentK > currentD;');
      expect(source).toContain('return previousK >= previousD && currentK < currentD;');
      expect(source).not.toContain('iStochastic(');
      expectBalanced(source);
    }

    expect(mql5).toContain(
      'if(InpStoch1KPeriod < 2 || InpStoch1KPeriod > 1000 || InpStoch1DPeriod < 2 || InpStoch1DPeriod > 1000 || InpStoch1Smoothing < 1)',
    );
    expect(mql5).toContain('StochCross1 rejected: K and D periods must be integers between 2 and 1000');
    expect(mql5).toContain('return INIT_FAILED;');
    expect(mql4).toContain('int OnInit()');
    expect(mql4).toContain(
      'if(InpStoch1KPeriod < 2 || InpStoch1KPeriod > 1000 || InpStoch1DPeriod < 2 || InpStoch1DPeriod > 1000 || InpStoch1Smoothing < 1)',
    );
    expect(mql4).toContain('StochCross1 rejected: K and D periods must be integers between 2 and 1000');
    expect(mql4).toContain('return INIT_FAILED;');

    await expect(mql4).toMatchFileSnapshot(mqlSnapshotPath('mql-stochCross.mq4'));
    await expect(mql5).toMatchFileSnapshot(mqlSnapshotPath('mql-stochCross.mq5'));
  });

  it('generates shift-1 Keltner breakout signals with platform indicator guards', async () => {
    const strategy: StrategyDefinition = {
      ...fullStrategy,
      entryConditions: [
        {
          type: 'keltnerBreak',
          emaPeriod: 20,
          atrPeriod: 10,
          multiplier: 2.0,
        },
      ],
    };

    const mql5 = generateMql5(strategy);
    const mql4 = generateMql4(strategy);

    expect(mql5).toContain('input int InpKeltner1EmaPeriod = 20;');
    expect(mql5).toContain('input int InpKeltner1AtrPeriod = 10;');
    expect(mql5).toContain('input double InpKeltner1Multiplier = 2;');
    expect(mql5).toContain('int keltner1EmaHandle = INVALID_HANDLE;');
    expect(mql5).toContain('int keltner1AtrHandle = INVALID_HANDLE;');
    expect(mql5).toContain(
      'keltner1EmaHandle = iMA(_Symbol, _Period, InpKeltner1EmaPeriod, 0, MODE_EMA, PRICE_CLOSE);',
    );
    expect(mql5).toContain('keltner1AtrHandle = iATR(_Symbol, _Period, InpKeltner1AtrPeriod);');
    expect(mql5).toContain('if(iTime(_Symbol, _Period, requiredPeriod + 1) == 0)');
    expect(mql5).toContain('double middle = BufferValue(keltner1EmaHandle, 0, 1);');
    expect(mql5).toContain('double atrValue = BufferValue(keltner1AtrHandle, 0, 1);');
    expect(mql5).toContain('double close1 = iClose(_Symbol, _Period, 1);');
    expect(mql5).toContain('return close1 >= upper;');
    expect(mql5).toContain('return close1 <= lower;');
    expect(mql5).toContain('EMA warm-up note');
    expect(mql5).toContain('ReleaseIndicator(keltner1EmaHandle);');
    expect(mql5).toContain('ReleaseIndicator(keltner1AtrHandle);');

    expect(mql4).toContain('input int InpKeltner1EmaPeriod = 20;');
    expect(mql4).toContain('input int InpKeltner1AtrPeriod = 10;');
    expect(mql4).toContain('input double InpKeltner1Multiplier = 2;');
    expect(mql4).toContain(
      'double middle = iMA(_Symbol, _Period, InpKeltner1EmaPeriod, 0, MODE_EMA, PRICE_CLOSE, 1);',
    );
    expect(mql4).toContain('double atrValue = iATR(_Symbol, _Period, InpKeltner1AtrPeriod, 1);');
    expect(mql4).toContain('if(iTime(_Symbol, _Period, requiredPeriod + 1) == 0)');
    expect(mql4).toContain('double close1 = iClose(_Symbol, _Period, 1);');
    expect(mql4).toContain('return close1 >= upper;');
    expect(mql4).toContain('return close1 <= lower;');
    expect(mql4).toContain('EMA warm-up note');
    expect(mql5).toContain('if(atrValue <= 0.0)');
    expect(mql4).toContain('if(atrValue <= 0.0)');
    await expect(mql5).toMatchFileSnapshot(mqlSnapshotPath('mql-keltner.mq5'));
    await expect(mql4).toMatchFileSnapshot(mqlSnapshotPath('mql-keltner.mq4'));
    expectBalanced(mql5);
    expectBalanced(mql4);
  });

  it('generates inclusive, fail-closed CCI break signals for MQL4 and MQL5', async () => {
    const strategy: StrategyDefinition = {
      ...fullStrategy,
      entryConditions: [{ type: 'cciBreak', period: 14, level: 100 }],
    };

    const mql5 = generateMql5(strategy);
    const mql4 = generateMql4(strategy);

    expect(mql5).toContain('input int InpCCI1Period = 14;');
    expect(mql5).toContain('input double InpCCI1Level = 100;');
    expect(mql5).toContain('int cci1Handle = INVALID_HANDLE;');
    expect(mql5).toContain('int cci1Period = InpCCI1Period;');
    expect(mql5).toContain('cci1Handle = iCCI(_Symbol, _Period, cci1Period, PRICE_TYPICAL);');
    expect(mql5).toContain('double current = BufferValue(cci1Handle, 0, 1);');
    expect(mql5).toContain('return current >= level;');
    expect(mql5).toContain('return current <= -level;');
    expect(mql5).toContain('zero-mean-deviation result is intentionally represented as 0.0');
    expect(mql5).toContain('if(!(level > 0.0))');
    expect(mql5).toContain('ReleaseIndicator(cci1Handle);');
    expect(mql5).toContain('CopyBuffer(handle, bufferIndex, shift, 1, values);');

    expect(mql4).toContain('input int InpCCI1Period = 14;');
    expect(mql4).toContain('input double InpCCI1Level = 100;');
    expect(mql4).toContain('double current = iCCI(_Symbol, _Period, period, PRICE_TYPICAL, 1);');
    expect(mql4).toContain('return current >= level;');
    expect(mql4).toContain('return current <= -level;');
    expectBalanced(mql5);
    expectBalanced(mql4);
    await expect(mql5).toMatchFileSnapshot(mqlSnapshotPath('mql-cciBreak.mq5'));
    await expect(mql4).toMatchFileSnapshot(mqlSnapshotPath('mql-cciBreak.mq4'));
  });

  it('generates native iADX DI crosses with an inclusive ADX filter and warm-up guard', async () => {
    const strategy: StrategyDefinition = {
      ...fullStrategy,
      entryConditions: [{ type: 'adxTrend', period: 14, threshold: 25 }],
    };

    const mql5 = generateMql5(strategy);
    const mql4 = generateMql4(strategy);

    expect(mql5).toContain('input int InpADX1Period = 14;');
    expect(mql5).toContain('input double InpADX1Threshold = 25;');
    expect(mql5).toContain('int adx1Handle = INVALID_HANDLE;');
    expect(mql5).toContain('int adx1Period = InpADX1Period;');
    expect(mql5).toContain('adx1Handle = iADX(_Symbol, _Period, adx1Period);');
    expect(mql5).toContain('double previousPlusDi = BufferValue(adx1Handle, PLUSDI_LINE, 2);');
    expect(mql5).toContain('double previousMinusDi = BufferValue(adx1Handle, MINUSDI_LINE, 2);');
    expect(mql5).toContain('double previousAdx = BufferValue(adx1Handle, MAIN_LINE, 2);');
    expect(mql5).toContain('double currentPlusDi = BufferValue(adx1Handle, PLUSDI_LINE, 1);');
    expect(mql5).toContain('double currentMinusDi = BufferValue(adx1Handle, MINUSDI_LINE, 1);');
    expect(mql5).toContain('double currentAdx = BufferValue(adx1Handle, MAIN_LINE, 1);');
    expect(mql5).toContain('if(iTime(_Symbol, _Period, period * 2 + 1) == 0)');
    expect(mql5).toContain('if(!(threshold > 0.0) || !(threshold < 100.0))');
    expect(mql5).toContain('CrossedAbove(previousPlusDi, previousMinusDi, currentPlusDi, currentMinusDi)');
    expect(mql5).toContain('CrossedBelow(previousPlusDi, previousMinusDi, currentPlusDi, currentMinusDi)');
    expect(mql5).toContain('ReleaseIndicator(adx1Handle);');
    expect(mql5).not.toContain('iADX(NULL, 0');

    expect(mql4).toContain('input int InpADX1Period = 14;');
    expect(mql4).toContain('input double InpADX1Threshold = 25;');
    expect(mql4).toContain('double previousPlusDi = iADX(_Symbol, _Period, period, PRICE_CLOSE, MODE_PLUSDI, 2);');
    expect(mql4).toContain('double previousMinusDi = iADX(_Symbol, _Period, period, PRICE_CLOSE, MODE_MINUSDI, 2);');
    expect(mql4).toContain('double previousAdx = iADX(_Symbol, _Period, period, PRICE_CLOSE, MODE_MAIN, 2);');
    expect(mql4).toContain('double currentPlusDi = iADX(_Symbol, _Period, period, PRICE_CLOSE, MODE_PLUSDI, 1);');
    expect(mql4).toContain('double currentMinusDi = iADX(_Symbol, _Period, period, PRICE_CLOSE, MODE_MINUSDI, 1);');
    expect(mql4).toContain('double currentAdx = iADX(_Symbol, _Period, period, PRICE_CLOSE, MODE_MAIN, 1);');
    expect(mql4).toContain('if(iTime(_Symbol, _Period, period * 2 + 1) == 0)');
    expect(mql4).toContain('if(!(threshold > 0.0) || !(threshold < 100.0))');
    expect(mql4).toContain('CrossedAbove(previousPlusDi, previousMinusDi, currentPlusDi, currentMinusDi)');
    expect(mql4).toContain('CrossedBelow(previousPlusDi, previousMinusDi, currentPlusDi, currentMinusDi)');
    expect(mql4).not.toContain('iADX(NULL, 0');

    expectBalanced(mql5);
    expectBalanced(mql4);
    await expect(mql5).toMatchFileSnapshot(mqlSnapshotPath('mql-adxTrend.mq5'));
    await expect(mql4).toMatchFileSnapshot(mqlSnapshotPath('mql-adxTrend.mq4'));
  });

  it('generates native iSAR flips with evaluator direction parity, guards, and warm-up', async () => {
    const strategy: StrategyDefinition = {
      ...fullStrategy,
      entryConditions: [{ type: 'parabolicSar', step: 0.02, maximum: 0.2 }],
    };

    const mql5 = generateMql5(strategy);
    const mql4 = generateMql4(strategy);

    expect(mql5).toContain('input double InpSAR1Step = 0.02;');
    expect(mql5).toContain('input double InpSAR1Maximum = 0.2;');
    expect(mql5).toContain('int sar1Handle = INVALID_HANDLE;');
    expect(mql5).toContain('sar1Handle = iSAR(_Symbol, _Period, InpSAR1Step, InpSAR1Maximum);');
    expect(mql5).toContain('double previousSar = BufferValue(sar1Handle, 0, 2);');
    expect(mql5).toContain('double currentSar = BufferValue(sar1Handle, 0, 1);');
    expect(mql5).toContain('bool previousIsLong = SarDirectionIsLong1(previousSar, previousHigh, previousLow);');
    expect(mql5).toContain('bool currentIsLong = SarDirectionIsLong1(currentSar, currentHigh, currentLow);');
    expect(mql5).toContain('return sar < high;');
    expect(mql5).toContain('static datetime cachedBarTime = 0;');
    expect(mql5).toContain('static int cachedSignalShift = -1;');
    expect(mql5).toContain('cachedBarTime == currentBarTime');
    expect(mql5).toContain('cachedBarTime == currentBarTime && cachedSignalShift == signalShift');
    expect(mql5).toContain('cachedSignalShift = signalShift;');
    expect(mql5).toContain('for(int shift = totalBars - 1; shift >= signalShift + 1; shift--)');
    expect(mql5).toContain('if(reversalCount >= 2)');
    expect(mql5).toContain('sar > 0.0 && high > 0.0 && low > 0.0');
    expect(mql5).toContain('if(reversalCount < 2 || firstReversalShift < 0)');
    expect(mql5).toContain(
      `cachedResult = firstReversalShift - (signalShift + 1) >= ${SAR_CONVERGENCE_WARMUP_BARS};`,
    );
    expect(mql5).toContain('MathIsValidNumber(InpSAR1Step)');
    expect(mql5).toContain('InpSAR1Maximum < InpSAR1Step');
    expect(mql5).toContain(`InpSAR1Step < ${SAR_MIN_STEP}`);
    expect(mql5).toContain(`SAR1 warning: step below ${SAR_MIN_STEP}`);
    expect(mql5).toContain('ReleaseIndicator(sar1Handle);');
    expect(mql5).not.toContain('iSAR(NULL, 0');

    expect(mql4).toContain('input double InpSAR1Step = 0.02;');
    expect(mql4).toContain('input double InpSAR1Maximum = 0.2;');
    expect(mql4).toContain('double previousSar = iSAR(_Symbol, _Period, step, maximum, 2);');
    expect(mql4).toContain('double currentSar = iSAR(_Symbol, _Period, step, maximum, 1);');
    expect(mql4).toContain('double sar = iSAR(_Symbol, _Period, step, maximum, shift);');
    expect(mql4).toContain('bool previousIsLong = SarDirectionIsLong1(previousSar, previousHigh, previousLow);');
    expect(mql4).toContain('bool currentIsLong = SarDirectionIsLong1(currentSar, currentHigh, currentLow);');
    expect(mql4).toContain('return sar < high;');
    expect(mql4).toContain('static datetime cachedBarTime = 0;');
    expect(mql4).toContain('static int cachedSignalShift = -1;');
    expect(mql4).toContain('cachedBarTime == currentBarTime');
    expect(mql4).toContain('cachedBarTime == currentBarTime && cachedSignalShift == signalShift');
    expect(mql4).toContain('cachedSignalShift = signalShift;');
    expect(mql4).toContain('for(int shift = totalBars - 1; shift >= signalShift + 1; shift--)');
    expect(mql4).toContain('if(reversalCount >= 2)');
    expect(mql4).toContain('sar > 0.0 && high > 0.0 && low > 0.0');
    expect(mql4).toContain('if(reversalCount < 2 || firstReversalShift < 0)');
    expect(mql4).toContain(
      `cachedResult = firstReversalShift - (signalShift + 1) >= ${SAR_CONVERGENCE_WARMUP_BARS};`,
    );
    expect(mql4).toContain('MathIsValidNumber(step)');
    expect(mql4).toContain('maximum < step');
    expect(mql4).toContain('int OnInit()');
    expect(mql4).toContain(`InpSAR1Step < ${SAR_MIN_STEP}`);
    expect(mql4).toContain(`SAR1 warning: step below ${SAR_MIN_STEP}`);
    expect(mql4).toContain(
      'if(!MathIsValidNumber(InpSAR1Step) || !MathIsValidNumber(InpSAR1Maximum) || InpSAR1Step <= 0.0 || InpSAR1Maximum < InpSAR1Step)',
    );
    expect(mql4).toContain('SAR1 rejected: step must be > 0 and maximum must be >= step');
    expect(mql4).toContain('return INIT_FAILED;');
    expect(mql4).not.toContain('iSAR(NULL, 0');

    expectBalanced(mql5);
    expectBalanced(mql4);
    // Snapshot changes are intentionally limited to the signalShift cache key
    // in both outputs and the MQL4 hard-domain INIT_FAILED mirror.
    await expect(mql5).toMatchFileSnapshot(mqlSnapshotPath('mql-parabolicSar.mq5'));
    await expect(mql4).toMatchFileSnapshot(mqlSnapshotPath('mql-parabolicSar.mq4'));
  });

  it('generates iClose-computed Momentum 100 crosses with exact TS parity guards', async () => {
    const strategy: StrategyDefinition = {
      ...fullStrategy,
      entryConditions: [{ type: 'momentum', period: 14 }],
    };

    const mql5 = generateMql5(strategy);
    const mql4 = generateMql4(strategy);

    for (const source of [mql5, mql4]) {
      expect(source).toContain('input int InpMomentum1Period = 14;');
      expect(source).toContain('double close = iClose(_Symbol, _Period, shift);');
      expect(source).toContain('double previousClose = iClose(_Symbol, _Period, shift + period);');
      expect(source).toContain('double value = (close / previousClose) * 100.0;');
      expect(source).toContain('if(iTime(_Symbol, _Period, period + 1) == 0)');
      expect(source).toContain('if(iTime(_Symbol, _Period, period + 2) == 0)');
      expect(source).toContain('if(!(previous > 0.0 && current > 0.0))');
      expect(source).toContain('return previous <= 100.0 && current > 100.0;');
      expect(source).toContain('return previous >= 100.0 && current < 100.0;');
      expect(source).toContain('native iMomentum buffer is intentionally not used');
      expect(source).toContain('iClose can return 0.0');
      expect(source).not.toContain('iMomentum(_Symbol');
      expect(source).not.toContain('momentum1Handle');
      expectBalanced(source);
    }

    expect(mql5).toContain('if(InpMomentum1Period < 1)');
    expect(mql5).toContain('Momentum1 rejected: period must be an integer greater than or equal to 1');
    expect(mql5).toContain('return INIT_FAILED;');
    expect(mql4).toContain('int OnInit()');
    expect(mql4).toContain('if(InpMomentum1Period < 1)');
    expect(mql4).toContain('Momentum1 rejected: period must be an integer greater than or equal to 1');
    expect(mql4).toContain('return INIT_FAILED;');

    await expect(mql5).toMatchFileSnapshot(mqlSnapshotPath('mql-momentum.mq5'));
    await expect(mql4).toMatchFileSnapshot(mqlSnapshotPath('mql-momentum.mq4'));
  });

  it('generates self-calculated AO zero-line crosses with exact TS median/SMA order', async () => {
    const strategy: StrategyDefinition = {
      ...fullStrategy,
      entryConditions: [{ type: 'ao', fastPeriod: 5, slowPeriod: 34 }],
    };

    const mql5 = generateMql5(strategy);
    const mql4 = generateMql4(strategy);

    for (const source of [mql5, mql4]) {
      expect(source).toContain('input int InpAO1FastPeriod = 5;');
      expect(source).toContain('input int InpAO1SlowPeriod = 34;');
      expect(source).toContain('double high = iHigh(_Symbol, _Period, shift);');
      expect(source).toContain('double low = iLow(_Symbol, _Period, shift);');
      expect(source).toContain('double value = (high + low) / 2.0;');
      expect(source).toContain('double fastSma = AoSma1(shift, fastPeriod);');
      expect(source).toContain('double slowSma = AoSma1(shift, slowPeriod);');
      expect(source).toContain('double value = fastSma - slowSma;');
      expect(source).toContain('if(iTime(_Symbol, _Period, shift + slowPeriod - 1) == 0)');
      expect(source).toContain('int signalShift = 1;');
      expect(source).toContain('if(iTime(_Symbol, _Period, slowPeriod + signalShift) == 0)');
      expect(source).toContain('double previous = AoValue1(signalShift + 1);');
      expect(source).toContain('double current = AoValue1(signalShift);');
      expect(source).toContain('if(!ValueReady(previous) || !MathIsValidNumber(previous) ||');
      expect(source).toContain('return previous <= 0.0 && current > 0.0;');
      expect(source).toContain('return previous >= 0.0 && current < 0.0;');
      expect(source).toContain('native iAO buffer is intentionally not used');
      expect(source).not.toContain('iAO(');
      expect(source).not.toContain('ao1Handle');
      expectBalanced(source);
    }

    expect(mql5).toContain('if(InpAO1FastPeriod < 1 || InpAO1SlowPeriod < 1 || InpAO1FastPeriod >= InpAO1SlowPeriod)');
    expect(mql5).toContain('AO1 rejected: periods must be integers greater than or equal to 1');
    expect(mql5).toContain('return INIT_FAILED;');
    expect(mql4).toContain('int OnInit()');
    expect(mql4).toContain('if(InpAO1FastPeriod < 1 || InpAO1SlowPeriod < 1 || InpAO1FastPeriod >= InpAO1SlowPeriod)');
    expect(mql4).toContain('AO1 rejected: periods must be integers greater than or equal to 1');
    expect(mql4).toContain('return INIT_FAILED;');

    await expect(mql5).toMatchFileSnapshot(mqlSnapshotPath('mql-ao.mq5'));
    await expect(mql4).toMatchFileSnapshot(mqlSnapshotPath('mql-ao.mq4'));
  });

  it('generates self-calculated Envelope crosses with exact TS SMA/band order and guards', async () => {
    const strategy: StrategyDefinition = {
      ...fullStrategy,
      entryConditions: [{ type: 'envelope', period: 14, deviation: 0.1 }],
    };

    const mql5 = generateMql5(strategy);
    const mql4 = generateMql4(strategy);

    for (const source of [mql5, mql4]) {
      expect(source).toContain('input int InpEnvelope1Period = 14;');
      expect(source).toContain('input double InpEnvelope1Deviation = 0.1;');
      expect(source).toContain('double close = iClose(_Symbol, _Period, shift + offset);');
      expect(source).toContain('double value = sum / period;');
      expect(source).toContain('double value = middle * (1.0 + deviation / 100.0);');
      expect(source).toContain('double value = middle * (1.0 - deviation / 100.0);');
      expect(source).toContain('if(iTime(_Symbol, _Period, period + signalShift) == 0)');
      expect(source).toContain('if(iTime(_Symbol, _Period, period + signalShift + 1) == 0)');
      expect(source).toContain('requires history through');
      expect(source).toContain('previousClose <= previousUpper && currentClose > currentUpper');
      expect(source).toContain('previousClose >= previousLower && currentClose < currentLower');
      expect(source).toContain('native iEnvelopes buffer is intentionally not used');
      expect(source).toContain('https://www.mql5.com/en/code/28');
      expect(source).not.toContain('iEnvelopes(');
      expectBalanced(source);
    }

    expect(mql5).toContain(
      'if(period < 2 || period > 1000 || !MathIsValidNumber(deviation) || !(deviation > 0.0))',
    );
    expect(mql5).toContain('InpEnvelope1Deviation');
    expect(mql5).toContain('return false;');
    expect(mql4).toContain('int OnInit()');
    expect(mql4).toContain('if(InpEnvelope1Period < 2 || InpEnvelope1Period > 1000');
    expect(mql4).toContain('InpEnvelope1Deviation');
    expect(mql4).toContain('return INIT_FAILED;');

    await expect(mql5).toMatchFileSnapshot(mqlSnapshotPath('mql-envelope.mq5'));
    await expect(mql4).toMatchFileSnapshot(mqlSnapshotPath('mql-envelope.mq4'));
  });

  it('generates self-calculated RVI signal-line crosses with exact TS arithmetic and guards', async () => {
    const strategy: StrategyDefinition = {
      ...fullStrategy,
      entryConditions: [{ type: 'rvi', period: 10 }],
    };

    const mql5 = generateMql5(strategy);
    const mql4 = generateMql4(strategy);

    for (const source of [mql5, mql4]) {
      expect(source).toContain('input int InpRVI1Period = 10;');
      expect(source).toContain('double open0 = iOpen(_Symbol, _Period, shift);');
      expect(source).toContain('double high0 = iHigh(_Symbol, _Period, shift);');
      expect(source).toContain('double low0 = iLow(_Symbol, _Period, shift);');
      expect(source).toContain('double close0 = iClose(_Symbol, _Period, shift);');
      expect(source).toContain('bool RviBarsReady1(int shift)');
      expect(source).toContain('if(!RviBarsReady1(shift))');
      expect(source).toContain('return ((close0 - open0) +');
      expect(source).toContain('2 * (close1 - open1)');
      expect(source).toContain('2 * (high2 - low2)');
      expect(source).toContain('double numeratorAverage = RviNumeratorSwma1(shift + offset);');
      expect(source).toContain('double rangeAverage = RviRangeSwma1(shift + offset);');
      expect(source).toContain('for(int offset = period - 1; offset >= 0; offset--)');
      expect(source).toContain('double value = numeratorSum / rangeSum;');
      expect(source).toContain('rangeSum == 0.0');
      expect(source).toContain('double value = (current + 2 * previous + 2 * twoBarsAgo + threeBarsAgo) / 6.0;');
      expect(source).toContain('if(iTime(_Symbol, _Period, period + 6 + signalShift) == 0)');
      expect(source).toContain('if(iTime(_Symbol, _Period, period + 7 + signalShift) == 0)');
      expect(source).toContain('shift + period + 6');
      expect(source).toContain(
        `if(!ValueReady(open0) || !MathIsValidNumber(open0) || !ValueReady(high0) || !MathIsValidNumber(high0) ||
    !ValueReady(low0) || !MathIsValidNumber(low0) || !ValueReady(close0) || !MathIsValidNumber(close0) ||
    !ValueReady(open1) || !MathIsValidNumber(open1) || !ValueReady(high1) || !MathIsValidNumber(high1) ||
    !ValueReady(low1) || !MathIsValidNumber(low1) || !ValueReady(close1) || !MathIsValidNumber(close1) ||
    !ValueReady(open2) || !MathIsValidNumber(open2) || !ValueReady(high2) || !MathIsValidNumber(high2) ||
    !ValueReady(low2) || !MathIsValidNumber(low2) || !ValueReady(close2) || !MathIsValidNumber(close2) ||
    !ValueReady(open3) || !MathIsValidNumber(open3) || !ValueReady(high3) || !MathIsValidNumber(high3) ||
    !ValueReady(low3) || !MathIsValidNumber(low3) || !ValueReady(close3) || !MathIsValidNumber(close3) ||
    !(open0 > 0.0 && high0 > 0.0 && low0 > 0.0 && close0 > 0.0 &&
      open1 > 0.0 && high1 > 0.0 && low1 > 0.0 && close1 > 0.0 &&
      open2 > 0.0 && high2 > 0.0 && low2 > 0.0 && close2 > 0.0 &&
      open3 > 0.0 && high3 > 0.0 && low3 > 0.0 && close3 > 0.0))`,
      );
      expect(source).toContain(`double RviNumeratorSwma1(int shift)
{
  if(!RviBarsReady1(shift))
  {
    return EMPTY_VALUE;
  }
  double open0 = iOpen(_Symbol, _Period, shift);
  double close0 = iClose(_Symbol, _Period, shift);
  double open1 = iOpen(_Symbol, _Period, shift + 1);
  double close1 = iClose(_Symbol, _Period, shift + 1);
  double open2 = iOpen(_Symbol, _Period, shift + 2);
  double close2 = iClose(_Symbol, _Period, shift + 2);
  double open3 = iOpen(_Symbol, _Period, shift + 3);
  double close3 = iClose(_Symbol, _Period, shift + 3);`);
      expect(source).toContain(`double RviRangeSwma1(int shift)
{
  if(!RviBarsReady1(shift))
  {
    return EMPTY_VALUE;
  }
  double high0 = iHigh(_Symbol, _Period, shift);
  double low0 = iLow(_Symbol, _Period, shift);
  double high1 = iHigh(_Symbol, _Period, shift + 1);
  double low1 = iLow(_Symbol, _Period, shift + 1);
  double high2 = iHigh(_Symbol, _Period, shift + 2);
  double low2 = iLow(_Symbol, _Period, shift + 2);
  double high3 = iHigh(_Symbol, _Period, shift + 3);
  double low3 = iLow(_Symbol, _Period, shift + 3);`);
      for (const functionName of ['RviNumeratorSwma1', 'RviRangeSwma1']) {
        const functionStart = source.indexOf(`double ${functionName}(int shift)`);
        const guardPosition = source.indexOf('if(!RviBarsReady1(shift))', functionStart);
        const firstTerminalReadPosition = source.indexOf(' = i', functionStart);
        expect(functionStart).toBeGreaterThanOrEqual(0);
        expect(guardPosition).toBeGreaterThan(functionStart);
        expect(firstTerminalReadPosition).toBeGreaterThan(guardPosition);
      }
      expect(source).toContain(
        'CrossedAbove(previousRvi, previousSignal, currentRvi, currentSignal)',
      );
      expect(source).toContain(
        'CrossedBelow(previousRvi, previousSignal, currentRvi, currentSignal)',
      );
      expect(source).toContain('native iRVI buffer is intentionally not used');
      expect(source).not.toContain('iRVI(');
      expect(source).not.toContain('rvi1Handle');
      expectBalanced(source);
    }

    expect(mql5).toContain('if(InpRVI1Period < 1)');
    expect(mql5).toContain('RVI1 rejected: period must be an integer greater than or equal to 1');
    expect(mql5).toContain('return INIT_FAILED;');
    expect(mql4).toContain('int OnInit()');
    expect(mql4).toContain('if(InpRVI1Period < 1)');
    expect(mql4).toContain('RVI1 rejected: period must be an integer greater than or equal to 1');
    expect(mql4).toContain('return INIT_FAILED;');

    await expect(mql5).toMatchFileSnapshot(mqlSnapshotPath('mql-rvi.mq5'));
    await expect(mql4).toMatchFileSnapshot(mqlSnapshotPath('mql-rvi.mq4'));
  });

  it('generates self-calculated DeMarker threshold signals with exact TS arithmetic and guards', async () => {
    const strategy: StrategyDefinition = {
      ...fullStrategy,
      entryConditions: [{ type: 'demarker', period: 14, threshold: 0.3, comparison: 'crossBelow' }],
    };

    const mql5 = generateMql5(strategy);
    const mql4 = generateMql4(strategy);

    for (const source of [mql5, mql4]) {
      expect(source).toContain('input int InpDeMarker1Period = 14;');
      expect(source).toContain('input double InpDeMarker1Threshold = 0.3;');
      expect(source).toContain('double high = iHigh(_Symbol, _Period, shift);');
      expect(source).toContain('double previousHigh = iHigh(_Symbol, _Period, shift + 1);');
      expect(source).toContain('double low = iLow(_Symbol, _Period, shift);');
      expect(source).toContain('double previousLow = iLow(_Symbol, _Period, shift + 1);');
      expect(source).toContain('double value = high > previousHigh ? high - previousHigh : 0.0;');
      expect(source).toContain('double value = low < previousLow ? previousLow - low : 0.0;');
      expect(source).toContain('double deMaxSma = deMaxSum / period;');
      expect(source).toContain('double deMinSma = deMinSum / period;');
      expect(source).toContain('double denominator = deMaxSma + deMinSma;');
      expect(source).toContain('denominator == 0.0');
      expect(source).toContain('for(int offset = period - 1; offset >= 0; offset--)');
      expect(source).toContain('if(iTime(_Symbol, _Period, period + 1) == 0)');
      expect(source).not.toContain('if(iTime(_Symbol, _Period, period + 2) == 0)');
      expect(source).toContain('if(!ValueReady(current) || !MathIsValidNumber(current))');
      const conditionStart = source.indexOf('bool Condition1(bool longSide)');
      expect(conditionStart).toBeGreaterThanOrEqual(0);
      const conditionEnd = source.indexOf('\n}', conditionStart);
      // 論理的には次の toBeGreaterThan で落ちるが、-1 防御の明示を要求した受け入れ基準の意思表示なので冗長でも削除しない。
      expect(conditionEnd).not.toBe(-1);
      expect(conditionEnd).toBeGreaterThan(conditionStart);
      const conditionSource = source.slice(conditionStart, conditionEnd);
      const previousReadyLines = conditionSource
        .split('\n')
        .filter((line) => line.includes('ValueReady(previous)'));
      expect(previousReadyLines).toHaveLength(2);
      expect(
        previousReadyLines.every((line) =>
          line.trimStart().startsWith('return ValueReady(previous) && '),
        ),
      ).toBe(true);
      expect(previousReadyLines.map((line) => line.trim())).toEqual([
        'return ValueReady(previous) && previous > InpDeMarker1Threshold && current <= InpDeMarker1Threshold;',
        'return ValueReady(previous) && previous < 1.0 - InpDeMarker1Threshold && current >= 1.0 - InpDeMarker1Threshold;',
      ]);
      expect(source).toContain('1.0 - InpDeMarker1Threshold');
      expect(source).toContain('native iDeMarker buffer is intentionally not used');
      expect(source).toContain('return EMPTY_VALUE;');
      expect(source).not.toContain('iDeMarker(');
      expectBalanced(source);
    }

    expect(mql5).toContain('DeMarker1 rejected: period must be an integer greater than or equal to 1');
    expect(mql5).toContain('return INIT_FAILED;');
    expect(mql4).toContain('int OnInit()');
    expect(mql4).toContain('DeMarker1 rejected: period must be an integer greater than or equal to 1');
    expect(mql4).toContain('return INIT_FAILED;');

    await expect(mql5).toMatchFileSnapshot(mqlSnapshotPath('mql-demarker.mq5'));
    await expect(mql4).toMatchFileSnapshot(mqlSnapshotPath('mql-demarker.mq4'));
  });

  it('generates Ichimoku cross signals with shift parity and mirrored cloud rules for MQL4 and MQL5', () => {
    const strategy: StrategyDefinition = {
      ...fullStrategy,
      entryConditions: [
        {
          type: 'ichimokuCross',
          conversionPeriod: 9,
          basePeriod: 26,
          spanBPeriod: 52,
          displacement: 26,
          requireCloudFilter: true,
        },
      ],
    };

    const mql5 = generateMql5(strategy);
    const mql4 = generateMql4(strategy);

    expect(mql5).toContain('input int InpIchimoku1ConversionPeriod = 9;');
    expect(mql5).toContain('input int InpIchimoku1BasePeriod = 26;');
    expect(mql5).toContain('input int InpIchimoku1SpanBPeriod = 52;');
    expect(mql5).toContain('input int InpIchimoku1Displacement = 26;');
    expect(mql5).toContain('input bool InpIchimoku1RequireCloudFilter = true;');
    expect(mql5).toContain('int ichimoku1Handle = INVALID_HANDLE;');
    expect(mql5).toContain(
      'ichimoku1Handle = iIchimoku(_Symbol, _Period, InpIchimoku1ConversionPeriod, InpIchimoku1BasePeriod, InpIchimoku1SpanBPeriod);',
    );
    expect(mql5).toContain('double previousConversion = BufferValue(ichimoku1Handle, 0, 2);');
    expect(mql5).toContain('double currentConversion = BufferValue(ichimoku1Handle, 0, 1);');
    expect(mql5).toContain('int requiredPeriod = InpIchimoku1ConversionPeriod;');
    expect(mql5).toContain('if(iTime(_Symbol, _Period, requiredPeriod + 1) == 0)');
    expect(mql5).toContain('double spanA = BufferValue(ichimoku1Handle, 2, 1);');
    expect(mql5).toContain('double spanB = BufferValue(ichimoku1Handle, 3, 1);');
    expect(mql5).toContain('CrossedAbove(previousConversion, previousBase, currentConversion, currentBase)');
    expect(mql5).toContain('CrossedBelow(previousConversion, previousBase, currentConversion, currentBase)');
    expect(mql5).toContain('close1 > MathMax(spanA, spanB)');
    expect(mql5).toContain('close1 < MathMin(spanA, spanB)');
    expect(mql5).toContain('MT4/MT5 SENKOUSPAN buffers');
    expect(mql5).not.toContain('WARNING: Ichimoku displacement');
    expect(mql5).toContain('ReleaseIndicator(ichimoku1Handle);');
    // 雲フィルタ経路の履歴ガード: 雲値は変位済みなので spanBPeriod + displacement 本を要求する
    expect(mql5).toContain(
      'if(iTime(_Symbol, _Period, InpIchimoku1SpanBPeriod + InpIchimoku1Displacement) == 0)',
    );

    expect(mql4).toContain(
      'double previousConversion = iIchimoku(_Symbol, _Period, InpIchimoku1ConversionPeriod, InpIchimoku1BasePeriod, InpIchimoku1SpanBPeriod, MODE_TENKANSEN, 2);',
    );
    expect(mql4).toContain(
      'double currentConversion = iIchimoku(_Symbol, _Period, InpIchimoku1ConversionPeriod, InpIchimoku1BasePeriod, InpIchimoku1SpanBPeriod, MODE_TENKANSEN, 1);',
    );
    expect(mql4).toContain('int requiredPeriod = InpIchimoku1ConversionPeriod;');
    expect(mql4).toContain('if(iTime(_Symbol, _Period, requiredPeriod + 1) == 0)');
    expect(mql4).toContain(
      'double spanA = iIchimoku(_Symbol, _Period, InpIchimoku1ConversionPeriod, InpIchimoku1BasePeriod, InpIchimoku1SpanBPeriod, MODE_SENKOUSPANA, 1);',
    );
    expect(mql4).toContain(
      'double spanB = iIchimoku(_Symbol, _Period, InpIchimoku1ConversionPeriod, InpIchimoku1BasePeriod, InpIchimoku1SpanBPeriod, MODE_SENKOUSPANB, 1);',
    );
    expect(mql4).toContain('double close1 = iClose(_Symbol, _Period, 1);');
    expect(mql4).not.toContain('iIchimoku(NULL, 0');
    expect(mql4).not.toContain('iClose(NULL, 0');
    expect(mql4).toContain('CrossedAbove(previousConversion, previousBase, currentConversion, currentBase)');
    expect(mql4).toContain('CrossedBelow(previousConversion, previousBase, currentConversion, currentBase)');
    expect(mql4).toContain('close1 > MathMax(spanA, spanB)');
    expect(mql4).toContain('close1 < MathMin(spanA, spanB)');
    // MQL4 は履歴不足時に iIchimoku が 0.0 を返し ValueReady を素通りするため、このガードが唯一の防御
    expect(mql4).toContain(
      'if(iTime(_Symbol, _Period, InpIchimoku1SpanBPeriod + InpIchimoku1Displacement) == 0)',
    );
    expect(mql4).toContain('MT4/MT5 SENKOUSPAN buffers');
    expectBalanced(mql5);
    expectBalanced(mql4);

    const mismatched = generateMql4({
      ...strategy,
      entryConditions: [{
        type: 'ichimokuCross',
        conversionPeriod: 9,
        basePeriod: 26,
        spanBPeriod: 52,
        displacement: 30,
        requireCloudFilter: true,
      }],
    });
    expect(mismatched).toContain(
      'WARNING: Ichimoku displacement 30 differs from basePeriod 26',
    );
  });
});
