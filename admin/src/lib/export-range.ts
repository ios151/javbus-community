// 导出页的小逻辑：按「列表 / 状态」算这次大概会导出多少条（用概览统计里已有的数字），超过单次上限就提前提醒。
// 服务端单次最多导出 6000 条，超出的部分不会进文件（文件里会标 truncated: true）——要按频道 / 状态分开导。

import { CHANNELS, ITEM_STATUSES, type Channel, type ItemStatus, type StatsDTO } from "../../../shared/types";

/** GET /export 单次最多返回的条数（docs/api.md）。 */
export const EXPORT_LIMIT = 6000;

/** 选定的范围里一共有多少条（不选 = 全部）。 */
export function exportCount(channels: StatsDTO["channels"], channel?: Channel, status?: ItemStatus): number {
  let total = 0;
  for (const c of channel ? [channel] : CHANNELS) {
    for (const s of status ? [status] : ITEM_STATUSES) total += channels[c][s];
  }
  return total;
}

export function willBeTruncated(count: number): boolean {
  return count > EXPORT_LIMIT;
}
