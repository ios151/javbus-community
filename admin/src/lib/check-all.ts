// 「全部检查」的循环：记下开始时刻，反复调 { olderThan: 开始时刻 }，直到没有可查的或 remaining 为 0。
// 一批一批接力，是因为免费版 Worker 一次调用最多 50 个子请求，一批只能查几个条目。

import type { CheckRunResultDTO } from "../../../shared/types";

export interface CheckTotals {
  /** 已经跑了几批。 */
  batches: number;
  examined: number;
  ok: number;
  warn: number;
  dead: number;
  hidden: number;
}

export function emptyCheckTotals(): CheckTotals {
  return { batches: 0, examined: 0, ok: 0, warn: 0, dead: 0, hidden: 0 };
}

export interface CheckAllProgress {
  totals: CheckTotals;
  /** 这一轮还剩多少个没查。 */
  remaining: number;
  /** 0–100。总数是边跑边知道的：已查 /（已查 + 剩余）。 */
  percent: number;
  /** 各批检查记录里带的备注（「自动隐藏 N 条」「整批几乎都失效…」「N 个没来得及查…」），原样带上批次号。 */
  notes: string[];
}

export interface CheckAllDeps {
  /** 开始时刻（毫秒时间戳）：只查「这个时刻之后还没查过」的，查完一轮自然结束。 */
  startedAt: number;
  call: (olderThan: number) => Promise<CheckRunResultDTO>;
  shouldStop: () => boolean;
  onProgress: (progress: CheckAllProgress) => void;
  /** 连续这么多批 remaining 没减少就认为卡住了，避免无限循环。 */
  maxStalls?: number;
}

export interface CheckAllOutcome {
  totals: CheckTotals;
  remaining: number;
  /** 用户点了停止。 */
  stopped: boolean;
  notes: string[];
}

export async function runAllChecks(deps: CheckAllDeps): Promise<CheckAllOutcome> {
  const maxStalls = deps.maxStalls ?? 5;
  const totals = emptyCheckTotals();
  const notes: string[] = [];
  let remaining = Number.POSITIVE_INFINITY;
  let stalls = 0;

  for (;;) {
    if (deps.shouldStop()) return { totals, remaining: Number.isFinite(remaining) ? remaining : 0, stopped: true, notes };
    const result = await deps.call(deps.startedAt);
    if (result.run) {
      totals.batches++;
      totals.examined += result.run.examined;
      totals.ok += result.run.ok;
      totals.warn += result.run.warn;
      totals.dead += result.run.dead;
      totals.hidden += result.run.hidden;
      if (result.run.note.trim()) notes.push(`第 ${totals.batches} 批：${result.run.note.trim()}`);
    }
    stalls = result.remaining >= remaining ? stalls + 1 : 0;
    remaining = result.remaining;
    const finished = result.run === null || remaining === 0;
    const total = totals.examined + (finished ? 0 : remaining);
    deps.onProgress({
      totals: { ...totals },
      remaining: finished ? 0 : remaining,
      percent: finished ? 100 : total > 0 ? Math.floor((totals.examined / total) * 100) : 0,
      notes: [...notes],
    });
    if (finished) return { totals, remaining: 0, stopped: false, notes };
    if (stalls >= maxStalls) throw new Error(`连续 ${maxStalls} 批都没有进展（还剩 ${remaining} 个没查），先停下了，稍后再试`);
  }
}
