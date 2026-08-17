import { describe, expect, it } from 'vitest';
import { evaluateForwardStatus } from './forwardStatus';

describe('evaluateForwardStatus', () => {
  it('keeps zero trades in the signal-waiting state before evaluating PF', () => {
    expect(evaluateForwardStatus({
      tradeCount: 0,
      profitFactor: 2,
      netProfitYen: 100_000,
    })).toEqual({
      label: 'シグナル待ち',
      tone: 'neutral',
      detail: '取引0件。約定後に成績を判定する',
    });
  });

  it('holds judgment when there are only 9 trades even if PF is high', () => {
    expect(evaluateForwardStatus({
      tradeCount: 9,
      profitFactor: 2,
      netProfitYen: 100_000,
    })).toEqual({
      label: '判定保留(サンプル不足)',
      tone: 'neutral',
      detail: '取引9件。10件未満は成績判定しない',
    });
  });

  it.each([
    ['null', null],
    ['NaN', Number.NaN],
    ['negative infinity', Number.NEGATIVE_INFINITY],
  ])('holds judgment when PF is %s', (_caseName, profitFactor) => {
    expect(evaluateForwardStatus({
      tradeCount: 10,
      profitFactor,
      netProfitYen: 50_000,
    })).toEqual({
      label: '判定保留(データ不足)',
      tone: 'neutral',
      detail: 'PF 算出不可 / 10取引',
    });
  });

  it('holds judgment without claiming missing data when PF is +Infinity (no losing trades)', () => {
    expect(evaluateForwardStatus({
      tradeCount: 10,
      profitFactor: Number.POSITIVE_INFINITY,
      netProfitYen: 50_000,
    })).toEqual({
      label: '判定保留(損失取引なし)',
      tone: 'neutral',
      detail: '損失取引なし / 10取引',
    });
  });

  it('marks PF 1.1 as positive at the 10-trade boundary regardless of net profit', () => {
    expect(evaluateForwardStatus({
      tradeCount: 10,
      profitFactor: 1.1,
      netProfitYen: -20_000,
    })).toEqual({
      label: '好調',
      tone: 'positive',
      detail: 'PF 1.10 / 10取引',
    });
  });

  it('marks PF above 1.1 as positive', () => {
    expect(evaluateForwardStatus({
      tradeCount: 21,
      profitFactor: 1.34,
      netProfitYen: null,
    })).toEqual({
      label: '好調',
      tone: 'positive',
      detail: 'PF 1.34 / 21取引',
    });
  });

  it('marks PF below 0.9 as negative regardless of positive net profit', () => {
    expect(evaluateForwardStatus({
      tradeCount: 21,
      profitFactor: 0.76,
      netProfitYen: 20_000,
    })).toEqual({
      label: '不調(この設定での運用は非推奨)',
      tone: 'negative',
      detail: 'PF 0.76 / 21取引',
    });
  });

  it('keeps PF between the thresholds in the neutral range', () => {
    expect(evaluateForwardStatus({
      tradeCount: 21,
      profitFactor: 1,
      netProfitYen: -20_000,
    })).toEqual({
      label: '中立圏(優位性未確認)',
      tone: 'neutral',
      detail: 'PF 1.00 / 21取引',
    });
  });

  it('treats PF 0.9 as the lower neutral boundary', () => {
    expect(evaluateForwardStatus({
      tradeCount: 10,
      profitFactor: 0.9,
      netProfitYen: -20_000,
    })).toEqual({
      label: '中立圏(優位性未確認)',
      tone: 'neutral',
      detail: 'PF 0.90 / 10取引',
    });
  });
});
