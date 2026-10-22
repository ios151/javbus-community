// 公开列表的快照：App 拉的整份 JSON 存成 snapshots 表里的一行，读列表只读这一行。
//
// 条目一变（上线 / 下线 / 改 / 删），就在同一个事务里重建对应频道的快照（rebuildSnapshotStatement 返回的语句放进 db.batch）。
// 重建全在 SQL 里做（json_group_array），数据不进 Worker——免费版每次请求只有 10 毫秒 CPU。
//
// 顺序：最新上线的在最前（created_at 倒序）。外层是聚合时 SQLite 不会把带 ORDER BY 的子查询拍平，所以顺序是确定的。

import type { Channel } from "../../shared/types";

/** D1 单行上限 2 MB；留一点余量，收稿 / 上线前据此判断满没满。 */
export const SNAPSHOT_MAX_BYTES = 1_800_000;

export function rebuildSnapshotStatement(db: D1Database, channel: Channel, now: number): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO snapshots (channel, version, count, bytes, body, updated_at)
       SELECT ?1,
              COALESCE((SELECT version FROM snapshots WHERE channel = ?1), 0) + 1,
              agg.n,
              LENGTH(CAST(agg.body AS BLOB)),
              agg.body,
              ?2
       FROM (
         SELECT COUNT(*) AS n,
                json_group_array(json_object('code', code, 'info', info, 'src', src, 'link', link)) AS body
         FROM (
           SELECT code, info, src, link FROM items
           WHERE channel = ?1 AND status = 'approved'
           ORDER BY created_at DESC, id DESC
         )
       ) AS agg
       WHERE true
       ON CONFLICT (channel) DO UPDATE SET
         version = excluded.version, count = excluded.count, bytes = excluded.bytes,
         body = excluded.body, updated_at = excluded.updated_at`,
    )
    .bind(channel, now);
}

export async function rebuildSnapshots(db: D1Database, channels: Iterable<Channel>, now: number): Promise<void> {
  const statements = [...new Set(channels)].map((channel) => rebuildSnapshotStatement(db, channel, now));
  if (statements.length > 0) await db.batch(statements);
}

export interface Snapshot {
  version: number;
  count: number;
  bytes: number;
  body: string;
}

export async function readSnapshot(db: D1Database, channel: Channel): Promise<Snapshot | null> {
  return db
    .prepare("SELECT version, count, bytes, body FROM snapshots WHERE channel = ?")
    .bind(channel)
    .first<Snapshot>();
}

/** 只要数量和大小，不要正文。没有快照（全新的库）= 空列表。 */
export async function snapshotInfo(db: D1Database, channel: Channel): Promise<{ count: number; bytes: number }> {
  const row = await db
    .prepare("SELECT count, bytes FROM snapshots WHERE channel = ?")
    .bind(channel)
    .first<{ count: number; bytes: number }>();
  return row ?? { count: 0, bytes: 0 };
}
