// 举报处理：看举报、对一个条目的全部举报统一处理（隐藏 / 驳回 / 删除条目）。

import { Hono } from "hono";

import type { ReportStatus } from "../../../shared/types";
import type { AppEnv } from "../../context";
import { requirePermission } from "../../lib/auth";
import { asRecord, pageParams, readJson } from "../../lib/http";
import { listReports, resolveReports, type ResolveAction } from "../../lib/reports";
import { loadConfig } from "../../lib/settings";
import { HttpError } from "../../lib/util";

export const reportsRoutes = new Hono<AppEnv>();

const resolve = requirePermission("reports.resolve");
const REPORT_STATUSES: readonly ReportStatus[] = ["open", "resolved", "dismissed"];
const RESOLVE_ACTIONS: readonly ResolveAction[] = ["hide", "dismiss", "delete"];

reportsRoutes.get("/reports", resolve, async (c) => {
  const status = REPORT_STATUSES.find((s) => s === c.req.query("status"));
  return c.json(await listReports(c.env.DB, { status, ...pageParams(c) }));
});

reportsRoutes.post("/reports/resolve", resolve, async (c) => {
  const body = asRecord(await readJson(c.req.raw, 1024));
  const itemId = Number(body.itemId);
  const action = RESOLVE_ACTIONS.find((a) => a === body.action);
  if (!Number.isInteger(itemId) || itemId < 1 || !action) throw new HttpError(422, "invalid_report_action", "需要 itemId，以及 action：hide / dismiss / delete");
  const now = Date.now();
  const { settings } = await loadConfig(c.env.DB, now);
  await resolveReports(c.env.DB, itemId, action, c.var.user, settings, now);
  return c.json({ ok: true });
});
