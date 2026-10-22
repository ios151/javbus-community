// 站点设置：读（所有维护者）、改（管理员以上）。字段和取值范围见 shared/types.ts 的 SETTING_FIELDS。

import { Hono } from "hono";

import type { AppEnv } from "../../context";
import { auditStatement } from "../../lib/audit";
import { requirePermission } from "../../lib/auth";
import { readJson } from "../../lib/http";
import { loadConfig, parseSettingsPatch, saveSettings } from "../../lib/settings";

export const settingsRoutes = new Hono<AppEnv>();

settingsRoutes.get("/settings", async (c) => c.json({ settings: (await loadConfig(c.env.DB)).settings }));

settingsRoutes.put("/settings", requirePermission("settings.write"), async (c) => {
  const patch = parseSettingsPatch(await readJson(c.req.raw, 32 * 1024));
  const { id, name } = c.var.user;
  const now = Date.now();
  const { settings, changes } = await saveSettings(c.env.DB, patch, now);
  if (Object.keys(changes).length > 0) {
    await auditStatement(c.env.DB, { actor: name, userId: id, action: "settings.update", targetType: "settings", detail: changes }, now).run();
  }
  return c.json({ settings });
});
