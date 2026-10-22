// 封禁：设备 / IP（都是加盐哈希，后台看到的就是库里存的这串）/ 番号。
// 被封的设备和 IP 提交、举报都会被拒；被封的番号谁也提交不了。可以顺手把对方已经提交的条目清掉（purge）。

import { CHANNELS, type BanDTO } from "../../shared/types";
import { auditStatement } from "./audit";
import { rebuildSnapshotStatement } from "./snapshot";
import { HttpError } from "./util";
import { cleanText, isValidCode } from "./validate";

export type BanKind = "device" | "ip" | "code";
export const BAN_KINDS: readonly BanKind[] = ["device", "ip", "code"];

export async function isBanned(db: D1Database, who: { device?: string; ip?: string; code?: string }): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 AS hit FROM banned
       WHERE (kind = 'device' AND value = ?1) OR (kind = 'ip' AND value = ?2) OR (kind = 'code' AND value = ?3)
       LIMIT 1`,
    )
    .bind(who.device || "-", who.ip || "-", who.code || "-")
    .first();
  return row !== null;
}

interface BanRow {
  kind: BanKind;
  value: string;
  reason: string;
  created_at: number;
  created_by_name: string | null;
}

export async function listBans(db: D1Database): Promise<BanDTO[]> {
  const { results } = await db
    .prepare(
      `SELECT b.kind, b.value, b.reason, b.created_at, u.name AS created_by_name
       FROM banned b LEFT JOIN users u ON u.id = b.created_by
       ORDER BY b.created_at DESC`,
    )
    .all<BanRow>();
  return results.map((row): BanDTO => ({ kind: row.kind, value: row.value, reason: row.reason, createdAt: row.created_at, createdBy: row.created_by_name }));
}

/** 条目里看到的哈希是 16 位小写十六进制；手抄时大小写混了也认（存之前统一成小写）。 */
const HASH = /^[0-9a-f]{16}$/i;

export function parseBan(raw: Record<string, unknown>): { kind: BanKind; value: string; reason: string; purge: boolean } {
  const kind = BAN_KINDS.find((k) => k === raw.kind);
  if (!kind) throw new HttpError(422, "invalid_ban", "kind 只能是 device / ip / code");
  const value = cleanText(raw.value);
  if (kind === "code" ? !isValidCode(value) : !HASH.test(value)) {
    throw new HttpError(422, "invalid_ban", kind === "code" ? "番号格式不对" : "设备 / IP 要填条目里看到的 16 位哈希");
  }
  return { kind, value: kind === "code" ? value : value.toLowerCase(), reason: cleanText(raw.reason).slice(0, 200), purge: raw.purge === true };
}

/** 加一条封禁。purge = 顺手把这个设备 / IP / 番号已有的条目清掉（已上线 → 隐藏，待审 → 拒绝）。返回清掉了几条。 */
export async function addBan(
  db: D1Database,
  ban: { kind: BanKind; value: string; reason: string; purge: boolean },
  by: { id: number; name: string },
  now: number,
): Promise<{ purged: number }> {
  const column = ban.kind === "device" ? "submitter = ?1" : ban.kind === "ip" ? "ip_hash = ?1" : "code = ?1 COLLATE NOCASE";
  // 清理和重建快照在同一个事务里：分开的话，中间被打断，已经隐藏的条目还留在公开快照里
  const [, purge] = await db.batch([
    db
      .prepare("INSERT INTO banned (kind, value, reason, created_at, created_by) VALUES (?, ?, ?, ?, ?) ON CONFLICT (kind, value) DO UPDATE SET reason = excluded.reason")
      .bind(ban.kind, ban.value, ban.reason, now, by.id),
    db
      .prepare(
        `UPDATE items SET
           hidden_reason = CASE status WHEN 'approved' THEN 'manual' ELSE hidden_reason END,
           status = CASE status WHEN 'approved' THEN 'hidden' ELSE 'rejected' END,
           reviewed_by = ?2, reviewed_at = ?3, updated_at = ?3
         WHERE ?4 = 1 AND ${column} AND status IN ('approved', 'pending')`,
      )
      .bind(ban.value, by.id, now, ban.purge ? 1 : 0),
    ...(ban.purge ? CHANNELS.map((channel) => rebuildSnapshotStatement(db, channel, now)) : []),
  ]);
  const purged = purge?.meta.changes ?? 0;
  await auditStatement(
    db,
    { actor: by.name, userId: by.id, action: "ban.add", targetType: ban.kind, targetId: ban.value, detail: { reason: ban.reason, purged } },
    now,
  ).run();
  return { purged };
}

export async function removeBan(db: D1Database, kind: BanKind, value: string, by: { id: number; name: string }, now: number): Promise<boolean> {
  const [removed] = await db.batch([
    db.prepare("DELETE FROM banned WHERE kind = ? AND value = ?").bind(kind, value),
    auditStatement(db, { actor: by.name, userId: by.id, action: "ban.remove", targetType: kind, targetId: value }, now),
  ]);
  return (removed?.meta.changes ?? 0) > 0;
}
