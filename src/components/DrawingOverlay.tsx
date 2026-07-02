import type {
  IChartApi,
  ISeriesApi,
  MouseEventHandler,
  Time,
} from 'lightweight-charts';
import { useCallback, useEffect, useRef } from 'react';
import { formatPrice } from '../lib/chart-data';
import {
  calculateFibonacciLevels,
  findHitDrawing,
  snapTimeToNearestBar,
  type Drawing,
  type DrawingCoordinateMapper,
  type PixelPoint,
} from '../lib/drawings';
import type { Bar, Pair } from '../types';

export interface DrawingOverlayClick {
  barTime: number;
  price: number;
  point: PixelPoint;
  hitDrawingId: string | null;
}

interface DrawingOverlayProps {
  chart: IChartApi | null;
  series: ISeriesApi<'Candlestick'> | null;
  drawings: readonly Drawing[];
  selectedDrawingId: string | null;
  bars: readonly Bar[];
  pair: Pair;
  onChartClick: (event: DrawingOverlayClick) => void;
}

const defaultLineColor = 'rgba(89, 214, 255, 0.88)';
const selectedLineColor = '#f5ce62';
const fibonacciColor = 'rgba(32, 201, 151, 0.82)';
const labelBackground = 'rgba(11, 16, 24, 0.86)';

const isFiniteCoordinate = (value: number | null): value is number =>
  typeof value === 'number' && Number.isFinite(value);

const numericTime = (time: Time | undefined): number | null =>
  typeof time === 'number' && Number.isFinite(time) ? time : null;

const getCanvasParentSize = (canvas: HTMLCanvasElement): { width: number; height: number } => {
  const rect = canvas.parentElement?.getBoundingClientRect();
  return {
    width: Math.max(0, Math.floor(rect?.width ?? 0)),
    height: Math.max(0, Math.floor(rect?.height ?? 0)),
  };
};

const syncCanvasSize = (
  canvas: HTMLCanvasElement,
  width: number,
  height: number,
): CanvasRenderingContext2D | null => {
  const context = canvas.getContext('2d');
  if (!context) {
    return null;
  }

  const pixelRatio = window.devicePixelRatio || 1;
  const bitmapWidth = Math.max(1, Math.floor(width * pixelRatio));
  const bitmapHeight = Math.max(1, Math.floor(height * pixelRatio));
  if (canvas.width !== bitmapWidth || canvas.height !== bitmapHeight) {
    canvas.width = bitmapWidth;
    canvas.height = bitmapHeight;
  }
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
  context.clearRect(0, 0, width, height);
  return context;
};

const drawHandle = (context: CanvasRenderingContext2D, point: PixelPoint): void => {
  context.beginPath();
  context.arc(point.x, point.y, 4, 0, Math.PI * 2);
  context.fillStyle = '#10151f';
  context.fill();
  context.lineWidth = 1.5;
  context.strokeStyle = selectedLineColor;
  context.stroke();
};

const drawLabel = (
  context: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  canvasWidth: number,
): void => {
  context.font = '11px Inter, system-ui, sans-serif';
  const paddingX = 6;
  const paddingY = 4;
  const textWidth = context.measureText(text).width;
  const labelWidth = textWidth + paddingX * 2;
  const labelHeight = 20;
  const labelX = Math.min(Math.max(4, x), Math.max(4, canvasWidth - labelWidth - 4));
  const labelY = Math.max(4, y - labelHeight / 2);

  context.fillStyle = labelBackground;
  context.fillRect(labelX, labelY, labelWidth, labelHeight);
  context.strokeStyle = 'rgba(142, 155, 179, 0.28)';
  context.lineWidth = 1;
  context.strokeRect(labelX + 0.5, labelY + 0.5, labelWidth - 1, labelHeight - 1);
  context.fillStyle = '#ecf2ff';
  context.textBaseline = 'middle';
  context.fillText(text, labelX + paddingX, labelY + labelHeight / 2 + paddingY / 4);
};

export function DrawingOverlay({
  chart,
  series,
  drawings,
  selectedDrawingId,
  bars,
  pair,
  onChartClick,
}: DrawingOverlayProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const lastBarTime = bars.length > 0 ? bars[bars.length - 1].t : null;

  const coordinateMapper = useCallback((): DrawingCoordinateMapper | null => {
    if (!chart || !series) {
      return null;
    }
    return {
      timeToX: (barTime) => {
        if (lastBarTime !== null && barTime > lastBarTime) {
          return null;
        }
        const x = chart.timeScale().timeToCoordinate(barTime as Time);
        return isFiniteCoordinate(x) ? x : null;
      },
      priceToY: (price) => {
        const y = series.priceToCoordinate(price);
        return isFiniteCoordinate(y) ? y : null;
      },
    };
  }, [chart, lastBarTime, series]);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }

    const { width, height } = getCanvasParentSize(canvas);
    const context = syncCanvasSize(canvas, width, height);
    if (!context || !chart || !series || width === 0 || height === 0) {
      return;
    }

    const mapper = coordinateMapper();
    if (!mapper) {
      return;
    }

    context.save();
    context.lineCap = 'round';
    context.lineJoin = 'round';

    drawings.forEach((drawing) => {
      const selected = drawing.id === selectedDrawingId;
      const color = selected ? selectedLineColor : defaultLineColor;

      if (drawing.type === 'horizontal') {
        const y = mapper.priceToY(drawing.price);
        if (!isFiniteCoordinate(y)) {
          return;
        }
        context.beginPath();
        context.moveTo(0, y);
        context.lineTo(width, y);
        context.strokeStyle = selected ? selectedLineColor : 'rgba(245, 206, 98, 0.72)';
        context.lineWidth = selected ? 2.5 : 1.5;
        context.setLineDash(selected ? [] : [6, 5]);
        context.stroke();
        context.setLineDash([]);
        if (selected) {
          drawLabel(context, formatPrice(pair, drawing.price), width - 96, y, width);
        }
        return;
      }

      const first = {
        x: mapper.timeToX(drawing.points[0].barTime),
        y: mapper.priceToY(drawing.points[0].price),
      };
      const second = {
        x: mapper.timeToX(drawing.points[1].barTime),
        y: mapper.priceToY(drawing.points[1].price),
      };
      if (
        !isFiniteCoordinate(first.x) ||
        !isFiniteCoordinate(first.y) ||
        !isFiniteCoordinate(second.x) ||
        !isFiniteCoordinate(second.y)
      ) {
        return;
      }

      if (drawing.type === 'trendline') {
        context.beginPath();
        context.moveTo(first.x, first.y);
        context.lineTo(second.x, second.y);
        context.strokeStyle = color;
        context.lineWidth = selected ? 3 : 2;
        context.stroke();
        if (selected) {
          drawHandle(context, first as PixelPoint);
          drawHandle(context, second as PixelPoint);
        }
        return;
      }

      const fromX = Math.min(first.x, second.x);
      const toX = Math.max(first.x, second.x);
      context.beginPath();
      context.moveTo(first.x, first.y);
      context.lineTo(second.x, second.y);
      context.strokeStyle = selected ? 'rgba(245, 206, 98, 0.42)' : 'rgba(32, 201, 151, 0.28)';
      context.lineWidth = selected ? 1.5 : 1;
      context.stroke();

      calculateFibonacciLevels(drawing.points).forEach((level) => {
        const y = mapper.priceToY(level.price);
        if (!isFiniteCoordinate(y)) {
          return;
        }
        context.beginPath();
        context.moveTo(fromX, y);
        context.lineTo(toX, y);
        context.strokeStyle = selected ? selectedLineColor : fibonacciColor;
        context.lineWidth = selected ? 2 : 1.4;
        context.setLineDash(level.ratio === 0 || level.ratio === 1 ? [] : [5, 4]);
        context.stroke();
        context.setLineDash([]);
        drawLabel(context, `${level.label} ${formatPrice(pair, level.price)}`, toX + 8, y, width);
      });

      if (selected) {
        drawHandle(context, first as PixelPoint);
        drawHandle(context, second as PixelPoint);
      }
    });

    context.restore();
  }, [chart, coordinateMapper, drawings, pair, selectedDrawingId, series]);

  const scheduleDraw = useCallback(() => {
    if (animationFrameRef.current !== null) {
      window.cancelAnimationFrame(animationFrameRef.current);
    }
    animationFrameRef.current = window.requestAnimationFrame(() => {
      animationFrameRef.current = null;
      draw();
    });
  }, [draw]);

  useEffect(() => {
    scheduleDraw();
  }, [scheduleDraw]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!chart || !canvas?.parentElement) {
      return;
    }

    const parent = canvas.parentElement;
    const handleRangeChange = () => {
      scheduleDraw();
    };
    const resizeObserver = new ResizeObserver(() => {
      scheduleDraw();
    });

    resizeObserver.observe(parent);
    chart.timeScale().subscribeVisibleLogicalRangeChange(handleRangeChange);
    scheduleDraw();

    return () => {
      resizeObserver.disconnect();
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(handleRangeChange);
      if (animationFrameRef.current !== null) {
        window.cancelAnimationFrame(animationFrameRef.current);
        animationFrameRef.current = null;
      }
    };
  }, [chart, scheduleDraw]);

  useEffect(() => {
    if (!chart || !series) {
      return;
    }

    const handler: MouseEventHandler<Time> = (param) => {
      const rawTime = numericTime(param.time);
      if (!param.point || rawTime === null) {
        return;
      }

      const price = series.coordinateToPrice(param.point.y);
      const barTime = snapTimeToNearestBar(rawTime, bars);
      const mapper = coordinateMapper();
      if (price === null || barTime === null || !mapper) {
        return;
      }

      const hitDrawing = findHitDrawing(drawings, param.point, mapper, {
        tolerance: 8,
        lastBarTime,
      });

      onChartClick({
        barTime,
        price: Number(price),
        point: param.point,
        hitDrawingId: hitDrawing?.id ?? null,
      });
    };

    chart.subscribeClick(handler);
    return () => {
      chart.unsubscribeClick(handler);
    };
  }, [bars, chart, coordinateMapper, drawings, lastBarTime, onChartClick, series]);

  return <canvas ref={canvasRef} className="drawing-overlay-canvas" aria-hidden="true" />;
}
