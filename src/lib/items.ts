// 条目的读写。凡是会改变「公开列表」的操作，都在同一个 db.batch（同一个事务）里重建对应频道的快照，并写一条操作日志。
//
// D1 的两个限制决定了写法：一条语句最多绑 100 个参数、免费版一次调用最多 50 条查询。
// 所以「一批 id」一律打成一个 JSON 数组参数，用 json_each() 展开；批量操作的日志合成一条，不是一个条目一条。

import type { Channel, CheckStatus, HiddenReason, ItemDTO, ItemStatus, Paged } from "../../shared/types";
import { CHANNELS } from "../../shared/types";
import { auditStatement, type AuditEntry } from "./audit";
import { rebuildSnapshotStatement, snapshotInfo, SNAPSHOT_MAX_BYTES } from "./snapshot";
import { HttpError } from "./util";
import { LIMITS, cleanText, validateItem, type ItemFields } from "./validate";

interface ItemRow {
  id: number;
  channel: Channel;
  code: string;
  info: string;
  src: string;
  link: string;
  status: ItemStatus;
  hidden_reason: HiddenReason;
  note: string;
  submitter: string;
  ip_hash: string;
  created_at: number;
  updated_at: number;
  reviewed_at: number | null;
  report_count: number;
  check_status: CheckStatus;
  check_detail: string;
  check_fail: number;
  checked_at: number | null;
  created_by_name: string | null;
  reviewed_by_name: string | null;
}

const ITEM_SELECT = `SELECT i.*, cu.name AS created_by_name, ru.name AS reviewed_by_name
  FROM items i
  LEFT JOIN users cu ON cu.id = i.created_by
  LEFT JOIN users ru ON ru.id = i.reviewed_by`;

function toDTO(row: ItemRow): ItemDTO {
  return {
    id: row.id,
    channel: row.channel,
    code: row.code,
    info: row.info,
    src: row.src,
    link: row.link,
    status: row.status,
    hiddenReason: row.hidden_reason,
    note: row.note,
    submitter: row.submitter,
    ipHash: row.ip_hash,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    createdBy: row.created_by_name,
    reviewedBy: row.reviewed_by_name,
    reviewedAt: row.reviewed_at,
    reportCount: row.report_count,
    checkStatus: row.check_status,
    checkDetail: row.check_detail,
    checkFail: row.check_fail,
    checkedAt: row.checked_at,
  };
}

function rowsOf<T>(result: D1Result | undefined): T[] {
  return (result?.results ?? []) as T[];
}

export function isUniqueViolation(error: unknown): boolean {
  return error instanceof Error && /UNIQUE constraint failed/i.test(error.message);
}

// ———— 查询 ————

export type ItemSort = "new" | "old" | "updated" | "checked" | "reports";

const SORTS: Record<ItemSort, string> = {
  new: "i.created_at DESC, i.id DESC",
  old: "i.created_at ASC, i.id ASC",
  updated: "i.updated_at DESC, i.id DESC",
  // 没查过的排最前，然后是最久没查的
  checked: "i.checked_at IS NOT NULL, i.checked_at ASC, i.id ASC",
  reports: "i.report_count DESC, i.created_at DESC, i.id DESC",
};

export function isItemSort(value: string): value is ItemSort {
  return Object.hasOwn(SORTS, value); // 不能用 in：toString / constructor 这些原型链上的名字也会命中
}

export interface ItemFilter {
  channel?: Channel;
  status?: ItemStatus;
  check?: CheckStatus;
  q?: string;
  reported?: boolean;
  sort?: ItemSort;
  page: number;
  pageSize: number;
}

export async function listItems(db: D1Database, filter: ItemFilter): Promise<Paged<ItemDTO>> {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (filter.channel) {
    where.push("i.channel = ?");
    params.push(filter.channel);
  }
  if (filter.status) {
    where.push("i.status = ?");
    params.push(filter.status);
  }
  if (filter.check) {
    where.push("i.check_status = ?");
    params.push(filter.check);
  }
  if (filter.reported) where.push("i.report_count > 0");
  if (filter.q) {
    const like = `%${filter.q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    where.push("(i.code LIKE ? ESCAPE '\\' OR i.info LIKE ? ESCAPE '\\')");
    params.push(like, like);
  }
  const clause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
  const order = SORTS[filter.sort ?? "new"];
  const [rows, total] = await db.batch([
    db
      .prepare(`${ITEM_SELECT} ${clause} ORDER BY ${order} LIMIT ? OFFSET ?`)
      .bind(...params, filter.pageSize, (filter.page - 1) * filter.pageSize),
    db.prepare(`SELECT COUNT(*) AS n FROM items i ${clause}`).bind(...params),
  ]);
  return {
    items: rowsOf<ItemRow>(rows).map(toDTO),
    total: rowsOf<{ n: number }>(total)[0]?.n ?? 0,
    page: filter.page,
    pageSize: filter.pageSize,
  };
}

export async function getItem(db: D1Database, id: number): Promise<ItemDTO | null> {
  const row = await db.prepare(`${ITEM_SELECT} WHERE i.id = ?`).bind(id).first<ItemRow>();
  return row ? toDTO(row) : null;
}

export async function findByCode(
  db: D1Database,
  channel: Channel,
  code: string,
): Promise<{ id: number; status: ItemStatus; submitter: string; createdAt: number } | null> {
  const row = await db
    .prepare("SELECT id, status, submitter, created_at FROM items WHERE channel = ? AND code = ? COLLATE NOCASE")
    .bind(channel, code)
    .first<{ id: number; status: ItemStatus; submitter: string; created_at: number }>();
  return row ? { id: row.id, status: row.status, submitter: row.submitter, createdAt: row.created_at } : null;
}

/**
 * 这个频道的公开列表还装得下 `extra` 条吗（条数和 2 MB 单行上限两头都看）。
 * extraBytes 是这批大概有多大：批量导入 / 批量通过一次放进去很多条，只看「现在有多大」会放行一批让快照涨过 2 MB 的。
 */
export async function hasRoom(db: D1Database, channel: Channel, maxItems: number, extra = 1, extraBytes = 0): Promise<boolean> {
  const { count, bytes } = await snapshotInfo(db, channel);
  return count + extra <= maxItems && bytes + extraBytes <= SNAPSHOT_MAX_BYTES;
}

// ———— 新建 ————

export interface NewItem extends ItemFields {
  channel: Channel;
  status: ItemStatus;
  submitter?: string;
  ipHash?: string;
  createdBy?: number | null;
  note?: string;
}

/**
 * 新建一条。返回新条目的 id；这个番号已经有了（待审 / 已上线 / 已隐藏）返回 null。
 * 例外：同番号的旧条目是「已拒绝」时，允许重新提交——原地覆盖成新的。
 */
export async function createItem(db: D1Database, input: NewItem, now: number, audit?: AuditEntry): Promise<number | null> {
  const existing = await findByCode(db, input.channel, input.code);
  if (existing && existing.status !== "rejected") return null;

  const results = await db.batch([
    db
      .prepare(
        "DELETE FROM reports WHERE item_id IN (SELECT id FROM items WHERE channel = ?1 AND code = ?2 COLLATE NOCASE AND status = 'rejected')",
      )
      .bind(input.channel, input.code),
    db
      .prepare(
        `INSERT INTO items (channel, code, info, src, link, status, note, submitter, ip_hash, created_by, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?11)
         ON CONFLICT (channel, code COLLATE NOCASE) DO UPDATE SET
           code = excluded.code, info = excluded.info, src = excluded.src, link = excluded.link,
           status = excluded.status, hidden_reason = '', note = excluded.note,
           submitter = excluded.submitter, ip_hash = excluded.ip_hash, created_by = excluded.created_by,
           created_at = excluded.created_at, updated_at = excluded.updated_at,
           reviewed_by = NULL, reviewed_at = NULL, report_count = 0,
           check_status = 'unchecked', check_detail = '', check_fail = 0, checked_at = NULL
         WHERE items.status = 'rejected'
         RETURNING id`,
      )
      .bind(
        input.channel,
        input.code,
        input.info,
        input.src,
        input.link,
        input.status,
        input.note ?? "",
        input.submitter ?? "",
        input.ipHash ?? "",
        input.createdBy ?? null,
        now,
      ),
    ...(input.status === "approved" ? [rebuildSnapshotStatement(db, input.channel, now)] : []),
    // 匿名提交不写日志（条目本身就带着提交者哈希和时间）：每条都写一行的话，日志会被刷爆，翻页时的计数也要扫一大片
    ...(audit ? [auditStatement(db, audit, now)] : []),
  ]);
  return rowsOf<{ id: number }>(results[1])[0]?.id ?? null;
}

// ———— 改状态 ————

export interface StatusChange {
  status: ItemStatus;
  hiddenReason?: HiddenReason;
  reviewerId: number | null;
}

export interface AffectedItem {
  id: number;
  channel: Channel;
  code: string;
  status: ItemStatus;
  hidden_reason: HiddenReason;
}

async function selectAffected(db: D1Database, ids: readonly number[]): Promise<AffectedItem[]> {
  const { results } = await db
    .prepare("SELECT id, channel, code, status, hidden_reason FROM items WHERE id IN (SELECT value FROM json_each(?))")
    .bind(JSON.stringify(ids))
    .all<AffectedItem>();
  return results;
}

function channelsOf(rows: readonly AffectedItem[]): Set<Channel> {
  return new Set(rows.map((r) => r.channel));
}

/**
 * 批量改状态（通过 / 拒绝 / 隐藏 / 恢复）。返回真正发生了变化的条目。
 * 「变化」包括：已经是隐藏、但隐藏原因变了（举报自动隐藏 → 维护者确认隐藏，要把举报一并处理掉）。
 * 不管改成什么状态，这个条目没处理的举报都会被关掉（隐藏 / 拒绝 = 已处理，通过 = 驳回）、举报数清零：
 * 不清的话，被自动隐藏的条目通过后残留的举报数还在，下一个人一举报就又被隐藏了。
 */
export async function setStatus(
  db: D1Database,
  ids: readonly number[],
  change: StatusChange,
  now: number,
  maxItemsPerChannel: number,
  audit: Omit<AuditEntry, "detail" | "targetId">,
): Promise<AffectedItem[]> {
  const found = await selectAffected(db, ids);
  const hiddenReason = change.hiddenReason ?? "";
  const changed = found.filter((row) => row.status !== change.status || (change.status === "hidden" && row.hidden_reason !== hiddenReason));
  if (changed.length === 0) return [];

  const changedIds = JSON.stringify(changed.map((row) => row.id));
  if (change.status === "approved") {
    // 上线以后要进快照：按频道算这批的条数和大概的字节数（LENGTH(CAST(… AS BLOB)) 是字节数，汉字占 3 个）
    const { results: incoming } = await db
      .prepare(
        `SELECT channel, COUNT(*) AS n,
                SUM(LENGTH(CAST(code AS BLOB)) + LENGTH(CAST(info AS BLOB)) + LENGTH(CAST(src AS BLOB)) + LENGTH(CAST(link AS BLOB)) + 64) AS bytes
         FROM items WHERE id IN (SELECT value FROM json_each(?)) GROUP BY channel`,
      )
      .bind(changedIds)
      .all<{ channel: Channel; n: number; bytes: number }>();
    for (const { channel, n, bytes } of incoming) {
      if (!(await hasRoom(db, channel, maxItemsPerChannel, n, bytes))) {
        throw new HttpError(409, "list_full", `「${channel === "user" ? "网友推荐" : "作者精选"}」已经装满了，先隐藏一些旧的，或者在设置里调大上限`);
      }
    }
  }

  const reportsStatus = change.status === "approved" ? "dismissed" : "resolved";
  const reportsResolution = change.status === "approved" ? "条目已被通过" : "条目已被处理";
  const touchesPublic = changed.some((row) => row.status === "approved") || change.status === "approved";
  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `UPDATE items SET status = ?2, hidden_reason = ?3, reviewed_by = ?4, reviewed_at = ?5, updated_at = ?5,
           check_fail = CASE WHEN ?2 = 'approved' THEN 0 ELSE check_fail END,
           report_count = 0
         WHERE id IN (SELECT value FROM json_each(?1))`,
      )
      .bind(changedIds, change.status, hiddenReason, change.reviewerId, now),
    db
      .prepare(
        `UPDATE reports SET status = ?4, resolved_by = ?2, resolved_at = ?3, resolution = ?5
         WHERE status = 'open' AND item_id IN (SELECT value FROM json_each(?1))`,
      )
      .bind(changedIds, change.reviewerId, now, reportsStatus, reportsResolution),
  ];
  if (touchesPublic) {
    for (const channel of channelsOf(changed)) statements.push(rebuildSnapshotStatement(db, channel, now));
  }
  statements.push(
    auditStatement(
      db,
      {
        ...audit,
        targetId: changed[0]?.code ?? "",
        detail: { count: changed.length, to: change.status, codes: changed.slice(0, 50).map((r) => r.code) },
      },
      now,
    ),
  );
  await db.batch(statements);
  return changed;
}

// ———— 编辑 ————

export interface ItemPatch {
  code?: string;
  info?: string;
  src?: string;
  link?: string;
  note?: string;
  channel?: Channel;
}

export function parseItemPatch(raw: Record<string, unknown>): ItemPatch {
  const patch: ItemPatch = {};
  for (const key of ["code", "info", "src", "link", "note"] as const) {
    if (raw[key] === undefined) continue;
    if (typeof raw[key] !== "string") throw new HttpError(422, "invalid_item", `${key} 应该是文字`);
    patch[key] = raw[key];
  }
  if (raw.channel !== undefined) {
    const channel = CHANNELS.find((c) => c === raw.channel);
    if (!channel) throw new HttpError(422, "invalid_item", "channel 只能是 user 或 author");
    patch.channel = channel;
  }
  return patch;
}

/** 维护者改一条。校验同 App 提交（但不查屏蔽词和网站名单）；番号 / 频道改了要保证不和别的撞。 */
export async function updateItem(
  db: D1Database,
  id: number,
  patch: ItemPatch,
  now: number,
  actor: Pick<AuditEntry, "actor" | "userId">,
  maxItemsPerChannel: number,
): Promise<ItemDTO> {
  const current = await getItem(db, id);
  if (!current) throw new HttpError(404, "not_found", "没有这个条目");

  const merged = validateItem({
    code: patch.code ?? current.code,
    info: patch.info ?? current.info,
    src: patch.src ?? current.src,
    link: patch.link ?? current.link,
  });
  if (!merged.ok) throw new HttpError(422, "invalid_item", merged.reason);
  const note = patch.note === undefined ? current.note : cleanText(patch.note).slice(0, LIMITS.note);
  const channel = patch.channel ?? current.channel;
  const { code, info, src, link } = merged.item;
  // 已上线的条目移到另一个频道：目标频道也要装得下（直接新增、批量通过都查容量，移过去不能是个后门）
  if (channel !== current.channel && current.status === "approved" && !(await hasRoom(db, channel, maxItemsPerChannel))) {
    throw new HttpError(409, "list_full", `「${channel === "user" ? "网友推荐" : "作者精选"}」已经装满了，先隐藏一些旧的，或者在设置里调大上限`);
  }

  const changes: Record<string, [unknown, unknown]> = {};
  const before: Record<string, unknown> = { code: current.code, info: current.info, src: current.src, link: current.link, note: current.note, channel: current.channel };
  const after: Record<string, unknown> = { code, info, src, link, note, channel };
  for (const key of Object.keys(after)) if (before[key] !== after[key]) changes[key] = [before[key], after[key]];
  if (Object.keys(changes).length === 0) return current;

  // 地址变了就当没查过：下次定时检查会重新查
  const addressChanged = "src" in changes || "link" in changes;
  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `UPDATE items SET channel = ?2, code = ?3, info = ?4, src = ?5, link = ?6, note = ?7, updated_at = ?8,
           check_status = CASE WHEN ?9 = 1 THEN 'unchecked' ELSE check_status END,
           check_detail = CASE WHEN ?9 = 1 THEN '' ELSE check_detail END,
           check_fail = CASE WHEN ?9 = 1 THEN 0 ELSE check_fail END,
           checked_at = CASE WHEN ?9 = 1 THEN NULL ELSE checked_at END
         WHERE id = ?1`,
      )
      .bind(id, channel, code, info, src, link, note, now, addressChanged ? 1 : 0),
  ];
  if (current.status === "approved") {
    statements.push(rebuildSnapshotStatement(db, current.channel, now));
    if (channel !== current.channel) statements.push(rebuildSnapshotStatement(db, channel, now));
  }
  statements.push(auditStatement(db, { ...actor, action: "item.edit", targetType: "item", targetId: current.code, detail: changes }, now));
  try {
    await db.batch(statements);
  } catch (error) {
    if (isUniqueViolation(error)) throw new HttpError(409, "exists", "目标频道里已经有同番号的条目了");
    throw error;
  }
  const refreshed = await getItem(db, id);
  if (!refreshed) throw new HttpError(404, "not_found", "没有这个条目");
  return refreshed;
}

// ———— 删除 ————

/** 删除（连同它的举报）。返回被删掉的条目。 */
export async function deleteItems(
  db: D1Database,
  ids: readonly number[],
  now: number,
  audit: Omit<AuditEntry, "detail" | "targetId">,
): Promise<AffectedItem[]> {
  const found = await selectAffected(db, ids);
  if (found.length === 0) return [];
  const statements: D1PreparedStatement[] = [
    db.prepare("DELETE FROM items WHERE id IN (SELECT value FROM json_each(?))").bind(JSON.stringify(found.map((r) => r.id))),
  ];
  const publicRows = found.filter((row) => row.status === "approved");
  for (const channel of channelsOf(publicRows)) statements.push(rebuildSnapshotStatement(db, channel, now));
  statements.push(
    auditStatement(
      db,
      { ...audit, targetId: found[0]?.code ?? "", detail: { count: found.length, codes: found.slice(0, 50).map((r) => r.code) } },
      now,
    ),
  );
  await db.batch(statements);
  return found;
}

// ———— 批量导入 ————

export interface ImportResult {
  received: number;
  inserted: number;
  skipped: number;
}

/**
 * 分批导入一个大文件时，让各批之间的先后也和文件一致：整个文件用同一个 base（开始导入的时刻），
 * offset 是这一批前面有多少条。发送顺序、重试都不影响结果。
 */
export interface ImportOrder {
  base: number;
  offset: number;
}

/**
 * 导入一批（字段都已校验过）。同番号已存在的跳过。数组的顺序就是上线后的显示顺序（第一条排最前）：
 * created_at = base − offset − 下标，不靠自增 id 的先后（没传 order 就以现在为 base、offset 为 0）。
 * 一条语句插入全部（json_each），不受 100 个参数限制。
 */
export async function importItems(
  db: D1Database,
  channel: Channel,
  items: readonly ItemFields[],
  status: "approved" | "pending",
  now: number,
  maxItemsPerChannel: number,
  actor: Pick<AuditEntry, "actor" | "userId">,
  order: ImportOrder = { base: now, offset: 0 },
): Promise<ImportResult> {
  if (items.length === 0) return { received: 0, inserted: 0, skipped: 0 };
  // 这一批大概有多大（快照里每条的内容和这里的 JSON 基本一样）：只看「现在有多大」会放行一批让快照涨过 2 MB 的
  const incomingBytes = new TextEncoder().encode(JSON.stringify(items)).length;
  if (status === "approved" && !(await hasRoom(db, channel, maxItemsPerChannel, items.length, incomingBytes))) {
    throw new HttpError(409, "list_full", "这一批导进去会超过列表上限（或接近 2 MB 单行上限），分小批导入，或者先在设置里调大上限");
  }
  const [insert] = await db.batch([
    db
      .prepare(
        `INSERT OR IGNORE INTO items (channel, code, info, src, link, status, created_by, created_at, updated_at)
         SELECT ?1, json_extract(value, '$.code'), json_extract(value, '$.info'), json_extract(value, '$.src'),
                json_extract(value, '$.link'), ?3, ?4, ?6 - ?7 - key, ?5
         FROM json_each(?2)`,
      )
      .bind(channel, JSON.stringify(items), status, actor.userId ?? null, now, order.base, order.offset),
    ...(status === "approved" ? [rebuildSnapshotStatement(db, channel, now)] : []),
  ]);
  const inserted = insert?.meta.changes ?? 0;
  const result = { received: items.length, inserted, skipped: items.length - inserted };
  await auditStatement(db, { ...actor, action: "item.import", targetType: "channel", targetId: channel, detail: { ...result, status } }, now).run();
  return result;
}
