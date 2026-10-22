// 自动检查：看记录、手动触发。定时的那一批在 cron.ts。

import { Hono } from "hono";

import { can, type CheckRunResultDTO } from "../../../shared/types";
import type { AppEnv } from "../../context";
import { requirePermission } from "../../lib/auth";
import { auditStatement } from "../../lib/audit";
import { countRemaining, listRuns, runCheckBatch, type RunOptions } from "../../lib/checks";
import { asRecord, idList, readJson } from "../../lib/http";
import { loadConfig } from "../../lib/settings";
import { DAY, HttpError } from "../../lib/util";

export const checksRoutes = new Hono<AppEnv>();

const run = requirePermission("checks.run");
/** 「检查这几条」一次最多几个（每个最多 2 个请求；免费版一次调用最多 50 个子请求）。 */
const MAX_PICKED = 25;

checksRoutes.get("/checks", run, async (c) => {
  const now = Date.now();
  const { settings } = await loadConfig(c.env.DB, now);
  return c.json({
    runs: await listRuns(c.env.DB, 30),
    remaining: await countRemaining(c.env.DB, now - settings.checkIntervalDays * DAY),
  });
});

/**
 * 手动检查一批。三种用法：
 * - 什么都不带：查最久没查的一批；
 * - itemIds：查指定的几条；
 * - olderThan（需要「查全部」权限）：只查这个时刻之后还没查过的——后台「全部检查」记下开始时刻，反复调用直到 remaining 为 0。
 */
checksRoutes.post("/checks/run", run, async (c) => {
  const body = asRecord(await readJson(c.req.raw, 4 * 1024));
  const user = c.var.user;
  const now = Date.now();
  const { settings } = await loadConfig(c.env.DB, now);
  if (!settings.checkCover && !settings.checkLink) throw new HttpError(409, "checks_disabled", "封面和链接的检查都关着，先在设置里打开至少一项");

  const options: RunOptions = { trigger: "manual", userId: user.id, actor: user.name, notCheckedSince: now + 60_000 };
  if (body.itemIds !== undefined) options.itemIds = idList(body.itemIds, MAX_PICKED);
  if (body.olderThan !== undefined) {
    if (!can(user.role, "checks.runAll")) throw new HttpError(403, "forbidden", "「全部检查」需要管理员权限");
    const olderThan = Number(body.olderThan);
    if (!Number.isFinite(olderThan) || olderThan < 0 || olderThan > now + 60_000) throw new HttpError(422, "invalid_check", "olderThan 不对");
    options.notCheckedSince = olderThan;
  }
  if (body.limit !== undefined) {
    const limit = Number(body.limit);
    if (!Number.isInteger(limit) || limit < 1) throw new HttpError(422, "invalid_check", "limit 不对");
    options.limit = limit;
  }

  const result = await runCheckBatch(c.env.DB, settings, options, now);
  if (result.run) {
    const { run: finished } = result;
    await auditStatement(
      c.env.DB,
      {
        actor: user.name,
        userId: user.id,
        action: "check.run",
        targetType: "check_run",
        targetId: finished.id,
        detail: { examined: finished.examined, ok: finished.ok, warn: finished.warn, dead: finished.dead, hidden: finished.hidden },
      },
      Date.now(),
    ).run();
  }
  const response: CheckRunResultDTO = result;
  return c.json(response);
});
