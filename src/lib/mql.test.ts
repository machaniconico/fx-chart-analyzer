import { describe, expect, it } from 'vitest';
import { generateMql4, generateMql5 } from './mql';
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
      { type: 'keltnerBreak', emaPeriod: 20, atrPeriod: 10, multiplier: 2 },
      { type: 'cciBreak', period: 14, level: 100 },
      { type: 'adxTrend', period: 14, threshold: 25 },
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
