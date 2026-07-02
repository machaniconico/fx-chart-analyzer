import { describe, expect, it } from 'vitest';
import { generateMql4, generateMql5 } from './mql';
import type { StrategyDefinition } from './strategy';

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
  lotSize: 0.2,
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

describe('mql generation', () => {
  it('generates a complete MQL5 EA source with matching inputs and core functions', () => {
    const source = generateMql5(fullStrategy);

    expect(source).toContain('#include <Trade/Trade.mqh>');
    expect(source).toContain('CTrade trade;');
    expect(source).toContain('void OnTick()');
    expect(source).toContain('bool IsNewBar()');
    expect(source).toContain('void ManageTrailingStop()');
    expect(source).toContain('input double InpLots = 0.2;');
    expect(source).toContain('input int InpMagicNumber = 67890;');
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

    expect(source).toContain('void OnTick()');
    expect(source).toContain('bool IsNewBar()');
    expect(source).toContain('int CurrentOrderTicket()');
    expect(source).toContain('void ManageTrailingStop()');
    expect(source).toContain('input double InpLots = 0.2;');
    expect(source).toContain('input int InpMagicNumber = 67890;');
    expect(source).toContain('input int InpStopLossPips = 25;');
    expect(source).toContain('input int InpTakeProfitPips = 50;');
    expect(source).toContain('input int InpTrailingStopPips = 15;');
    expect(source).toContain('input int InpMA1FastMethod = MODE_EMA;');
    expect(source).toContain('input double InpRSI2Threshold = 30;');
    expect(source).toContain('input double InpBB3Deviation = 2;');
    expect(source).toContain('input int InpMACD4SignalPeriod = 9;');
    expect(source).toContain('OrderSend(_Symbol, OP_BUY');
    expect(source).toContain('OrderSend(_Symbol, OP_SELL');
    expect(source).toContain('iMA(_Symbol, _Period');
    expect(source).toContain('iRSI(_Symbol, _Period');
    expect(source).toContain('iBands(_Symbol, _Period');
    expect(source).toContain('iMACD(_Symbol, _Period');
    expectBalanced(source);
  });

  it('rejects non-finite generated numeric values before emitting MQL', () => {
    expect(() => generateMql5({ ...fullStrategy, lotSize: Number.NaN })).toThrow(
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
});
