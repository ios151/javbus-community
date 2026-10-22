// 操作日志：谁、什么时候、对什么做了什么。写操作和日志放进同一个 db.batch（同一个事务），要么都成要么都不成。

import type { AuditDTO, Paged } from "../../shared/types";
import { DAY } from "./util";

export interface AuditEntry {
  /** 维护者名字；定时任务写 system，脚本里的提交写 app。 */
  actor: string;
  userId?: number | null;
  action: string;
  targetType?: string;
  targetId?: string | number;
  detail?: unknown;
  ipHash?: string;
}

const MAX_DETAIL = 4000;
/** 翻页时显示的总条数最多到这里（见 listAudit）。 */
export const AUDIT_TOTAL_CAP = 10_000;

export function auditStatement(db: D1Database, entry: AuditEntry, now: number): D1PreparedStatement {
  let detail = entry.detail === undefined ? "" : JSON.stringify(entry.detail);
  if (detail.length > MAX_DETAIL) detail = JSON.stringify({ truncated: detail.slice(0, MAX_DETAIL) });
  return db
    .prepare(
      `INSERT INTO audit_log (at, user_id, actor, action, target_type, target_id, detail, ip_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      now,
      entry.userId ?? null,
      entry.actor,
      entry.action,
      entry.targetType ?? "",
      String(entry.targetId ?? ""),
      detail,
      entry.ipHash ?? "",
    );
}

export async function recordAudit(db: D1Database, entry: AuditEntry, now: number): Promise<void> {
  await auditStatement(db, entry, now).run();
}

interface AuditRow {
  id: number;
  at: number;
  actor: string;
  action: string;
  target_type: string;
  target_id: string;
  detail: string;
}

export interface AuditQuery {
  page: number;
  pageSize: number;
  action?: string;
  actor?: string;
}

function parseDetail(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export async function listAudit(db: D1Database, query: AuditQuery): Promise<Paged<AuditDTO>> {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (query.action) {
    where.push("action = ?");
    params.push(query.action);
  }
  if (query.actor) {
    where.push("actor = ? COLLATE NOCASE");
    params.push(query.actor);
  }
  const clause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
  const [rows, total] = await db.batch<AuditRow | { n: number }>([
    db
      .prepare(`SELECT id, at, actor, action, target_type, target_id, detail FROM audit_log ${clause} ORDER BY at DESC, id DESC LIMIT ? OFFSET ?`)
      .bind(...params, query.pageSize, (query.page - 1) * query.pageSize),
    // 总数封顶：没有筛选条件时 COUNT(*) 要扫全表，日志多了每翻一页都读几十万行；再往后翻本来也没人看
    db.prepare(`SELECT COUNT(*) AS n FROM (SELECT 1 FROM audit_log ${clause} LIMIT ${AUDIT_TOTAL_CAP + 1})`).bind(...params),
  ]);
  const items = (rows?.results as AuditRow[] | undefined ?? []).map(
    (row): AuditDTO => ({
      id: row.id,
      at: row.at,
      actor: row.actor,
      action: row.action,
      targetType: row.target_type,
      targetId: row.target_id,
      detail: parseDetail(row.detail),
    }),
  );
  const count = Math.min((total?.results as { n: number }[] | undefined)?.[0]?.n ?? 0, AUDIT_TOTAL_CAP);
  return { items, total: count, page: query.page, pageSize: query.pageSize };
}

export async function pruneAudit(db: D1Database, retentionDays: number, now: number): Promise<number> {
  const result = await db.prepare("DELETE FROM audit_log WHERE at < ?").bind(now - retentionDays * DAY).run();
  return result.meta.changes;
}
