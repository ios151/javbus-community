// 举报按条目分组：接口返回的是一条条举报，处理时要的是「这个条目被几个人、因为什么举报了」。
// 同一个条目的多条举报合并成一组，各原因计数、举报人数、详情文字都在这里算好。

import { REPORT_REASONS, type Channel, type ItemStatus, type ReportDTO, type ReportReason } from "../../../shared/types";

export interface ReportDetail {
  id: number;
  reason: ReportReason;
  text: string;
  at: number;
}

export interface ReportGroup {
  itemId: number;
  code: string;
  channel: Channel;
  itemStatus: ItemStatus;
  info: string;
  src: string;
  /** 举报人数（按举报者的 IP 去重，IPv6 按 /64；和条目上的举报数同一个口径）。 */
  reporters: number;
  /** 各原因的举报数，多的在前；同数按 REPORT_REASONS 的顺序。 */
  reasons: { reason: ReportReason; count: number }[];
  /** 填了详情文字的举报，新的在前。 */
  details: ReportDetail[];
  firstAt: number;
  latestAt: number;
}

interface Draft {
  group: ReportGroup;
  reporters: Set<string>;
  counts: Map<ReportReason, number>;
}

/** 分组并排序：举报人数多的在前，同数的最近被举报的在前。 */
export function groupReports(reports: readonly ReportDTO[]): ReportGroup[] {
  const drafts = new Map<number, Draft>();
  for (const report of reports) {
    let draft = drafts.get(report.itemId);
    if (!draft) {
      draft = {
        group: {
          itemId: report.itemId,
          code: report.code,
          channel: report.channel,
          itemStatus: report.itemStatus,
          info: report.info,
          src: report.src,
          reporters: 0,
          reasons: [],
          details: [],
          firstAt: report.createdAt,
          latestAt: report.createdAt,
        },
        reporters: new Set(),
        counts: new Map(),
      };
      drafts.set(report.itemId, draft);
    }
    // 按 IP 去重：和后端的「举报数」同一个口径（设备号是 App 自己报的，一个人换几个设备号不算多个人）
    draft.reporters.add(report.ipHash || report.reporter);
    draft.counts.set(report.reason, (draft.counts.get(report.reason) ?? 0) + 1);
    const text = report.detail.trim();
    if (text) draft.group.details.push({ id: report.id, reason: report.reason, text, at: report.createdAt });
    draft.group.firstAt = Math.min(draft.group.firstAt, report.createdAt);
    draft.group.latestAt = Math.max(draft.group.latestAt, report.createdAt);
  }

  const order = (reason: ReportReason): number => REPORT_REASONS.indexOf(reason);
  const groups = [...drafts.values()].map(({ group, reporters, counts }): ReportGroup => ({
    ...group,
    reporters: reporters.size,
    reasons: [...counts.entries()]
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count || order(a.reason) - order(b.reason)),
    details: [...group.details].sort((a, b) => b.at - a.at || b.id - a.id),
  }));
  return groups.sort((a, b) => b.reporters - a.reporters || b.latestAt - a.latestAt || b.itemId - a.itemId);
}
