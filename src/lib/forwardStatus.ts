export function evaluateForwardStatus(metrics: {
  tradeCount: number;
  profitFactor: number | null;
  netProfitYen: number | null;
}): {
  label: string;
  tone: 'positive' | 'neutral' | 'negative';
  detail: string;
} {
  const { tradeCount, profitFactor } = metrics;

  if (tradeCount === 0) {
    return {
      label: 'シグナル待ち',
      tone: 'neutral',
      detail: '取引0件。約定後に成績を判定する',
    };
  }

  if (tradeCount < 10) {
    return {
      label: '判定保留(サンプル不足)',
      tone: 'neutral',
      detail: `取引${tradeCount}件。10件未満は成績判定しない`,
    };
  }

  if (profitFactor === Number.POSITIVE_INFINITY) {
    // 損失取引ゼロは「データ不足」ではなく確定事実。ただし全勝サンプルは
    // 幸運か先読みバグの可能性が高いため、好調とは主張せず保留に留める。
    return {
      label: '判定保留(損失取引なし)',
      tone: 'neutral',
      detail: `損失取引なし / ${tradeCount}取引`,
    };
  }

  if (profitFactor === null || !Number.isFinite(profitFactor)) {
    return {
      label: '判定保留(データ不足)',
      tone: 'neutral',
      detail: `PF 算出不可 / ${tradeCount}取引`,
    };
  }

  const detail = `PF ${profitFactor.toFixed(2)} / ${tradeCount}取引`;

  if (profitFactor >= 1.1) {
    return {
      label: '好調',
      tone: 'positive',
      detail,
    };
  }

  if (profitFactor < 0.9) {
    return {
      label: '不調(この設定での運用は非推奨)',
      tone: 'negative',
      detail,
    };
  }

  return {
    label: '中立圏(優位性未確認)',
    tone: 'neutral',
    detail,
  };
}
