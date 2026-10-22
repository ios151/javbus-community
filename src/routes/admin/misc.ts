// 概览统计、操作日志、封禁。

import { Hono } from "hono";

import type { Channel, CheckStatus, CheckRunDTO, ItemStatus, StatsDTO } from "../../../shared/types";
import type { AppEnv } from "../../context";
import { listAudit } from "../../lib/audit";
import { requirePermission } from "../../lib/auth";
import { BAN_KINDS, addBan, listBans, parseBan, removeBan } from "../../lib/bans";
import { listRuns } from "../../lib/checks";
import { asRecord, pageParams, readJson } from "../../lib/http";
import { DAY, HttpError, utcDay } from "../../lib/util";
import { cleanText } from "../../lib/validate";

export const miscRoutes = new Hono<AppEnv>();

const DAYS_IN_CHART = 30;

miscRoutes.get("/stats", async (c) => {
  const db = c.env.DB;
  const now = Date.now();
  const since = Math.floor(now / DAY) * DAY - (DAYS_IN_CHART - 1) * DAY;
  const [byStatus, byCheck, reports, byDay, maintainers] = await db.batch([
    db.prepare("SELECT channel, status, COUNT(*) AS n FROM items GROUP BY channel, status"),
    db.prepare("SELECT check_status AS status, COUNT(*) AS n FROM items WHERE status = 'approved' GROUP BY check_status"),
    db.prepare("SELECT COUNT(DISTINCT item_id) AS n FROM reports WHERE status = 'open'"),
    db
      .prepare("SELECT strftime('%Y-%m-%d', created_at / 1000, 'unixepoch') AS day, COUNT(*) AS n FROM items WHERE created_at >= ? GROUP BY day")
      .bind(since),
    db.prepare("SELECT COUNT(*) AS n FROM users WHERE disabled = 0"),
  ]);

  const channels: StatsDTO["channels"] = {
    user: { pending: 0, approved: 0, rejected: 0, hidden: 0 },
    author: { pending: 0, approved: 0, rejected: 0, hidden: 0 },
  };
  for (const row of (byStatus?.results ?? []) as { channel: Channel; status: ItemStatus; n: number }[]) channels[row.channel][row.status] = row.n;

  const checks: StatsDTO["checks"] = { unchecked: 0, ok: 0, warn: 0, dead: 0 };
  for (const row of (byCheck?.results ?? []) as { status: CheckStatus; n: number }[]) checks[row.status] = row.n;

  const perDay = new Map(((byDay?.results ?? []) as { day: string; n: number }[]).map((row) => [row.day, row.n]));
  const submissionsByDay = Array.from({ length: DAYS_IN_CHART }, (_, i) => {
    const day = utcDay(since + i * DAY);
    return { day, count: perDay.get(day) ?? 0 };
  });

  const lastCheck: CheckRunDTO | null = (await listRuns(db, 1))[0] ?? null;
  const stats: StatsDTO = {
    channels,
    checks,
    openReports: ((reports?.results ?? []) as { n: number }[])[0]?.n ?? 0,
    submissionsByDay,
    lastCheck,
    maintainers: ((maintainers?.results ?? []) as { n: number }[])[0]?.n ?? 0,
  };
  return c.json(stats);
});

miscRoutes.get("/audit", requirePermission("audit.read"), async (c) => {
  const { page, pageSize } = pageParams(c);
  return c.json(
    await listAudit(c.env.DB, {
      page,
      pageSize,
      action: cleanText(c.req.query("action")).slice(0, 60) || undefined,
      actor: cleanText(c.req.query("actor")).slice(0, 60) || undefined,
    }),
  );
});

// ———— 封禁 ————

const bans = requirePermission("bans.manage");

miscRoutes.get("/bans", bans, async (c) => c.json(await listBans(c.env.DB)));

miscRoutes.post("/bans", bans, async (c) => {
  const ban = parseBan(asRecord(await readJson(c.req.raw, 2 * 1024)));
  const { purged } = await addBan(c.env.DB, ban, c.var.user, Date.now());
  return c.json({ ok: true, purged }, 201);
});

miscRoutes.delete("/bans/:kind/:value", bans, async (c) => {
  const kind = BAN_KINDS.find((k) => k === c.req.param("kind"));
  const value = c.req.param("value"); // Hono 已经解过码，再解一次遇到 %ZZ 这种会抛 URIError
  if (!kind || !value) throw new HttpError(400, "bad_ban", "kind / value 不对");
  if (!(await removeBan(c.env.DB, kind, value, c.var.user, Date.now()))) throw new HttpError(404, "not_found", "没有这条封禁");
  return c.json({ ok: true });
});
