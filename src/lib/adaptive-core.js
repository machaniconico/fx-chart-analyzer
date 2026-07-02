export const adaptiveModelIds = ['signal', 'drift', 'regime'];
export const defaultModelWeights = {
  signal: 0.4,
  drift: 0.35,
  regime: 0.25,
};
export const defaultPredictionHorizons = [1, 5, 20];

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

const mean = (values) =>
  values.length === 0 ? 0 : values.reduce((total, value) => total + value, 0) / values.length;

const standardDeviation = (values) => {
  if (values.length < 2) {
    return 0;
  }
  const average = mean(values);
  const variance = values.reduce((total, value) => total + (value - average) ** 2, 0) / values.length;
  return Math.sqrt(variance);
};

const erf = (value) => {
  const sign = value < 0 ? -1 : 1;
  const x = Math.abs(value);
  const t = 1 / (1 + 0.3275911 * x);
  const y =
    1 -
    (((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t +
      0.254829592) *
      t *
      Math.exp(-x * x));
  return sign * y;
};

const normalCdf = (value) => 0.5 * (1 + erf(value / Math.SQRT2));

const isNumber = (value) => typeof value === 'number' && Number.isFinite(value);

const crossedAbove = (previousFast, previousSlow, currentFast, currentSlow) =>
  isNumber(previousFast) &&
  isNumber(previousSlow) &&
  isNumber(currentFast) &&
  isNumber(currentSlow) &&
  previousFast <= previousSlow &&
  currentFast > currentSlow;

const crossedBelow = (previousFast, previousSlow, currentFast, currentSlow) =>
  isNumber(previousFast) &&
  isNumber(previousSlow) &&
  isNumber(currentFast) &&
  isNumber(currentSlow) &&
  previousFast >= previousSlow &&
  currentFast < currentSlow;

const simpleMovingAverage = (values, period) => {
  const result = Array.from({ length: values.length }, () => null);
  let sum = 0;
  for (let index = 0; index < values.length; index += 1) {
    sum += values[index];
    if (index >= period) {
      sum -= values[index - period];
    }
    if (index >= period - 1) {
      result[index] = sum / period;
    }
  }
  return result;
};

const exponentialMovingAverage = (values, period) => {
  const result = Array.from({ length: values.length }, () => null);
  if (values.length < period) {
    return result;
  }
  const multiplier = 2 / (period + 1);
  let current = mean(values.slice(0, period));
  result[period - 1] = current;
  for (let index = period; index < values.length; index += 1) {
    current = (values[index] - current) * multiplier + current;
    result[index] = current;
  }
  return result;
};

const relativeStrengthIndex = (values, period = 14) => {
  const result = Array.from({ length: values.length }, () => null);
  if (values.length <= period) {
    return result;
  }

  let gain = 0;
  let loss = 0;
  for (let index = 1; index <= period; index += 1) {
    const change = values[index] - values[index - 1];
    gain += Math.max(change, 0);
    loss += Math.max(-change, 0);
  }

  let averageGain = gain / period;
  let averageLoss = loss / period;
  result[period] = averageLoss === 0 ? 100 : 100 - 100 / (1 + averageGain / averageLoss);

  for (let index = period + 1; index < values.length; index += 1) {
    const change = values[index] - values[index - 1];
    averageGain = (averageGain * (period - 1) + Math.max(change, 0)) / period;
    averageLoss = (averageLoss * (period - 1) + Math.max(-change, 0)) / period;
    result[index] = averageLoss === 0 ? 100 : 100 - 100 / (1 + averageGain / averageLoss);
  }

  return result;
};

const macdValues = (values, fast = 12, slow = 26, signalPeriod = 9) => {
  const fastEma = exponentialMovingAverage(values, fast);
  const slowEma = exponentialMovingAverage(values, slow);
  const macd = values.map((_, index) =>
    isNumber(fastEma[index]) && isNumber(slowEma[index]) ? fastEma[index] - slowEma[index] : null,
  );
  const compactMacd = macd.filter(isNumber);
  const compactSignal = exponentialMovingAverage(compactMacd, signalPeriod);
  const signal = Array.from({ length: values.length }, () => null);
  let compactIndex = 0;
  for (let index = 0; index < macd.length; index += 1) {
    if (isNumber(macd[index])) {
      signal[index] = compactSignal[compactIndex] ?? null;
      compactIndex += 1;
    }
  }
  return { macd, signal };
};

const bollingerBands = (values, period = 20, multiplier = 2) => {
  const middle = simpleMovingAverage(values, period);
  const upper = Array.from({ length: values.length }, () => null);
  const lower = Array.from({ length: values.length }, () => null);
  for (let index = period - 1; index < values.length; index += 1) {
    const windowValues = values.slice(index - period + 1, index + 1);
    const deviation = standardDeviation(windowValues);
    if (isNumber(middle[index])) {
      upper[index] = middle[index] + deviation * multiplier;
      lower[index] = middle[index] - deviation * multiplier;
    }
  }
  return { upper, lower };
};

const ichimokuCloud = (highs, lows, displacement = 26) => {
  const length = highs.length + displacement;
  const leadingSpanA = Array.from({ length }, () => null);
  const leadingSpanB = Array.from({ length }, () => null);
  const conversion = Array.from({ length: highs.length }, () => null);
  const base = Array.from({ length: highs.length }, () => null);

  const midpoint = (index, period) => {
    if (index < period - 1) {
      return null;
    }
    const high = Math.max(...highs.slice(index - period + 1, index + 1));
    const low = Math.min(...lows.slice(index - period + 1, index + 1));
    return (high + low) / 2;
  };

  for (let index = 0; index < highs.length; index += 1) {
    conversion[index] = midpoint(index, 9);
    base[index] = midpoint(index, 26);
    if (isNumber(conversion[index]) && isNumber(base[index])) {
      leadingSpanA[index + displacement] = (conversion[index] + base[index]) / 2;
    }
    leadingSpanB[index + displacement] = midpoint(index, 52);
  }

  return { leadingSpanA, leadingSpanB };
};

const latestAtr = (bars, period = 14) => {
  if (bars.length < 2) {
    return null;
  }
  const start = Math.max(1, bars.length - period);
  let total = 0;
  let count = 0;
  for (let index = start; index < bars.length; index += 1) {
    const previousClose = bars[index - 1].c;
    total += Math.max(
      bars[index].h - bars[index].l,
      Math.abs(bars[index].h - previousClose),
      Math.abs(bars[index].l - previousClose),
    );
    count += 1;
  }
  return count > 0 ? total / count : null;
};

const findSwingLevelsAt = (bars, currentIndex, lookback = 120, pivotStrength = 2) => {
  const latest = bars[currentIndex];
  const currentClose = latest.c;
  const start = Math.max(0, currentIndex + 1 - lookback);
  const end = currentIndex - pivotStrength;
  const pivotHighs = [];
  const pivotLows = [];

  for (let index = Math.max(start + pivotStrength, pivotStrength); index <= end; index += 1) {
    let highPivot = true;
    let lowPivot = true;
    for (let offset = index - pivotStrength; offset <= index + pivotStrength; offset += 1) {
      if (offset === index) {
        continue;
      }
      if (bars[offset].h >= bars[index].h) {
        highPivot = false;
      }
      if (bars[offset].l <= bars[index].l) {
        lowPivot = false;
      }
    }
    if (highPivot) {
      pivotHighs.push(bars[index].h);
    }
    if (lowPivot) {
      pivotLows.push(bars[index].l);
    }
  }

  const fallback = bars.slice(start, Math.max(start + 1, currentIndex));
  if (pivotHighs.length === 0 && fallback.length > 0) {
    pivotHighs.push(Math.max(...fallback.map((bar) => bar.h)));
  }
  if (pivotLows.length === 0 && fallback.length > 0) {
    pivotLows.push(Math.min(...fallback.map((bar) => bar.l)));
  }

  const supportPrice = [...pivotLows].reverse().find((price) => price <= currentClose) ?? null;
  const resistancePrice = [...pivotHighs].reverse().find((price) => price >= currentClose) ?? null;
  const atr = latestAtr(bars.slice(0, currentIndex + 1), 14);
  const atrPct = atr && currentClose !== 0 ? Math.abs(atr / currentClose) : 0.002;
  const thresholdPct = clamp(Math.max(0.0015, atrPct * 0.75), 0.0015, 0.012);

  return {
    support:
      supportPrice === null
        ? null
        : { price: supportPrice, distancePct: Math.abs(currentClose - supportPrice) / Math.abs(currentClose) },
    resistance:
      resistancePrice === null
        ? null
        : { price: resistancePrice, distancePct: Math.abs(resistancePrice - currentClose) / Math.abs(currentClose) },
    thresholdPct,
  };
};

const findSwingLevels = (bars, lookback = 120, pivotStrength = 2) =>
  findSwingLevelsAt(bars, bars.length - 1, lookback, pivotStrength);

// Mirrors src/lib/signals.ts analyzeSignals scoring for the adaptive historical model.
const scoreSignalSeries = (bars) => {
  const closes = bars.map((bar) => bar.c);
  const highs = bars.map((bar) => bar.h);
  const lows = bars.map((bar) => bar.l);
  const sma20 = simpleMovingAverage(closes, 20);
  const sma50 = simpleMovingAverage(closes, 50);
  const rsi14 = relativeStrengthIndex(closes, 14);
  const macdResult = macdValues(closes, 12, 26, 9);
  const bands = bollingerBands(closes, 20, 2);
  const ichimokuResult = ichimokuCloud(highs, lows);
  const scores = Array.from({ length: bars.length }, () => 0);

  for (let latestIndex = 1; latestIndex < bars.length; latestIndex += 1) {
    const previousIndex = latestIndex - 1;
    const latestClose = closes[latestIndex];
    let score = 0;

    if (crossedAbove(sma20[previousIndex], sma50[previousIndex], sma20[latestIndex], sma50[latestIndex])) {
      score += 2;
    } else if (crossedBelow(sma20[previousIndex], sma50[previousIndex], sma20[latestIndex], sma50[latestIndex])) {
      score -= 2;
    }

    const latestRsi = rsi14[latestIndex];
    if (isNumber(latestRsi) && latestRsi <= 30) {
      score += 1;
    } else if (isNumber(latestRsi) && latestRsi >= 70) {
      score -= 1;
    }

    if (
      crossedAbove(
        macdResult.macd[previousIndex],
        macdResult.signal[previousIndex],
        macdResult.macd[latestIndex],
        macdResult.signal[latestIndex],
      )
    ) {
      score += 1;
    } else if (
      crossedBelow(
        macdResult.macd[previousIndex],
        macdResult.signal[previousIndex],
        macdResult.macd[latestIndex],
        macdResult.signal[latestIndex],
      )
    ) {
      score -= 1;
    }

    const upperBand = bands.upper[latestIndex];
    const lowerBand = bands.lower[latestIndex];
    if (isNumber(upperBand) && latestClose > upperBand) {
      score += 1;
    } else if (isNumber(lowerBand) && latestClose < lowerBand) {
      score -= 1;
    }

    const spanA = ichimokuResult.leadingSpanA[latestIndex];
    const spanB = ichimokuResult.leadingSpanB[latestIndex];
    if (isNumber(spanA) && isNumber(spanB)) {
      const cloudTop = Math.max(spanA, spanB);
      const cloudBottom = Math.min(spanA, spanB);
      if (latestClose > cloudTop) {
        score += 1;
      } else if (latestClose < cloudBottom) {
        score -= 1;
      }
    }

    if (latestIndex + 1 >= 12) {
      const swing = findSwingLevelsAt(bars, latestIndex);
      if (swing.support && swing.support.distancePct <= swing.thresholdPct) {
        score += 1;
      }
      if (swing.resistance && swing.resistance.distancePct <= swing.thresholdPct) {
        score -= 1;
      }
    }

    scores[latestIndex] = score;
  }

  return scores;
};

export const scoreSignalsForBars = (bars) =>
  bars.length < 2 ? 0 : scoreSignalSeries(bars)[bars.length - 1] ?? 0;

const logReturns = (closes) => {
  const returns = [];
  for (let index = 1; index < closes.length; index += 1) {
    if (closes[index - 1] > 0 && closes[index] > 0) {
      returns.push(Math.log(closes[index] / closes[index - 1]));
    }
  }
  return returns;
};

const linearRegressionDrift = (returns) => {
  if (returns.length === 0) {
    return 0;
  }
  if (returns.length < 3) {
    return mean(returns);
  }

  const n = returns.length;
  const meanX = (n - 1) / 2;
  const meanY = mean(returns);
  let numerator = 0;
  let denominator = 0;
  for (let index = 0; index < n; index += 1) {
    numerator += (index - meanX) * (returns[index] - meanY);
    denominator += (index - meanX) ** 2;
  }

  const slope = denominator === 0 ? 0 : numerator / denominator;
  const intercept = meanY - slope * meanX;
  return intercept + slope * n;
};

const lagOneAutocorrelation = (returns) => {
  if (returns.length < 3) {
    return 0;
  }

  const lagged = returns.slice(0, -1);
  const current = returns.slice(1);
  const laggedMean = mean(lagged);
  const currentMean = mean(current);
  let numerator = 0;
  let laggedVariance = 0;
  let currentVariance = 0;
  for (let index = 0; index < current.length; index += 1) {
    const laggedDiff = lagged[index] - laggedMean;
    const currentDiff = current[index] - currentMean;
    numerator += laggedDiff * currentDiff;
    laggedVariance += laggedDiff ** 2;
    currentVariance += currentDiff ** 2;
  }

  const denominator = Math.sqrt(laggedVariance * currentVariance);
  return denominator === 0 ? 0 : clamp(numerator / denominator, -1, 1);
};

const probabilityFromLogMove = (expectedLogMove, volatility, horizon) => {
  const denominator = Math.max(volatility * Math.sqrt(horizon), 0.000001);
  return clamp(normalCdf(expectedLogMove / denominator), 0.02, 0.98);
};

const modelStatsForReturns = (returns, signalScore, options = {}) => {
  const regressionLookback = options.regressionLookback ?? 80;
  const volatilityLookback = options.volatilityLookback ?? 80;
  const recentReturns = returns.slice(-regressionLookback);
  const volatilityReturns = returns.slice(-volatilityLookback);
  const volatility = Math.max(standardDeviation(volatilityReturns), Math.abs(mean(volatilityReturns)), 0.000001);
  const driftPerBar = linearRegressionDrift(recentReturns);
  const autocorrelation = lagOneAutocorrelation(recentReturns);
  const lastReturn = recentReturns[recentReturns.length - 1] ?? 0;
  const regimeStrength = Math.min(Math.abs(autocorrelation), 1);
  const regimeReturnPerBar = autocorrelation >= 0 ? lastReturn * regimeStrength : -lastReturn * regimeStrength;
  const signalBias = clamp(signalScore / 8, -1, 1);

  return {
    volatility,
    driftPerBar,
    autocorrelation,
    regimeReturnPerBar,
    signalScore,
    signalBias,
  };
};

export const modelStatsForBars = (bars, options = {}) => {
  const closes = bars.map((bar) => bar.c);
  const returns = logReturns(closes);
  const signalScore = options.signalScore ?? scoreSignalsForBars(bars);
  return modelStatsForReturns(returns, signalScore, options);
};

const probabilitiesFromModelStats = (stats, horizon) => {
  const signal = clamp(0.5 + (stats.signalBias * 0.24) / Math.sqrt(horizon), 0.05, 0.95);
  const drift = probabilityFromLogMove(stats.driftPerBar * horizon, stats.volatility, horizon);
  const regimeHorizon = Math.min(horizon, 5);
  const regime = probabilityFromLogMove(stats.regimeReturnPerBar * regimeHorizon, stats.volatility, regimeHorizon);

  return { signal, drift, regime };
};

export const modelProbabilitiesForBars = (bars, horizon, options = {}) =>
  probabilitiesFromModelStats(modelStatsForBars(bars, options), horizon);

const createModelContext = (bars) => ({
  bars,
  closes: bars.map((bar) => bar.c),
  returns: logReturns(bars.map((bar) => bar.c)),
  signalScores: scoreSignalSeries(bars),
});

const modelProbabilitiesAt = (context, cutoff, horizon, options = {}) => {
  const returnsEnd = cutoff;
  const signalScore = context.signalScores[cutoff] ?? 0;
  const stats = modelStatsForReturns(context.returns.slice(0, returnsEnd), signalScore, options);
  return probabilitiesFromModelStats(stats, horizon);
};

export const weightedProbability = (modelProbabilities, weights = defaultModelWeights) =>
  clamp(
    adaptiveModelIds.reduce((total, modelId) => total + modelProbabilities[modelId] * weights[modelId], 0),
    0.02,
    0.98,
  );

const createEmptyPerformance = (horizons, halfLifeSamples) => ({
  halfLifeSamples,
  horizons: horizons.map((horizon) => ({
    horizon,
    models: Object.fromEntries(
      adaptiveModelIds.map((modelId) => [
        modelId,
        {
          hits: 0,
          total: 0,
          accuracy: null,
          decayedHits: 0,
          decayedTotal: 0,
          ewmaAccuracy: null,
        },
      ]),
    ),
  })),
});

const finalizePerformance = (performance) => ({
  ...performance,
  horizons: performance.horizons.map((horizonPerformance) => ({
    ...horizonPerformance,
    models: Object.fromEntries(
      adaptiveModelIds.map((modelId) => {
        const model = horizonPerformance.models[modelId];
        return [
          modelId,
          {
            ...model,
            accuracy: model.total > 0 ? model.hits / model.total : null,
            ewmaAccuracy: model.decayedTotal > 0 ? model.decayedHits / model.decayedTotal : null,
          },
        ];
      }),
    ),
  })),
});

export const computeModelPerformance = (bars, horizons = defaultPredictionHorizons, options = {}) => {
  const halfLifeSamples = options.halfLifeSamples ?? 100;
  const minTrainingBars = Math.max(options.regressionLookback ?? 80, options.volatilityLookback ?? 80, 80);
  const decay = Math.pow(0.5, 1 / halfLifeSamples);
  const performance = createEmptyPerformance(horizons, halfLifeSamples);

  if (!Array.isArray(bars) || bars.length <= minTrainingBars + 1) {
    return finalizePerformance(performance);
  }

  const lastCutoff = bars.length - 2;
  const context = createModelContext(bars);
  for (let cutoff = minTrainingBars; cutoff <= lastCutoff; cutoff += 1) {
    for (const horizonPerformance of performance.horizons) {
      const futureIndex = cutoff + horizonPerformance.horizon;
      if (futureIndex >= bars.length) {
        continue;
      }
      const probabilities = modelProbabilitiesAt(context, cutoff, horizonPerformance.horizon, options);
      const actualUp = bars[futureIndex].c > bars[cutoff].c;
      for (const modelId of adaptiveModelIds) {
        const model = horizonPerformance.models[modelId];
        const predictedUp = probabilities[modelId] >= 0.5;
        const hit = predictedUp === actualUp ? 1 : 0;
        model.hits += hit;
        model.total += 1;
        model.decayedHits = model.decayedHits * decay + hit;
        model.decayedTotal = model.decayedTotal * decay + 1;
      }
    }
  }

  return finalizePerformance(performance);
};

const normalizeWeights = (weights) => {
  const total = adaptiveModelIds.reduce((sum, modelId) => sum + (weights[modelId] ?? 0), 0);
  if (total <= 0 || !Number.isFinite(total)) {
    return { ...defaultModelWeights };
  }
  return Object.fromEntries(adaptiveModelIds.map((modelId) => [modelId, weights[modelId] / total]));
};

export const adaptiveWeights = (performance, options = {}) => {
  const temperature = options.temperature ?? 0.08;
  const minSamples = options.minSamples ?? 30;

  return {
    temperature,
    minSamples,
    horizons: performance.horizons.map((horizonPerformance) => {
      const sampleCount = Math.min(...adaptiveModelIds.map((modelId) => horizonPerformance.models[modelId].total));
      if (sampleCount < minSamples) {
        return {
          horizon: horizonPerformance.horizon,
          sampleCount,
          fallback: true,
          weights: { ...defaultModelWeights },
        };
      }

      const logits = adaptiveModelIds.map((modelId) => {
        const model = horizonPerformance.models[modelId];
        const accuracy = model.ewmaAccuracy ?? model.accuracy ?? 0.5;
        return Math.log(defaultModelWeights[modelId]) + (accuracy - 0.5) / temperature;
      });
      const maxLogit = Math.max(...logits);
      const expValues = logits.map((logit) => Math.exp(logit - maxLogit));
      const expTotal = expValues.reduce((total, value) => total + value, 0);
      const weights = normalizeWeights(
        Object.fromEntries(adaptiveModelIds.map((modelId, index) => [modelId, expValues[index] / expTotal])),
      );

      return {
        horizon: horizonPerformance.horizon,
        sampleCount,
        fallback: false,
        weights,
      };
    }),
  };
};

const monotoneBlocks = (values, weights) => {
  const blocks = values.map((value, index) => ({
    start: index,
    end: index,
    weight: weights[index],
    value,
  }));

  for (let index = 0; index < blocks.length - 1; index += 1) {
    if (blocks[index].value <= blocks[index + 1].value) {
      continue;
    }
    const weight = blocks[index].weight + blocks[index + 1].weight;
    const value =
      weight === 0
        ? (blocks[index].value + blocks[index + 1].value) / 2
        : (blocks[index].value * blocks[index].weight + blocks[index + 1].value * blocks[index + 1].weight) /
          weight;
    blocks.splice(index, 2, {
      start: blocks[index].start,
      end: blocks[index + 1].end,
      weight,
      value,
    });
    index = Math.max(-1, index - 2);
  }

  const corrected = Array.from({ length: values.length }, () => 0.5);
  for (const block of blocks) {
    for (let index = block.start; index <= block.end; index += 1) {
      corrected[index] = block.value;
    }
  }
  return corrected.map((value) => clamp(value, 0.01, 0.99));
};

export const buildCalibration = (predictions, outcomes, options = {}) => {
  const binCount = options.binCount ?? 10;
  const alpha = options.alpha ?? 2;
  const bins = Array.from({ length: binCount }, (_, index) => {
    const lower = index / binCount;
    const upper = (index + 1) / binCount;
    return {
      index,
      lower,
      upper,
      midpoint: (lower + upper) / 2,
      count: 0,
      positives: 0,
      averagePrediction: (lower + upper) / 2,
      observedFrequency: (lower + upper) / 2,
      calibratedProbability: (lower + upper) / 2,
    };
  });

  for (let index = 0; index < predictions.length; index += 1) {
    const probability = clamp(predictions[index], 0, 1);
    const binIndex = Math.min(binCount - 1, Math.floor(probability * binCount));
    const bin = bins[binIndex];
    bin.count += 1;
    bin.positives += outcomes[index] ? 1 : 0;
    bin.averagePrediction += probability;
  }

  const raw = bins.map((bin) => {
    if (bin.count === 0) {
      return bin.midpoint;
    }
    bin.averagePrediction = (bin.averagePrediction - bin.midpoint) / bin.count;
    bin.observedFrequency = (bin.positives + alpha * 0.5) / (bin.count + alpha);
    return bin.observedFrequency;
  });
  const weights = bins.map((bin) => Math.max(bin.count, 0.001));
  const corrected = monotoneBlocks(raw, weights);

  return {
    binCount,
    alpha,
    sampleCount: predictions.length,
    bins: bins.map((bin, index) => ({
      ...bin,
      calibratedProbability: corrected[index],
    })),
  };
};

export const applyCalibration = (probability, table) => {
  const value = clamp(probability, 0, 1);
  if (!table || !Array.isArray(table.bins) || table.bins.length === 0) {
    return value;
  }

  const points = table.bins.map((bin) => ({
    x: isNumber(bin.averagePrediction) ? bin.averagePrediction : bin.midpoint,
    y: clamp(bin.calibratedProbability, 0.01, 0.99),
  }));
  points.sort((a, b) => a.x - b.x);

  if (value <= points[0].x) {
    return points[0].y;
  }
  const last = points[points.length - 1];
  if (value >= last.x) {
    return last.y;
  }

  for (let index = 0; index < points.length - 1; index += 1) {
    const left = points[index];
    const right = points[index + 1];
    if (value >= left.x && value <= right.x) {
      const span = Math.max(right.x - left.x, 0.000001);
      const ratio = (value - left.x) / span;
      return clamp(left.y + (right.y - left.y) * ratio, 0.01, 0.99);
    }
  }

  return value;
};

export const weightsForHorizon = (weightsResult, horizon) =>
  weightsResult?.horizons?.find((item) => item.horizon === horizon)?.weights ?? defaultModelWeights;

export const calibrationForHorizon = (stats, horizon) =>
  stats?.calibration?.horizons?.find((item) => item.horizon === horizon)?.table ?? null;

export const collectCalibrationSamples = (bars, horizons, weightsResult, options = {}) => {
  const minTrainingBars = Math.max(options.regressionLookback ?? 80, options.volatilityLookback ?? 80, 80);
  const samples = Object.fromEntries(horizons.map((horizon) => [horizon, { predictions: [], outcomes: [] }]));
  if (!Array.isArray(bars) || bars.length <= minTrainingBars + 1) {
    return samples;
  }

  const lastCutoff = bars.length - 2;
  const context = createModelContext(bars);
  for (let cutoff = minTrainingBars; cutoff <= lastCutoff; cutoff += 1) {
    for (const horizon of horizons) {
      const futureIndex = cutoff + horizon;
      if (futureIndex >= bars.length) {
        continue;
      }
      const probabilities = modelProbabilitiesAt(context, cutoff, horizon, options);
      const probability = weightedProbability(probabilities, weightsForHorizon(weightsResult, horizon));
      samples[horizon].predictions.push(probability);
      samples[horizon].outcomes.push(bars[futureIndex].c > bars[cutoff].c);
    }
  }
  return samples;
};

export const buildAdaptiveStats = (bars, horizons = defaultPredictionHorizons, options = {}) => {
  const performance = computeModelPerformance(bars, horizons, options);
  const weights = adaptiveWeights(performance, options);
  const calibrationSamples = collectCalibrationSamples(bars, horizons, weights, options);
  const calibration = {
    horizons: horizons.map((horizon) => ({
      horizon,
      table: buildCalibration(calibrationSamples[horizon].predictions, calibrationSamples[horizon].outcomes, options),
    })),
  };
  const sampleCount = Math.max(0, ...horizons.map((horizon) => calibrationSamples[horizon].predictions.length));

  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    sampleCount,
    horizons,
    performance,
    weights,
    calibration,
  };
};
