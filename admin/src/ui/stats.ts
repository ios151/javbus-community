// 概览统计（/stats）：侧边栏的「待审 / 举报」徽章和概览页共用一份。
// 只在「切页面」和「处理完条目 / 举报」时刷新，不用定时器轮询。

import type { StatsDTO } from "../../../shared/types";
import { api } from "../api";
import { createStore } from "./store";

export interface StatsState {
  data?: StatsDTO;
  error?: unknown;
  loading: boolean;
}

export const statsStore = createStore<StatsState>({ loading: false });

let latest = 0;

export async function refreshStats(): Promise<void> {
  const id = ++latest;
  statsStore.set((s) => ({ ...s, error: undefined, loading: true }));
  try {
    const data = await api.stats();
    if (id === latest) statsStore.set({ data, loading: false });
  } catch (error) {
    if (id === latest) statsStore.set((s) => ({ ...s, error, loading: false }));
  }
}

/** 退出登录时清掉，免得下一个人看到上一个人的数字。 */
export function clearStats(): void {
  latest++;
  statsStore.set({ loading: false });
}

/** 待审条目总数（两个频道）。 */
export function pendingTotal(stats: StatsDTO): number {
  return stats.channels.user.pending + stats.channels.author.pending;
}
