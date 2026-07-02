import { signalDirectionFromScore, type SignalDirection } from './signals';
import { TIMEFRAMES, timeframeLabels, type Timeframe } from '../types';

export type MtfAlignmentStatus = 'aligned' | 'diverged' | 'neutral';

export interface MtfAlignmentInput {
  mainTimeframe: Timeframe;
  secondaryTimeframe: Timeframe;
  mainScore: number;
  secondaryScore: number;
}

export interface MtfAlignmentResult {
  status: MtfAlignmentStatus;
  mainDirection: SignalDirection;
  secondaryDirection: SignalDirection;
  summary: string;
}

const defaultSecondaryTimeframe: Record<Timeframe, Timeframe> = {
  m15: 'h1',
  m30: 'h4',
  h1: 'h4',
  h4: 'd1',
  d1: 'h4',
};

const timeframeRank: Record<Timeframe, number> = {
  m15: 0.25,
  m30: 0.5,
  h1: 1,
  h4: 4,
  d1: 24,
};

const directionLabels: Record<SignalDirection, string> = {
  bullish: '買い寄り',
  bearish: '売り寄り',
  neutral: '中立',
};

export const getDefaultMtfTimeframe = (mainTimeframe: Timeframe): Timeframe =>
  defaultSecondaryTimeframe[mainTimeframe];

export const getSelectableMtfTimeframes = (mainTimeframe: Timeframe): Timeframe[] =>
  TIMEFRAMES.filter((timeframe) => timeframe !== mainTimeframe);

const relativeTimeframeLabel = (mainTimeframe: Timeframe, secondaryTimeframe: Timeframe): string => {
  if (timeframeRank[secondaryTimeframe] > timeframeRank[mainTimeframe]) {
    return '上位足';
  }
  if (timeframeRank[secondaryTimeframe] < timeframeRank[mainTimeframe]) {
    return '下位足';
  }
  return '別時間足';
};

export const evaluateMtfAlignment = ({
  mainTimeframe,
  secondaryTimeframe,
  mainScore,
  secondaryScore,
}: MtfAlignmentInput): MtfAlignmentResult => {
  const mainDirection = signalDirectionFromScore(mainScore);
  const secondaryDirection = signalDirectionFromScore(secondaryScore);
  const mainLabel = timeframeLabels[mainTimeframe];
  const secondaryLabel = timeframeLabels[secondaryTimeframe];

  if (mainDirection === 'neutral' || secondaryDirection === 'neutral') {
    return {
      status: 'neutral',
      mainDirection,
      secondaryDirection,
      summary: `${secondaryLabel}と${mainLabel}のどちらかが中立で、方向一致はまだ弱めです`,
    };
  }

  if (mainDirection === secondaryDirection) {
    return {
      status: 'aligned',
      mainDirection,
      secondaryDirection,
      summary: `${secondaryLabel}と${mainLabel}の方向が一致（${directionLabels[mainDirection]}）に見えます`,
    };
  }

  return {
    status: 'diverged',
    mainDirection,
    secondaryDirection,
    summary: `${relativeTimeframeLabel(mainTimeframe, secondaryTimeframe)}と逆行中の可能性があります`,
  };
};
