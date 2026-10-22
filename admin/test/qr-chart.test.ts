// 二维码点阵 / 横条合并，和概览柱状图的布局计算。

import { describe, expect, it } from "vitest";

import { chartLayout, niceMax } from "../src/lib/chart";
import { darkRuns, qrMatrix } from "../src/lib/qr";

describe("qrMatrix / darkRuns", () => {
  it("点阵是方阵；短文本是第 1 版（21×21）", () => {
    const matrix = qrMatrix("hello");
    expect(matrix).toHaveLength(21);
    expect(matrix.every((row) => row.length === 21)).toBe(true);
  });

  it("三个角上有 7×7 的定位图案（外圈全黑、次外圈全白、中心 3×3 全黑）", () => {
    const matrix = qrMatrix("otpauth://totp/Test:alice?secret=JBSWY3DPEHPK3PXP&issuer=Test");
    const n = matrix.length;
    for (const [r0, c0] of [
      [0, 0],
      [0, n - 7],
      [n - 7, 0],
    ] as const) {
      for (let i = 0; i < 7; i++) {
        expect(matrix[r0]?.[c0 + i], `上边 ${i}`).toBe(true);
        expect(matrix[r0 + 6]?.[c0 + i], `下边 ${i}`).toBe(true);
        expect(matrix[r0 + i]?.[c0], `左边 ${i}`).toBe(true);
        expect(matrix[r0 + i]?.[c0 + 6], `右边 ${i}`).toBe(true);
      }
      expect(matrix[r0 + 1]?.[c0 + 1]).toBe(false);
      expect(matrix[r0 + 3]?.[c0 + 3]).toBe(true);
    }
  });

  it("内容越长版本越高、点阵越大；同样的内容每次结果一样", () => {
    const short = qrMatrix("a");
    const long = qrMatrix("otpauth://totp/".concat("x".repeat(120)));
    expect(long.length).toBeGreaterThan(short.length);
    expect(qrMatrix("same text")).toEqual(qrMatrix("same text"));
  });

  it("超出 Latin-1 的文字不会被截坏（先做百分号编码）：不抛错，结果和编码后的 ASCII 一样", () => {
    expect(qrMatrix("站点:老王")).toEqual(qrMatrix(encodeURI("站点:老王")));
  });

  it("darkRuns：每行连续的深色模块合并成一条", () => {
    expect(
      darkRuns([
        [true, true, false, true],
        [false, false, false, false],
        [true, true, true, true],
      ]),
    ).toEqual([
      { x: 0, y: 0, w: 2 },
      { x: 3, y: 0, w: 1 },
      { x: 0, y: 2, w: 4 },
    ]);
    expect(darkRuns([])).toEqual([]);
  });

  it("横条重新铺出来和原点阵完全一致", () => {
    const matrix = qrMatrix("otpauth://totp/Test:alice?secret=JBSWY3DPEHPK3PXP");
    const rebuilt = matrix.map((row) => row.map(() => false));
    for (const run of darkRuns(matrix)) for (let i = 0; i < run.w; i++) (rebuilt[run.y] as boolean[])[run.x + i] = true;
    expect(rebuilt).toEqual(matrix);
  });
});

describe("niceMax：纵轴上限取整到好看的刻度", () => {
  it("全 0 / 很小给固定的 4", () => {
    expect(niceMax(0)).toBe(4);
    expect(niceMax(3)).toBe(4);
    expect(niceMax(4)).toBe(4);
    expect(niceMax(Number.NaN)).toBe(4);
  });

  it("向上取整到 1 / 2 / 2.5 / 5 / 10 × 10 的幂", () => {
    expect(niceMax(5)).toBe(5);
    expect(niceMax(7)).toBe(10);
    expect(niceMax(11)).toBe(20);
    expect(niceMax(23)).toBe(25);
    expect(niceMax(26)).toBe(50);
    expect(niceMax(120)).toBe(200);
    expect(niceMax(1000)).toBe(1000);
  });

  it("上限永远 ≥ 最大值", () => {
    for (let v = 1; v < 3000; v += 7) expect(niceMax(v)).toBeGreaterThanOrEqual(v);
  });
});

describe("chartLayout", () => {
  const padding = { left: 30, right: 10, top: 10, bottom: 20 };

  it("每个值一根柱子，高度和值成正比，最高的柱子贴着绘图区顶端的刻度", () => {
    const layout = chartLayout([0, 5, 10], 340, 130, padding); // 绘图区 300 × 100，niceMax(10) = 10
    expect(layout.max).toBe(10);
    expect(layout.bars).toHaveLength(3);
    expect(layout.bars.map((b) => b.height)).toEqual([0, 50, 100]);
    expect(layout.bars[2]?.y).toBe(10); // top
    expect(layout.bars.every((b) => b.y + b.height === 110)).toBe(true); // 柱子底边都在基线上
    expect(layout.slot).toBe(100);
  });

  it("柱子在各自的槽里居中，互不重叠、都在绘图区内", () => {
    const layout = chartLayout(Array.from({ length: 30 }, (_, i) => i), 600, 190, padding);
    for (let i = 0; i < layout.bars.length; i++) {
      const bar = layout.bars[i];
      if (!bar) throw new Error("缺柱子");
      expect(bar.x).toBeGreaterThanOrEqual(layout.plot.left);
      expect(bar.x + bar.width).toBeLessThanOrEqual(layout.plot.left + layout.plot.width + 0.0001);
      const next = layout.bars[i + 1];
      if (next) expect(bar.x + bar.width).toBeLessThan(next.x);
    }
  });

  it("三条刻度：0、一半、上限", () => {
    const layout = chartLayout([3, 8], 200, 120, padding);
    expect(layout.ticks.map((t) => t.value)).toEqual([0, 5, 10]);
    expect(layout.ticks[0]?.y).toBeGreaterThan(layout.ticks[2]?.y ?? 0);
  });

  it("全是 0：不除零，柱子高度都是 0", () => {
    const layout = chartLayout([0, 0, 0], 200, 120, padding);
    expect(layout.bars.every((b) => b.height === 0)).toBe(true);
    expect(layout.max).toBe(4);
  });

  it("没有数据 / 容器很窄：不出现 NaN 或负宽度", () => {
    expect(chartLayout([], 200, 120, padding).bars).toEqual([]);
    const narrow = chartLayout([1, 2, 3], 10, 10, padding);
    expect(narrow.bars.every((b) => Number.isFinite(b.x) && Number.isFinite(b.y) && b.width > 0 && b.height >= 0)).toBe(true);
  });
});
