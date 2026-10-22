import { describe, expect, it } from "vitest";

import type { CheckRunDTO, CheckRunResultDTO } from "../../shared/types";
import { runAllChecks, type CheckAllProgress } from "../src/lib/check-all";

function run(extra: Partial<CheckRunDTO> = {}): CheckRunDTO {
  return { id: 1, startedAt: 0, finishedAt: 1, trigger: "manual", by: "boss", examined: 10, ok: 8, warn: 1, dead: 1, hidden: 0, note: "", ...extra };
}

/** 假的接口：remaining 按给定序列依次返回，每次都「查了 10 个」。 */
function script(remainings: number[], runs?: Partial<CheckRunDTO>[]) {
  const calls: number[] = [];
  let i = 0;
  const call = async (olderThan: number): Promise<CheckRunResultDTO> => {
    calls.push(olderThan);
    const remaining = remainings[i] ?? 0;
    const extra = runs?.[i];
    const result: CheckRunResultDTO = { run: remaining === 0 && i >= remainings.length ? null : run(extra), remaining };
    i++;
    return result;
  };
  return { call, calls };
}

describe("runAllChecks：记下开始时刻，反复调用直到 remaining 为 0", () => {
  it("循环到 remaining 归零；每次都带同一个开始时刻；累计结果", async () => {
    const { call, calls } = script([20, 10, 0]);
    const progress: CheckAllProgress[] = [];
    const outcome = await runAllChecks({ startedAt: 123, call, shouldStop: () => false, onProgress: (p) => progress.push(p) });
    expect(calls).toEqual([123, 123, 123]);
    expect(outcome).toMatchObject({ stopped: false, remaining: 0 });
    expect(outcome.totals).toEqual({ batches: 3, examined: 30, ok: 24, warn: 3, dead: 3, hidden: 0 });
    expect(progress.map((p) => p.remaining)).toEqual([20, 10, 0]);
    expect(progress.map((p) => p.percent)).toEqual([33, 66, 100]); // 已查 / (已查 + 剩余)
  });

  it("自动隐藏的数量也累计", async () => {
    const { call } = script([10, 0], [{ hidden: 2 }, { hidden: 1 }]);
    const outcome = await runAllChecks({ startedAt: 1, call, shouldStop: () => false, onProgress: () => undefined });
    expect(outcome.totals.hidden).toBe(3);
  });

  it("run 为 null（没有可查的了）也结束，进度到 100%", async () => {
    const progress: CheckAllProgress[] = [];
    const outcome = await runAllChecks({
      startedAt: 1,
      call: async () => ({ run: null, remaining: 0 }),
      shouldStop: () => false,
      onProgress: (p) => progress.push(p),
    });
    expect(outcome).toMatchObject({ stopped: false, totals: { batches: 0, examined: 0 } });
    expect(progress.at(-1)?.percent).toBe(100);
  });

  it("各批检查记录里的备注原样带出来（带批次号），空备注不算", async () => {
    const { call } = script([20, 10, 0], [{ note: "自动隐藏 1 条" }, { note: "" }, { note: "3 个没来得及查，下一批接着查" }]);
    const progress: CheckAllProgress[] = [];
    const outcome = await runAllChecks({ startedAt: 1, call, shouldStop: () => false, onProgress: (p) => progress.push(p) });
    expect(progress.map((p) => p.notes)).toEqual([["第 1 批：自动隐藏 1 条"], ["第 1 批：自动隐藏 1 条"], ["第 1 批：自动隐藏 1 条", "第 3 批：3 个没来得及查，下一批接着查"]]);
    expect(outcome.notes).toEqual(["第 1 批：自动隐藏 1 条", "第 3 批：3 个没来得及查，下一批接着查"]);
  });

  it("点了停止：在两批之间退出，已查的累计结果保留", async () => {
    const { call, calls } = script([30, 20, 10, 0]);
    let stop = false;
    const outcome = await runAllChecks({
      startedAt: 1,
      call,
      shouldStop: () => stop,
      onProgress: (p) => {
        if (p.totals.batches === 2) stop = true;
      },
    });
    expect(calls).toHaveLength(2);
    expect(outcome.stopped).toBe(true);
    expect(outcome.totals.examined).toBe(20);
    expect(outcome.remaining).toBe(20);
  });

  it("一开始就是停止状态：一次都不调", async () => {
    const { call, calls } = script([10, 0]);
    const outcome = await runAllChecks({ startedAt: 1, call, shouldStop: () => true, onProgress: () => undefined });
    expect(calls).toHaveLength(0);
    expect(outcome.stopped).toBe(true);
  });

  it("中途出错：抛出来，之前的进度已经通过 onProgress 交出去了", async () => {
    let n = 0;
    const progress: CheckAllProgress[] = [];
    const call = async (): Promise<CheckRunResultDTO> => {
      n++;
      if (n === 3) throw new Error("Worker 超时了");
      return { run: run(), remaining: 100 - n * 10 };
    };
    await expect(runAllChecks({ startedAt: 1, call, shouldStop: () => false, onProgress: (p) => progress.push(p) })).rejects.toThrow("Worker 超时了");
    expect(progress).toHaveLength(2);
    expect(progress.at(-1)?.totals.examined).toBe(20);
  });

  it("remaining 一直不减少：连续几批没进展就停下，免得无限循环", async () => {
    let calls = 0;
    const call = async (): Promise<CheckRunResultDTO> => {
      calls++;
      return { run: run(), remaining: 50 };
    };
    await expect(runAllChecks({ startedAt: 1, call, shouldStop: () => false, onProgress: () => undefined, maxStalls: 3 })).rejects.toThrow("没有进展");
    expect(calls).toBe(4); // 第一次建立基准，之后连续 3 次没减少
  });

  it("中间 remaining 偶尔不降（别人同时在通过条目）不会误判，只要后面降了", async () => {
    const { call } = script([40, 40, 30, 20, 10, 0]);
    const outcome = await runAllChecks({ startedAt: 1, call, shouldStop: () => false, onProgress: () => undefined, maxStalls: 3 });
    expect(outcome.totals.batches).toBe(6);
  });
});
