export type ForwardOperationStatus = 'active' | 'probation' | 'retire_candidate';

export interface ForwardOperationStatusResult {
  status: ForwardOperationStatus;
  reason: string;
}

export interface ForwardRetirementInput {
  profitFactor: number | null;
  tradeCount: number;
  confirmedDayCount: number;
  netProfitYen: number | null;
}

const formatProfitFactor = (profitFactor: number | null): string => {
  // Confirmed-history metrics serialize an infinite PF (profits with no losses)
  // as null, so null represents an unbounded, non-triggering PF here.
  if (profitFactor === null) {
    return '∞（損失0）';
  }
  if (Number.isNaN(profitFactor)) {
    return '算出不能';
  }
  if (profitFactor === Number.POSITIVE_INFINITY) {
    return '∞';
  }
  if (profitFactor === Number.NEGATIVE_INFINITY) {
    return '-∞';
  }
  return profitFactor.toFixed(2);
};

const metricReason = ({
  profitFactor,
  tradeCount,
  confirmedDayCount,
}: ForwardRetirementInput): string =>
  `PF=${formatProfitFactor(profitFactor)}、取引数=${tradeCount}件、確定日数=${confirmedDayCount}日`;

/**
 * Determines an EA's operating state exclusively from immutable forward history.
 * Rules are intentionally evaluated in product-specified priority order.
 */
export const evaluateForwardRetirement = (
  input: ForwardRetirementInput,
): ForwardOperationStatusResult => {
  const { profitFactor, tradeCount, confirmedDayCount, netProfitYen } = input;
  const metrics = metricReason(input);
  const hasFiniteProfitFactor = profitFactor !== null && Number.isFinite(profitFactor);

  if (tradeCount >= 20 && hasFiniteProfitFactor && profitFactor < 0.9) {
    return {
      status: 'retire_candidate',
      reason: `取引20件以上かつPF 0.9未満: ${metrics}`,
    };
  }

  if (
    confirmedDayCount >= 45
    && tradeCount >= 10
    && netProfitYen !== null
    && netProfitYen < 0
  ) {
    return {
      status: 'retire_candidate',
      reason: `確定45日以上・取引10件以上・累積損益${netProfitYen.toLocaleString('ja-JP')}円: ${metrics}`,
    };
  }

  if (tradeCount >= 10 && hasFiniteProfitFactor && profitFactor < 1) {
    return {
      status: 'probation',
      reason: `取引10件以上かつPF 1.0未満: ${metrics}`,
    };
  }

  if (tradeCount < 10) {
    return {
      status: 'active',
      reason: `サンプル不足（取引10件未満）のためactive: ${metrics}`,
    };
  }

  return {
    status: 'active',
    reason: `淘汰・probation条件に該当せずactive: ${metrics}`,
  };
};
