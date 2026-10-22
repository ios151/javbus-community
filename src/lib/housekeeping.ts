// 每天凌晨的清理：过期的频率计数 / 会话 / 邀请、超时的待审条目、太旧的日志和检查记录，最后把两份公开列表的快照重建一遍
// （万一哪次「改条目」和「重建快照」之间被中断，这里补上）。

import { CHANNELS, type Settings } from "../../shared/types";
import { auditStatement } from "./audit";
import { rebuildSnapshots } from "./snapshot";
import { DAY, HOUR } from "./util";

export interface HousekeepingReport {
  rateLimits: number;
  sessions: number;
  invites: number;
  expiredPending: number;
  auditLog: number;
  checkRuns: number;
  closedRuns: number;
  reports: number;
}

/** 保留最近多少条检查记录。 */
const KEEP_CHECK_RUNS = 300;
/** 处理完的举报留多久。 */
const KEEP_REPORTS_DAYS = 180;

export async function runHousekeeping(db: D1Database, settings: Settings, now: number): Promise<HousekeepingReport> {
  const pendingCutoff = settings.pendingExpireDays > 0 ? now - settings.pendingExpireDays * DAY : -1;
  const results = await db.batch([
    db.prepare("DELETE FROM rate_limits WHERE expires_at < ?").bind(now),
    db.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(now),
    db.prepare("DELETE FROM invites WHERE COALESCE(used_at, expires_at) < ?").bind(now - 30 * DAY),
    db
      .prepare(
        `UPDATE items SET status = 'rejected', updated_at = ?1,
           note = CASE WHEN note = '' THEN '待审超时，自动拒绝' ELSE note END
         WHERE status = 'pending' AND created_at < ?2`,
      )
      .bind(now, pendingCutoff),
    db.prepare("DELETE FROM audit_log WHERE at < ?").bind(now - settings.auditRetentionDays * DAY),
    // OFFSET 跳过最新的 KEEP 条，取下一条（第 KEEP+1 新）的 id：它和更早的都删
    db
      .prepare("DELETE FROM check_runs WHERE id <= COALESCE((SELECT id FROM check_runs ORDER BY id DESC LIMIT 1 OFFSET ?), 0)")
      .bind(KEEP_CHECK_RUNS),
    db.prepare("UPDATE check_runs SET finished_at = started_at, note = '中途中断' WHERE finished_at IS NULL AND started_at < ?").bind(now - HOUR),
    db.prepare("DELETE FROM reports WHERE status != 'open' AND created_at < ?").bind(now - KEEP_REPORTS_DAYS * DAY),
  ]);
  const changes = (index: number): number => results[index]?.meta.changes ?? 0;
  const report: HousekeepingReport = {
    rateLimits: changes(0),
    sessions: changes(1),
    invites: changes(2),
    expiredPending: changes(3),
    auditLog: changes(4),
    checkRuns: changes(5),
    closedRuns: changes(6),
    reports: changes(7),
  };
  await rebuildSnapshots(db, CHANNELS, now);
  if (report.expiredPending > 0) {
    await auditStatement(
      db,
      { actor: "system", action: "item.expire_pending", targetType: "item", targetId: "", detail: { count: report.expiredPending } },
      now,
    ).run();
  }
  return report;
}
