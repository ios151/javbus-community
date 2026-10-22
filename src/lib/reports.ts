// 举报：App 里提交，维护者在后台处理。
//
// items.report_count = 这个条目当前「未处理」的举报数（不同的人各算一次，库里有唯一索引）。
// 数量到了设置里的阈值就自动隐藏、进待复核（hidden_reason = reports）；维护者驳回举报 = 恢复上线。

import type { Channel, ItemStatus, Paged, ReportDTO, ReportReason, ReportStatus, Settings } from "../../shared/types";
import { auditStatement, type AuditEntry } from "./audit";
import { deleteItems, hasRoom, setStatus } from "./items";
import { rebuildSnapshotStatement } from "./snapshot";
import { HttpError } from "./util";

export type ReportOutcome = "recorded" | "duplicate";

export interface NewReport {
  itemId: number;
  channel: Channel;
  code: string;
  reason: ReportReason;
  detail: string;
  /** 设备号哈希；没带设备号时是 IP 哈希。 */
  reporter: string;
  ipHash: string;
}

export async function createReport(
  db: D1Database,
  input: NewReport,
  settings: Pick<Settings, "reportAutoHide">,
  now: number,
): Promise<ReportOutcome> {
  const [insert, , hide] = await db.batch([
    db
      .prepare("INSERT OR IGNORE INTO reports (item_id, reason, detail, reporter, ip_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(input.itemId, input.reason, input.detail, input.reporter, input.ipHash, now),
    // 举报数 = 没处理的举报里「不同的 IP」有几个，而不是几条：设备号是 App 自己报的、谁都能编，
    // 一个人换三个设备号就是三条举报；IP 是 Cloudflare 边缘写的（IPv6 已按 /64 归并），一个人编不出来
    db
      .prepare("UPDATE items SET report_count = (SELECT COUNT(DISTINCT ip_hash) FROM reports WHERE item_id = ?1 AND status = 'open') WHERE id = ?1")
      .bind(input.itemId),
    // 作者精选不自动隐藏：它是维护者挑的，不该被匿名举报直接下架——举报照常进待复核、举报数照常显示
    db
      .prepare(
        `UPDATE items SET status = 'hidden', hidden_reason = 'reports', updated_at = ?2
         WHERE id = ?1 AND status = 'approved' AND channel = 'user' AND ?3 > 0 AND report_count >= ?3`,
      )
      .bind(input.itemId, now, settings.reportAutoHide),
  ]);
  // 先看有没有自动隐藏、再决定返回什么：老举报人重复举报（或阈值刚调小）也可能让条目过线，这时同样要重建快照
  if ((hide?.meta.changes ?? 0) > 0) {
    // 自动隐藏了：重建快照 + 记一笔（两步不在同一个事务里，万一中断，每天凌晨的清理会补重建）
    await db.batch([
      rebuildSnapshotStatement(db, input.channel, now),
      auditStatement(
        db,
        {
          actor: "system",
          action: "item.auto_hide_reports",
          targetType: "item",
          targetId: input.code,
          detail: { channel: input.channel, threshold: settings.reportAutoHide },
        },
        now,
      ),
    ]);
  }
  return (insert?.meta.changes ?? 0) === 0 ? "duplicate" : "recorded";
}

interface ReportRow {
  id: number;
  item_id: number;
  reason: ReportReason;
  detail: string;
  reporter: string;
  ip_hash: string;
  created_at: number;
  status: ReportStatus;
  resolved_at: number | null;
  resolution: string;
  resolved_by_name: string | null;
  code: string;
  channel: Channel;
  item_status: ItemStatus;
  info: string;
  src: string;
}

export async function listReports(
  db: D1Database,
  query: { status?: ReportStatus; page: number; pageSize: number },
): Promise<Paged<ReportDTO>> {
  const clause = query.status ? "WHERE r.status = ?" : "";
  const params = query.status ? [query.status] : [];
  const [rows, total] = await db.batch([
    db
      .prepare(
        `SELECT r.id, r.item_id, r.reason, r.detail, r.reporter, r.ip_hash, r.created_at, r.status, r.resolved_at, r.resolution,
                u.name AS resolved_by_name, i.code, i.channel, i.status AS item_status, i.info, i.src
         FROM reports r
         JOIN items i ON i.id = r.item_id
         LEFT JOIN users u ON u.id = r.resolved_by
         ${clause}
         ORDER BY r.created_at DESC, r.id DESC LIMIT ? OFFSET ?`,
      )
      .bind(...params, query.pageSize, (query.page - 1) * query.pageSize),
    db.prepare(`SELECT COUNT(*) AS n FROM reports r ${clause}`).bind(...params),
  ]);
  const items = ((rows?.results ?? []) as ReportRow[]).map(
    (row): ReportDTO => ({
      id: row.id,
      itemId: row.item_id,
      code: row.code,
      channel: row.channel,
      itemStatus: row.item_status,
      info: row.info,
      src: row.src,
      reason: row.reason,
      detail: row.detail,
      reporter: row.reporter,
      ipHash: row.ip_hash,
      createdAt: row.created_at,
      status: row.status,
      resolvedBy: row.resolved_by_name,
      resolvedAt: row.resolved_at,
      resolution: row.resolution,
    }),
  );
  const count = ((total?.results ?? []) as { n: number }[])[0]?.n ?? 0;
  return { items, total: count, page: query.page, pageSize: query.pageSize };
}

export type ResolveAction = "hide" | "dismiss" | "delete";

/**
 * 处理一个条目的全部未处理举报：
 * - hide：把条目隐藏（举报一并标为已处理）；
 * - dismiss：驳回举报（条目没问题）；如果它是被举报自动隐藏的，同时恢复上线；
 * - delete：删除条目。
 */
export async function resolveReports(
  db: D1Database,
  itemId: number,
  action: ResolveAction,
  actor: { id: number; name: string },
  settings: Pick<Settings, "maxItemsPerChannel">,
  now: number,
): Promise<void> {
  const item = await db
    .prepare("SELECT id, channel, code, status, hidden_reason FROM items WHERE id = ?")
    .bind(itemId)
    .first<{ id: number; channel: Channel; code: string; status: ItemStatus; hidden_reason: string }>();
  if (!item) throw new HttpError(404, "not_found", "没有这个条目");
  const audit: Omit<AuditEntry, "detail" | "targetId"> = { actor: actor.name, userId: actor.id, action: `report.${action}`, targetType: "item" };

  if (action === "delete") {
    await deleteItems(db, [itemId], now, audit);
    return;
  }
  if (action === "hide") {
    await setStatus(db, [itemId], { status: "hidden", hiddenReason: "manual", reviewerId: actor.id }, now, settings.maxItemsPerChannel, audit);
    return;
  }

  const restore = item.status === "hidden" && item.hidden_reason === "reports";
  if (restore && !(await hasRoom(db, item.channel, settings.maxItemsPerChannel))) {
    throw new HttpError(409, "list_full", "这份列表已经装满了，恢复不了这个条目");
  }
  await db.batch([
    db
      .prepare("UPDATE reports SET status = 'dismissed', resolved_by = ?2, resolved_at = ?3, resolution = '举报已驳回' WHERE item_id = ?1 AND status = 'open'")
      .bind(itemId, actor.id, now),
    db
      .prepare(
        `UPDATE items SET report_count = 0, updated_at = ?2,
           status = CASE WHEN ?3 = 1 THEN 'approved' ELSE status END,
           hidden_reason = CASE WHEN ?3 = 1 THEN '' ELSE hidden_reason END
         WHERE id = ?1`,
      )
      .bind(itemId, now, restore ? 1 : 0),
    ...(restore ? [rebuildSnapshotStatement(db, item.channel, now)] : []),
    auditStatement(db, { ...audit, targetId: item.code, detail: { channel: item.channel, restored: restore } }, now),
  ]);
}
