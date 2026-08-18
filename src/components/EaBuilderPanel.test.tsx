import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
// The plain-Node runner has no emitted TypeScript declaration; Vitest still resolves this module.
// @ts-expect-error TS7016 is limited to this untyped .mjs import.
import { knownEntryConditionTypes } from '../../scripts/run-forward-test.mjs';
import { SAR_MIN_STEP } from '../lib/indicators';
import {
  defaultMoneyManagement,
  type EntryCondition,
  type StrategyDefinition,
} from '../lib/strategy';

interface CapturedInput {
  type: 'input';
  props: Record<string, unknown>;
}

const panelHarness = vi.hoisted(() => ({
  injectedStates: [] as unknown[],
  stateCalls: [] as Array<{ index: number; next: unknown }>,
  stateCount: 0,
  inputs: [] as CapturedInput[],
}));

vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react');
  const useState = <T,>(initialState: T | (() => T)) => {
    const index = panelHarness.stateCount;
    panelHarness.stateCount += 1;
    const fallback =
      typeof initialState === 'function' ? (initialState as () => T)() : initialState;
    const state = (panelHarness.injectedStates[index] as T | undefined) ?? fallback;
    const setState = (next: T | ((previous: T) => T)): void => {
      panelHarness.stateCalls.push({ index, next });
    };
    return [state, setState] as const;
  };

  return {
    ...actual,
    useState,
  };
});

vi.mock('react/jsx-runtime', async () => {
  const actual = await vi.importActual<typeof import('react/jsx-runtime')>('react/jsx-runtime');
  const capture = (element: unknown): void => {
    if (element === null || typeof element !== 'object') {
      return;
    }
    const candidate = element as { type?: unknown; props?: unknown };
    if (candidate.type !== 'input' || candidate.props === null || typeof candidate.props !== 'object') {
      return;
    }
    panelHarness.inputs.push(candidate as CapturedInput);
  };
  const jsx = (...args: Parameters<typeof actual.jsx>): ReturnType<typeof actual.jsx> => {
    const element = actual.jsx(...args);
    capture(element);
    return element;
  };
  const jsxs = (...args: Parameters<typeof actual.jsxs>): ReturnType<typeof actual.jsxs> => {
    const element = actual.jsxs(...args);
    capture(element);
    return element;
  };

  return { ...actual, jsx, jsxs };
});

vi.mock('react/jsx-dev-runtime', async () => {
  const actual = await vi.importActual<typeof import('react/jsx-dev-runtime')>(
    'react/jsx-dev-runtime',
  );
  const capture = (element: unknown): void => {
    if (element === null || typeof element !== 'object') {
      return;
    }
    const candidate = element as { type?: unknown; props?: unknown };
    if (candidate.type !== 'input' || candidate.props === null || typeof candidate.props !== 'object') {
      return;
    }
    panelHarness.inputs.push(candidate as CapturedInput);
  };
  const jsxDEV = (...args: Parameters<typeof actual.jsxDEV>): ReturnType<typeof actual.jsxDEV> => {
    const element = actual.jsxDEV(...args);
    capture(element);
    return element;
  };

  return { ...actual, jsxDEV };
});

import { EaBuilderPanel, strategyValidationMessages } from './EaBuilderPanel';

const baseStrategy = (entryCondition: EntryCondition): StrategyDefinition => ({
  id: 'validation-test',
  name: 'validation test',
  direction: 'long',
  entryConditions: [entryCondition],
  exit: {
    stopLossPips: 30,
    takeProfitPips: 60,
    trailingStopPips: null,
    closeOnOppositeSignal: true,
  },
  sessionFilter: {
    enabled: false,
    start: '00:00',
    end: '23:59',
    serverUtcOffsetMinutes: 0,
  },
  newsFilter: {
    enabled: false,
    blockMinutes: 30,
  },
  lotSize: 0.1,
  moneyManagement: defaultMoneyManagement(0.1),
  magicNumber: 1,
});

const alter = (condition: EntryCondition, changes: Record<string, unknown>): EntryCondition =>
  ({ ...condition, ...changes }) as EntryCondition;

const validationCases: Array<{
  type: EntryCondition['type'];
  valid: EntryCondition;
  invalid: Array<{ label: string; condition: EntryCondition }>;
  message?: string;
}> = [
  {
    type: 'maCross',
    valid: {
      type: 'maCross',
      fastType: 'ema',
      fastPeriod: 1,
      slowType: 'ema',
      slowPeriod: 2,
    },
    invalid: [
      {
        label: 'equal periods',
        condition: {
          type: 'maCross',
          fastType: 'ema',
          fastPeriod: 20,
          slowType: 'ema',
          slowPeriod: 20,
        },
      },
      {
        label: 'reversed periods',
        condition: {
          type: 'maCross',
          fastType: 'ema',
          fastPeriod: 51,
          slowType: 'ema',
          slowPeriod: 50,
        },
      },
      {
        label: 'infinite fast period',
        condition: alter(
          {
            type: 'maCross',
            fastType: 'ema',
            fastPeriod: 20,
            slowType: 'ema',
            slowPeriod: 50,
          },
          { fastPeriod: Number.POSITIVE_INFINITY },
        ),
      },
    ],
    message: 'MAクロスは短期期間を長期期間より小さくしてください。',
  },
  {
    type: 'rsi',
    valid: { type: 'rsi', period: 2, threshold: 99.9, comparison: 'below' },
    invalid: [
      { label: 'period below minimum', condition: { type: 'rsi', period: 1, threshold: 30, comparison: 'below' } },
      { label: 'period non-integer', condition: { type: 'rsi', period: 2.5, threshold: 30, comparison: 'below' } },
      { label: 'period non-finite', condition: { type: 'rsi', period: Number.NaN, threshold: 30, comparison: 'below' } },
      { label: 'threshold below minimum', condition: { type: 'rsi', period: 14, threshold: 0, comparison: 'below' } },
      { label: 'threshold above maximum', condition: { type: 'rsi', period: 14, threshold: 100, comparison: 'below' } },
      { label: 'threshold non-finite', condition: { type: 'rsi', period: 14, threshold: Number.POSITIVE_INFINITY, comparison: 'below' } },
    ],
    message: 'RSIの期間は2以上の整数、閾値は0より大きく100未満の有限値にしてください。',
  },
  {
    type: 'demarker',
    valid: {
      type: 'demarker',
      period: 2,
      threshold: 0.9999999999999999,
      comparison: 'below',
    },
    invalid: [
      {
        label: 'period below minimum',
        condition: { type: 'demarker', period: 1, threshold: 0.3, comparison: 'below' },
      },
      {
        label: 'period non-integer',
        condition: { type: 'demarker', period: 2.5, threshold: 0.3, comparison: 'below' },
      },
      {
        label: 'period above registration ceiling',
        condition: { type: 'demarker', period: 1001, threshold: 0.3, comparison: 'below' },
      },
      {
        label: 'threshold at zero',
        condition: { type: 'demarker', period: 14, threshold: 0, comparison: 'below' },
      },
      {
        label: 'threshold at one',
        condition: { type: 'demarker', period: 14, threshold: 1, comparison: 'below' },
      },
      {
        label: 'threshold non-finite',
        condition: { type: 'demarker', period: 14, threshold: Number.POSITIVE_INFINITY, comparison: 'below' },
      },
    ],
    message: 'DeMarkerの期間は2以上1000以下の整数、閾値は0より大きく1未満の有限値にしてください。',
  },
  {
    type: 'bollinger',
    valid: {
      type: 'bollinger',
      period: 2,
      multiplier: Number.MIN_VALUE,
      mode: 'touch',
      band: 'lower',
    },
    invalid: [
      { label: 'period below minimum', condition: { type: 'bollinger', period: 1, multiplier: 2, mode: 'touch', band: 'lower' } },
      { label: 'period non-integer', condition: { type: 'bollinger', period: 2.5, multiplier: 2, mode: 'touch', band: 'lower' } },
      { label: 'period non-finite', condition: { type: 'bollinger', period: Number.NaN, multiplier: 2, mode: 'touch', band: 'lower' } },
      { label: 'multiplier below minimum', condition: { type: 'bollinger', period: 20, multiplier: 0, mode: 'touch', band: 'lower' } },
      { label: 'multiplier negative', condition: { type: 'bollinger', period: 20, multiplier: -0.1, mode: 'touch', band: 'lower' } },
      { label: 'multiplier non-finite', condition: { type: 'bollinger', period: 20, multiplier: Number.POSITIVE_INFINITY, mode: 'touch', band: 'lower' } },
    ],
    message: 'ボリンジャーの期間は2以上の整数、倍率は0より大きい有限値にしてください。',
  },
  {
    type: 'macdCross',
    valid: { type: 'macdCross', fastPeriod: 1, slowPeriod: 2, signalPeriod: 1 },
    invalid: [
      {
        label: 'equal periods',
        condition: { type: 'macdCross', fastPeriod: 26, slowPeriod: 26, signalPeriod: 9 },
      },
      {
        label: 'reversed periods',
        condition: { type: 'macdCross', fastPeriod: 27, slowPeriod: 26, signalPeriod: 9 },
      },
      {
        label: 'infinite fast period',
        condition: alter(
          { type: 'macdCross', fastPeriod: 12, slowPeriod: 26, signalPeriod: 9 },
          { fastPeriod: Number.POSITIVE_INFINITY },
        ),
      },
    ],
    message: 'MACDは短期期間を長期期間より小さくしてください。',
  },
  {
    type: 'ichimokuCross',
    valid: {
      type: 'ichimokuCross',
      conversionPeriod: 1,
      basePeriod: 1,
      spanBPeriod: 1,
      displacement: 1,
      requireCloudFilter: false,
    },
    invalid: [
      ...(['conversionPeriod', 'basePeriod', 'spanBPeriod', 'displacement'] as const).flatMap(
        (field) => [
          {
            label: `${field} below minimum`,
            condition: alter(
              {
                type: 'ichimokuCross',
                conversionPeriod: 9,
                basePeriod: 26,
                spanBPeriod: 52,
                displacement: 26,
                requireCloudFilter: false,
              },
              { [field]: 0 },
            ),
          },
          {
            label: `${field} non-integer`,
            condition: alter(
              {
                type: 'ichimokuCross',
                conversionPeriod: 9,
                basePeriod: 26,
                spanBPeriod: 52,
                displacement: 26,
                requireCloudFilter: false,
              },
              { [field]: 1.5 },
            ),
          },
          {
            label: `${field} non-finite`,
            condition: alter(
              {
                type: 'ichimokuCross',
                conversionPeriod: 9,
                basePeriod: 26,
                spanBPeriod: 52,
                displacement: 26,
                requireCloudFilter: false,
              },
              { [field]: Number.NaN },
            ),
          },
        ],
      ),
    ],
    message: '一目均衡表の期間は1以上の整数にしてください。',
  },
  {
    type: 'donchianBreak',
    valid: { type: 'donchianBreak', period: 1 },
    invalid: [
      { label: 'period below minimum', condition: { type: 'donchianBreak', period: 0 } },
      { label: 'period non-integer', condition: { type: 'donchianBreak', period: 1.5 } },
      { label: 'period non-finite', condition: { type: 'donchianBreak', period: Number.NaN } },
      {
        label: 'period positive infinity',
        condition: { type: 'donchianBreak', period: Number.POSITIVE_INFINITY },
      },
    ],
    message: 'ドンチアンブレイクの期間は1以上の整数にしてください。',
  },
  {
    type: 'stochastic',
    valid: {
      type: 'stochastic',
      kPeriod: 1,
      dPeriod: 1,
      smoothing: 1,
      threshold: 1,
      comparison: 'below',
    },
    invalid: [
      ...(['kPeriod', 'dPeriod', 'smoothing'] as const).flatMap((field) => [
        {
          label: `${field} below minimum`,
          condition: alter(
            {
              type: 'stochastic',
              kPeriod: 14,
              dPeriod: 3,
              smoothing: 3,
              threshold: 20,
              comparison: 'below',
            },
            { [field]: 0 },
          ),
        },
        {
          label: `${field} non-integer`,
          condition: alter(
            {
              type: 'stochastic',
              kPeriod: 14,
              dPeriod: 3,
              smoothing: 3,
              threshold: 20,
              comparison: 'below',
            },
            { [field]: 1.5 },
          ),
        },
        {
          label: `${field} non-finite`,
          condition: alter(
            {
              type: 'stochastic',
              kPeriod: 14,
              dPeriod: 3,
              smoothing: 3,
              threshold: 20,
              comparison: 'below',
            },
            { [field]: Number.POSITIVE_INFINITY },
          ),
        },
      ]),
    ],
    message: 'ストキャスティクスの期間は1以上の整数にしてください。',
  },
  {
    type: 'keltnerBreak',
    valid: { type: 'keltnerBreak', emaPeriod: 1, atrPeriod: 1, multiplier: 0.1 },
    invalid: [
      ...(['emaPeriod', 'atrPeriod'] as const).flatMap((field) => [
        {
          label: `${field} below minimum`,
          condition: alter(
            { type: 'keltnerBreak', emaPeriod: 20, atrPeriod: 10, multiplier: 2 },
            { [field]: 0 },
          ),
        },
        {
          label: `${field} non-integer`,
          condition: alter(
            { type: 'keltnerBreak', emaPeriod: 20, atrPeriod: 10, multiplier: 2 },
            { [field]: 1.5 },
          ),
        },
        {
          label: `${field} non-finite`,
          condition: alter(
            { type: 'keltnerBreak', emaPeriod: 20, atrPeriod: 10, multiplier: 2 },
            { [field]: Number.NaN },
          ),
        },
      ]),
      {
        label: 'multiplier below minimum',
        condition: { type: 'keltnerBreak', emaPeriod: 20, atrPeriod: 10, multiplier: 0 },
      },
      {
        label: 'multiplier non-finite',
        condition: { type: 'keltnerBreak', emaPeriod: 20, atrPeriod: 10, multiplier: Number.POSITIVE_INFINITY },
      },
    ],
    message: 'ケルトナーブレイクの期間は1以上の整数、倍率は0より大きい値にしてください。',
  },
  {
    type: 'cciBreak',
    valid: { type: 'cciBreak', period: 1, level: 0.1 },
    invalid: [
      { label: 'period below minimum', condition: { type: 'cciBreak', period: 0, level: 100 } },
      { label: 'period non-integer', condition: { type: 'cciBreak', period: 1.5, level: 100 } },
      { label: 'period non-finite', condition: { type: 'cciBreak', period: Number.NaN, level: 100 } },
      { label: 'level below minimum', condition: { type: 'cciBreak', period: 14, level: 0 } },
      {
        label: 'level non-finite',
        condition: { type: 'cciBreak', period: 14, level: Number.NEGATIVE_INFINITY },
      },
    ],
    message: 'CCIブレイクの期間は1以上の整数、閾値は0より大きい値にしてください。',
  },
  {
    type: 'adxTrend',
    valid: { type: 'adxTrend', period: 2, threshold: 99.9 },
    invalid: [
      { label: 'period below minimum', condition: { type: 'adxTrend', period: 1, threshold: 25 } },
      { label: 'period non-integer', condition: { type: 'adxTrend', period: 2.5, threshold: 25 } },
      {
        label: 'period non-finite',
        condition: { type: 'adxTrend', period: Number.POSITIVE_INFINITY, threshold: 25 },
      },
      { label: 'threshold below minimum', condition: { type: 'adxTrend', period: 14, threshold: 0 } },
      { label: 'threshold above maximum', condition: { type: 'adxTrend', period: 14, threshold: 100 } },
      {
        label: 'threshold non-finite',
        condition: { type: 'adxTrend', period: 14, threshold: Number.NaN },
      },
    ],
    message: 'ADXトレンドの期間は2以上の整数、閾値は0より大きく100未満にしてください。',
  },
  {
    type: 'parabolicSar',
    valid: { type: 'parabolicSar', step: SAR_MIN_STEP, maximum: SAR_MIN_STEP },
    invalid: [
      {
        label: 'step below minimum',
        condition: { type: 'parabolicSar', step: SAR_MIN_STEP - 0.001, maximum: 0.2 },
      },
      {
        label: 'step above maximum bound',
        condition: { type: 'parabolicSar', step: 1, maximum: 1 },
      },
      {
        label: 'step non-finite',
        condition: { type: 'parabolicSar', step: Number.NaN, maximum: 0.2 },
      },
      {
        label: 'maximum below step',
        condition: { type: 'parabolicSar', step: 0.4, maximum: 0.2 },
      },
      {
        label: 'maximum above maximum bound',
        condition: { type: 'parabolicSar', step: 0.2, maximum: 1 },
      },
      {
        label: 'maximum non-finite',
        condition: { type: 'parabolicSar', step: 0.2, maximum: Number.POSITIVE_INFINITY },
      },
    ],
    message: `パラボリックSARのstepは${SAR_MIN_STEP}以上1未満、maximumはstep以上1未満の有限値にしてください。`,
  },
  {
    type: 'momentum',
    valid: { type: 'momentum', period: 1000 },
    invalid: [
      { label: 'period below minimum', condition: { type: 'momentum', period: 1 } },
      { label: 'period above maximum', condition: { type: 'momentum', period: 1001 } },
      { label: 'period non-integer', condition: { type: 'momentum', period: 2.5 } },
      { label: 'period non-finite', condition: { type: 'momentum', period: Number.NaN } },
    ],
    message: 'Momentumの期間は2以上1000以下の整数にしてください。',
  },
  {
    type: 'ao',
    valid: { type: 'ao', fastPeriod: 999, slowPeriod: 1000 },
    invalid: [
      { label: 'fast period below minimum (1)', condition: { type: 'ao', fastPeriod: 1, slowPeriod: 3 } },
      { label: 'slow period below minimum', condition: { type: 'ao', fastPeriod: 2, slowPeriod: 1 } },
      { label: 'equal periods', condition: { type: 'ao', fastPeriod: 2, slowPeriod: 2 } },
      { label: 'fast period greater than slow period', condition: { type: 'ao', fastPeriod: 3, slowPeriod: 2 } },
      { label: 'fast period non-integer', condition: { type: 'ao', fastPeriod: 2.5, slowPeriod: 3 } },
      { label: 'slow period non-integer', condition: { type: 'ao', fastPeriod: 2, slowPeriod: 3.5 } },
      { label: 'period above maximum', condition: { type: 'ao', fastPeriod: 1001, slowPeriod: 1002 } },
    ],
    message: 'AOの短期期間と長期期間は2以上1000以下の整数で、短期期間を長期期間より小さくしてください。',
  },
  {
    type: 'rvi',
    valid: { type: 'rvi', period: 1000 },
    invalid: [
      { label: 'period below minimum', condition: { type: 'rvi', period: 1 } },
      { label: 'period above maximum', condition: { type: 'rvi', period: 1001 } },
      { label: 'period non-integer', condition: { type: 'rvi', period: 2.5 } },
      { label: 'period non-finite', condition: { type: 'rvi', period: Number.POSITIVE_INFINITY } },
    ],
    message: 'RVIの期間は2以上1000以下の整数にしてください。',
  },
  {
    type: 'envelope',
    valid: { type: 'envelope', period: 2, deviation: Number.MIN_VALUE },
    invalid: [
      { label: 'period below minimum', condition: { type: 'envelope', period: 1, deviation: 0.1 } },
      { label: 'period above maximum', condition: { type: 'envelope', period: 1001, deviation: 0.1 } },
      { label: 'period non-integer', condition: { type: 'envelope', period: 2.5, deviation: 0.1 } },
      { label: 'period non-finite', condition: { type: 'envelope', period: Number.NaN, deviation: 0.1 } },
      { label: 'deviation at zero', condition: { type: 'envelope', period: 14, deviation: 0 } },
      {
        label: 'deviation non-finite',
        condition: { type: 'envelope', period: 14, deviation: Number.POSITIVE_INFINITY },
      },
    ],
    message: 'エンベロープの期間は2以上1000以下の整数、乖離率は0より大きい有限値にしてください。',
  },
];

it('covers every registered entry condition type exactly once and in registry order', () => {
  expect(validationCases.map((validationCase) => validationCase.type)).toEqual([
    ...knownEntryConditionTypes,
  ]);
});

it.each(validationCases)('$type accepts its valid boundary values', ({ valid }) => {
  expect(strategyValidationMessages(baseStrategy(valid))).toEqual([]);
});

it('accepts both Envelope period registration boundaries with a positive finite deviation', () => {
  for (const period of [2, 1000]) {
    expect(
      strategyValidationMessages(
        baseStrategy({ type: 'envelope', period, deviation: Number.MIN_VALUE }),
      ),
    ).toEqual([]);
  }
});

it('accepts the AO lower period registration boundaries directly', () => {
  expect(
    strategyValidationMessages(
      baseStrategy({ type: 'ao', fastPeriod: 2, slowPeriod: 3 }),
    ),
  ).toEqual([]);
});

it('accepts the AO mixed period registration boundaries directly', () => {
  expect(
    strategyValidationMessages(
      baseStrategy({ type: 'ao', fastPeriod: 2, slowPeriod: 1000 }),
    ),
  ).toEqual([]);
});

const invalidValidationCases = validationCases.flatMap(({ type, invalid, message }) =>
  invalid.map(({ label, condition }) => ({ type, label, condition, message })),
);

it.each(invalidValidationCases)('$type rejects $label', ({ condition, message }) => {
  expect(message).toBeDefined();
  expect(strategyValidationMessages(baseStrategy(condition))).toContain(message);
});

const renderSarPanel = (step: number, maximum: number): {
  strategy: StrategyDefinition;
  markup: string;
} => {
  const strategy = baseStrategy({ type: 'parabolicSar', step, maximum });
  panelHarness.injectedStates = [strategy];
  panelHarness.stateCalls = [];
  panelHarness.stateCount = 0;
  panelHarness.inputs = [];
  const markup = renderToStaticMarkup(
    <EaBuilderPanel bars={[]} pair="USDJPY" timeframe="h1" />,
  );
  return { strategy, markup };
};

describe('EaBuilderPanel SAR controls', () => {
  it('renders the SAR maximum input min from the current step', () => {
    const { markup } = renderSarPanel(0.07, 0.2);

    expect(markup).toMatch(/<span>maximum<\/span><input[^>]*min="0\.07"/);
    expect(
      panelHarness.inputs.some(
        (input) => input.props.value === 0.2 && input.props.min === 0.07,
      ),
    ).toBe(true);
  });

  it('clamps maximum up when the SAR step is raised above it', () => {
    const { strategy } = renderSarPanel(SAR_MIN_STEP, 0.2);
    const stepInput = panelHarness.inputs.find(
      (input) =>
        input.props.value === SAR_MIN_STEP &&
        input.props.min === SAR_MIN_STEP &&
        input.props.max === '0.999',
    );
    expect(stepInput).toBeDefined();
    expect(typeof stepInput?.props.onChange).toBe('function');

    (stepInput?.props.onChange as (event: { target: { value: string } }) => void)({
      target: { value: '0.4' },
    });

    const strategyCall = [...panelHarness.stateCalls]
      .reverse()
      .find(({ index }) => index === 0);
    // EaBuilderPanelのuseState宣言順で、index 0がstrategy stateであることを固定する。
    expect(strategyCall).toBeDefined();
    expect(typeof strategyCall?.next).toBe('function');
    const nextStrategy = (strategyCall?.next as (current: StrategyDefinition) => StrategyDefinition)(
      strategy,
    );
    expect(nextStrategy.entryConditions[0]).toMatchObject({
      type: 'parabolicSar',
      step: 0.4,
      maximum: 0.4,
    });
    const { markup: clampedMarkup } = renderSarPanel(0.4, 0.4);
    expect(clampedMarkup).toMatch(/<span>maximum<\/span><input[^>]*value="0\.4"/);
    expect(strategyValidationMessages(nextStrategy)).toEqual([]);
  });
});
