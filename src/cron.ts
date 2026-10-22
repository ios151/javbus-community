// 定时任务入口。两个 cron（免费账号一共只有 5 个名额）：
//   每 30 分钟：自动检查一批条目；
//   每天 04:17 UTC：清理 + 重建快照。
// 这两个表达式要和 wrangler.jsonc 里 triggers.crons 保持一致。

import { runCheckBatch, cronRunOptions } from "./lib/checks";
import { runHousekeeping } from "./lib/housekeeping";
import { loadConfig } from "./lib/settings";

export const CHECK_CRON = "*/30 * * * *";
export const DAILY_CRON = "17 4 * * *";

function log(event: string, data: Record<string, unknown>): void {
  console.log(JSON.stringify({ event, ...data }));
}

export async function handleScheduled(cron: string, env: Env, scheduledTime: number): Promise<void> {
  const { settings } = await loadConfig(env.DB, scheduledTime);
  if (cron === DAILY_CRON) {
    log("housekeeping", { ...(await runHousekeeping(env.DB, settings, scheduledTime)) });
    return;
  }
  if (!settings.checksEnabled) {
    log("check_skipped", { reason: "disabled" });
    return;
  }
  const { run, remaining } = await runCheckBatch(env.DB, settings, cronRunOptions(settings, scheduledTime), scheduledTime);
  log("check_batch", run ? { run: run.id, examined: run.examined, ok: run.ok, warn: run.warn, dead: run.dead, hidden: run.hidden, remaining } : { examined: 0, remaining });
}
