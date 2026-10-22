import { describe, expect, it } from "vitest";

import type { ImportResultDTO } from "../../shared/types";
import {
  IMPORT_BASE_MAX_AGE_MS,
  IMPORT_BATCH_SIZE,
  addResult,
  canResumeImport,
  emptyTotals,
  parseImportFile,
  planImport,
  runImport,
  summarizeFile,
  type ImportBatch,
  type ImportOrder,
} from "../src/lib/import-plan";

function entries(n: number, extra: (i: number) => Record<string, unknown> = () => ({})): Record<string, unknown>[] {
  return Array.from({ length: n }, (_, i) => ({ code: `ABC-${String(i).padStart(4, "0")}`, link: `https://example.com/${i}`, ...extra(i) }));
}

describe("parseImportFile", () => {
  it("直接是数组（原作者的列表）", () => {
    const parsed = parseImportFile(JSON.stringify(entries(3)));
    expect(parsed).toMatchObject({ ok: true, file: { format: "array" } });
    if (parsed.ok) expect(parsed.file.items).toHaveLength(3);
  });

  it("本站导出的 { app, items }", () => {
    const parsed = parseImportFile(JSON.stringify({ app: "javbus-community", version: "1.0.0", items: entries(2) }));
    expect(parsed).toMatchObject({ ok: true, file: { format: "export" } });
  });

  it("本站导出的文件标了 truncated: true（超过单次上限被截断）要能看出来；没标就是 false", () => {
    const truncated = parseImportFile(JSON.stringify({ app: "javbus-community", truncated: true, items: entries(1) }));
    expect(truncated.ok && truncated.file.truncated).toBe(true);
    const normal = parseImportFile(JSON.stringify({ app: "javbus-community", truncated: false, items: entries(1) }));
    expect(normal.ok && normal.file.truncated).toBe(false);
    const array = parseImportFile(JSON.stringify(entries(1)));
    expect(array.ok && array.file.truncated).toBe(false);
    const old = parseImportFile(JSON.stringify({ items: entries(1) }));
    expect(old.ok && old.file.truncated).toBe(false);
  });

  it("不是 JSON / 没有列表 / 空列表 → 给出原因", () => {
    expect(parseImportFile("不是 json")).toEqual({ ok: false, error: "这不是合法的 JSON 文件" });
    expect(parseImportFile(JSON.stringify({ foo: 1 }))).toMatchObject({ ok: false });
    expect(parseImportFile(JSON.stringify("字符串"))).toMatchObject({ ok: false });
    expect(parseImportFile("[]")).toEqual({ ok: false, error: "文件里没有任何条目" });
    expect(parseImportFile(JSON.stringify({ items: [] }))).toEqual({ ok: false, error: "文件里没有任何条目" });
  });

  it("条目是否合格不在这里判断：非对象的条目也原样带上，交给服务端计入「不合格」", () => {
    const parsed = parseImportFile(JSON.stringify([{ code: "A-1" }, "垃圾", null, 5]));
    expect(parsed.ok && parsed.file.items).toHaveLength(4);
  });
});

describe("summarizeFile", () => {
  it("统计频道和状态", () => {
    const summary = summarizeFile([
      { channel: "user", status: "approved" },
      { channel: "user", status: "hidden" },
      { channel: "author", status: "approved" },
      { channel: "nope" },
      "垃圾",
    ]);
    expect(summary).toEqual({ total: 5, byChannel: { user: 2, author: 1 }, noChannel: 2, byStatus: { approved: 2, hidden: 1 }, hasStatus: true });
  });

  it("原作者的列表没有 channel 和 status", () => {
    const summary = summarizeFile(entries(3));
    expect(summary).toMatchObject({ total: 3, noChannel: 3, hasStatus: false, byStatus: {} });
  });
});

describe("planImport：每 500 条一批，每批带自己的 offset", () => {
  it("1200 条 → 3 批（500 / 500 / 200），offset 是这一批前面有多少条，顺序和文件一致", () => {
    const plan = planImport(entries(1200), { channel: "author", status: "approved", onlyLive: false });
    expect(IMPORT_BATCH_SIZE).toBe(500);
    expect(plan.batches.map((b) => b.items.length)).toEqual([500, 500, 200]);
    expect(plan.batches.map((b) => b.offset)).toEqual([0, 500, 1000]);
    expect(plan.batches.every((b) => b.channel === "author" && b.status === "approved")).toBe(true);
    expect(plan.selected).toBe(1200);
    // 每批里的条目保持文件顺序
    expect((plan.batches[1]?.items[0] as { code: string }).code).toBe("ABC-0500");
    expect(plan.batches[2]?.positions[0]).toBe(1000);
  });

  it("刚好 500 条是一批；1 条也是一批；恰好整除不会多出空批", () => {
    expect(planImport(entries(500), { channel: "user", status: "approved", onlyLive: false }).batches).toHaveLength(1);
    expect(planImport(entries(1), { channel: "user", status: "approved", onlyLive: false }).batches).toHaveLength(1);
    expect(planImport(entries(1000), { channel: "user", status: "approved", onlyLive: false }).batches).toHaveLength(2);
  });

  it("可以改批大小", () => {
    const plan = planImport(entries(10), { channel: "user", status: "pending", onlyLive: false, batchSize: 4 });
    expect(plan.batches.map((b) => [b.items.length, b.offset])).toEqual([
      [4, 0],
      [4, 4],
      [2, 8],
    ]);
    expect(plan.batches.every((b) => b.status === "pending")).toBe(true);
  });

  it("按文件里的频道：每份列表各自切批，offset 各自从 0 起算（两份列表互不影响）", () => {
    const items = entries(7, (i) => ({ channel: i % 2 === 0 ? "user" : "author" })); // user: 0,2,4,6  author: 1,3,5
    const plan = planImport(items, { channel: "file", status: "approved", onlyLive: false, batchSize: 3 });
    expect(plan.byChannel).toEqual({ user: 4, author: 3 });
    expect(plan.batches.map((b) => [b.channel, b.items.length, b.offset])).toEqual([
      ["user", 3, 0],
      ["user", 1, 3],
      ["author", 3, 0],
    ]);
    expect(plan.batches[0]?.positions).toEqual([0, 2, 4]); // 在原文件里的下标
  });

  it("按文件里的频道时，没标频道的忽略并计数", () => {
    const plan = planImport([{ code: "A-1", channel: "user" }, { code: "B-2" }, "垃圾"], { channel: "file", status: "approved", onlyLive: false });
    expect(plan.selected).toBe(1);
    expect(plan.unassigned).toBe(2);
  });

  it("只导入已上线的：状态是隐藏 / 拒绝 / 待审的跳过；没有状态字段的照常导入", () => {
    const items = [
      { code: "A-1", status: "approved" },
      { code: "B-2", status: "hidden" },
      { code: "C-3", status: "rejected" },
      { code: "D-4", status: "pending" },
      { code: "E-5" },
    ];
    const plan = planImport(items, { channel: "user", status: "approved", onlyLive: true });
    expect(plan.selected).toBe(2);
    expect(plan.skippedNotLive).toBe(3);
    expect(plan.batches[0]?.positions).toEqual([0, 4]);
    expect(planImport(items, { channel: "user", status: "approved", onlyLive: false }).selected).toBe(5);
  });

  it("全被过滤掉 = 没有批次", () => {
    expect(planImport([{ code: "A", status: "hidden" }], { channel: "user", status: "approved", onlyLive: true }).batches).toEqual([]);
  });
});

describe("addResult：累计结果，样例的下标换算回文件里的位置", () => {
  const batch: ImportBatch = { channel: "user", status: "approved", items: [], offset: 500, positions: [500, 501, 503, 507] };

  it("数字累加，不改原对象", () => {
    const before = emptyTotals();
    const result: ImportResultDTO = { received: 4, inserted: 2, skipped: 1, invalid: 1, samples: [{ index: 2, reason: "番号格式不对" }] };
    const after = addResult(before, result, batch);
    expect(after).toMatchObject({ received: 4, inserted: 2, skipped: 1, invalid: 1 });
    expect(before).toEqual(emptyTotals());
    expect(addResult(after, result, batch)).toMatchObject({ received: 8, inserted: 4, skipped: 2, invalid: 2 });
  });

  it("样例位置 = 原文件里的第几条（1 起），而不是批内下标", () => {
    const result: ImportResultDTO = { received: 4, inserted: 2, skipped: 0, invalid: 2, samples: [{ index: 2, reason: "a" }, { index: 3, reason: "b" }] };
    expect(addResult(emptyTotals(), result, batch).samples).toEqual([
      { position: 504, reason: "a" },
      { position: 508, reason: "b" },
    ]);
  });

  it("样例最多留 10 个", () => {
    const many: ImportResultDTO["samples"] = Array.from({ length: 10 }, (_, i) => ({ index: 0, reason: `r${i}` }));
    const result: ImportResultDTO = { received: 10, inserted: 0, skipped: 0, invalid: 10, samples: many };
    const twice = addResult(addResult(emptyTotals(), result, batch), result, batch);
    expect(twice.samples).toHaveLength(10);
  });
});

describe("runImport：整个导入共用同一个 base，每批带自己的 offset", () => {
  function fakeSend(log: { channel: string; offset: number; base: number; size: number }[]) {
    return async (batch: ImportBatch, order: ImportOrder): Promise<ImportResultDTO> => {
      log.push({ channel: batch.channel, offset: order.offset, base: order.base, size: batch.items.length });
      return { received: batch.items.length, inserted: batch.items.length, skipped: 0, invalid: 0, samples: [] };
    };
  }

  it("切批后每批的 offset 对，base 全程一样（就是传进去的那个）", async () => {
    const plan = planImport(entries(1200), { channel: "user", status: "approved", onlyLive: false });
    const base = 1_790_000_000_000;
    const log: { channel: string; offset: number; base: number; size: number }[] = [];
    const progress: number[] = [];
    const outcome = await runImport(plan.batches, {
      base,
      send: fakeSend(log),
      shouldStop: () => false,
      onProgress: (p) => progress.push(p.done),
    });
    expect(outcome).toEqual({ stopped: false });
    expect(log.map((l) => l.offset)).toEqual([0, 500, 1000]);
    expect(new Set(log.map((l) => l.base))).toEqual(new Set([base]));
    expect(log.map((l) => l.size)).toEqual([500, 500, 200]);
    expect(progress).toEqual([0, 1, 2, 3]);
  });

  it("相邻两批的时间区间不重叠：服务端 created_at = base - offset - 下标，前一批最小值 > 后一批最大值", () => {
    const plan = planImport(entries(1200), { channel: "user", status: "approved", onlyLive: false });
    const base = 1_790_000_000_000;
    const range = (b: ImportBatch) => ({ max: base - b.offset, min: base - b.offset - (b.items.length - 1) });
    for (let i = 0; i + 1 < plan.batches.length; i++) {
      const a = plan.batches[i];
      const b = plan.batches[i + 1];
      if (!a || !b) throw new Error("批次不够");
      expect(range(a).min).toBeGreaterThan(range(b).max);
    }
  });

  it("累计 totals 随进度交出去", async () => {
    const plan = planImport(entries(1000), { channel: "user", status: "approved", onlyLive: false });
    let last = emptyTotals();
    await runImport(plan.batches, { base: 1, send: fakeSend([]), shouldStop: () => false, onProgress: (p) => (last = p.totals) });
    expect(last).toMatchObject({ received: 1000, inserted: 1000 });
  });

  it("某一批出错：抛出来，前面完成的进度已经交出去了；续导沿用同一个 base、从出错的那批开始", async () => {
    const plan = planImport(entries(1500), { channel: "user", status: "approved", onlyLive: false });
    const base = 1_790_000_000_000;
    const log: { channel: string; offset: number; base: number; size: number }[] = [];
    let state = { done: 0, totals: emptyTotals() };
    let fail = true;
    const deps = {
      base,
      send: async (batch: ImportBatch, order: ImportOrder) => {
        if (fail && order.offset === 500) throw new Error("网络断了");
        return fakeSend(log)(batch, order);
      },
      shouldStop: () => false,
      onProgress: (p: { done: number; totals: typeof state.totals }) => (state = { done: p.done, totals: p.totals }),
    };
    await expect(runImport(plan.batches, deps)).rejects.toThrow("网络断了");
    expect(state.done).toBe(1);
    expect(state.totals.received).toBe(500);

    fail = false;
    await runImport(plan.batches, { ...deps, startIndex: state.done, totals: state.totals });
    expect(log.map((l) => l.offset)).toEqual([0, 500, 1000]); // 第 0 批只发过一次，续导从第 1 批开始
    expect(new Set(log.map((l) => l.base))).toEqual(new Set([base]));
    expect(state.done).toBe(3);
    expect(state.totals.received).toBe(1500);
  });

  it("要求停止：在两批之间退出，已发的不回滚", async () => {
    const plan = planImport(entries(1500), { channel: "user", status: "approved", onlyLive: false });
    const log: { channel: string; offset: number; base: number; size: number }[] = [];
    let stop = false;
    const outcome = await runImport(plan.batches, {
      base: 1,
      send: async (batch, order) => {
        const result = await fakeSend(log)(batch, order);
        stop = true; // 第一批发完就点了「停止」
        return result;
      },
      shouldStop: () => stop,
      onProgress: () => undefined,
    });
    expect(outcome).toEqual({ stopped: true });
    expect(log).toHaveLength(1);
  });

  it("两份列表（按文件里的频道）共用同一个 base", async () => {
    const items = entries(1200, (i) => ({ channel: i < 700 ? "user" : "author" }));
    const plan = planImport(items, { channel: "file", status: "approved", onlyLive: false });
    const log: { channel: string; offset: number; base: number; size: number }[] = [];
    await runImport(plan.batches, { base: 42, send: fakeSend(log), shouldStop: () => false, onProgress: () => undefined });
    expect(log.map((l) => [l.channel, l.offset, l.base])).toEqual([
      ["user", 0, 42],
      ["user", 500, 42],
      ["author", 0, 42],
    ]);
  });
});

describe("canResumeImport：base 不能超过一天，不然服务端不收", () => {
  it("23 小时内能续，超过不能", () => {
    expect(canResumeImport(1_000, 1_000 + 3_600_000)).toBe(true);
    expect(canResumeImport(1_000, 1_000 + IMPORT_BASE_MAX_AGE_MS - 1)).toBe(true);
    expect(canResumeImport(1_000, 1_000 + IMPORT_BASE_MAX_AGE_MS)).toBe(false);
  });
});
