import { app } from "./app";
import { handleScheduled } from "./cron";

export default {
  fetch: app.fetch,
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(handleScheduled(controller.cron, env, controller.scheduledTime));
  },
} satisfies ExportedHandler<Env>;
