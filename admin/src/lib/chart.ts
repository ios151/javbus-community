// 概览页「最近 30 天每天新增」柱状图的布局计算（手写 SVG 用）：纯函数，给宽高和数据，返回每根柱子和刻度的坐标。

/** 把最大值向上取整到好看的刻度上限：7 → 10，23 → 25，120 → 150。 */
export function niceMax(max: number): number {
  if (!Number.isFinite(max) || max <= 0) return 4; // 全是 0 时给个固定的纵轴，别画成一条线
  if (max <= 4) return 4;
  const magnitude = 10 ** Math.floor(Math.log10(max));
  for (const step of [1, 2, 2.5, 5, 10]) {
    const candidate = step * magnitude;
    if (max <= candidate) return candidate;
  }
  return 10 * magnitude;
}

export interface Bar {
  index: number;
  x: number;
  y: number;
  width: number;
  height: number;
  value: number;
}

export interface Tick {
  value: number;
  y: number;
}

export interface ChartLayout {
  bars: Bar[];
  ticks: Tick[];
  max: number;
  /** 绘图区（柱子所在的矩形）。 */
  plot: { left: number; top: number; width: number; height: number };
  /** 每根柱子占的横向槽宽。 */
  slot: number;
}

export interface ChartPadding {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export const DEFAULT_PADDING: ChartPadding = { left: 34, right: 8, top: 10, bottom: 22 };

export function chartLayout(values: readonly number[], width: number, height: number, padding: ChartPadding = DEFAULT_PADDING): ChartLayout {
  const plotWidth = Math.max(1, width - padding.left - padding.right);
  const plotHeight = Math.max(1, height - padding.top - padding.bottom);
  const max = niceMax(Math.max(0, ...values));
  const slot = values.length > 0 ? plotWidth / values.length : plotWidth;
  const barWidth = Math.max(1, slot * 0.68);
  const bars = values.map((value, index): Bar => {
    const h = (Math.max(0, value) / max) * plotHeight;
    return {
      index,
      x: padding.left + slot * index + (slot - barWidth) / 2,
      y: padding.top + plotHeight - h,
      width: barWidth,
      height: h,
      value,
    };
  });
  const ticks: Tick[] = [0, 0.5, 1].map((fraction) => ({
    value: Math.round(max * fraction * 100) / 100,
    y: padding.top + plotHeight - plotHeight * fraction,
  }));
  return { bars, ticks, max, plot: { left: padding.left, top: padding.top, width: plotWidth, height: plotHeight }, slot };
}
