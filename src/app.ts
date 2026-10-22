// Hono 应用：公开接口 /api/v1、后台接口 /api/admin，统一的错误格式。
// 后台页面本身是静态资源（admin/dist，由 Workers Static Assets 直接托管），不经过这里。

import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";

import type { AppEnv } from "./context";
import { HttpError } from "./lib/util";
import { adminApp } from "./routes/admin";
import { publicApp } from "./routes/public";

export const app = new Hono<AppEnv>();

app.onError((error, c) => {
  if (error instanceof HttpError) {
    const body = { error: { code: error.code, message: error.message, ...(error.details === undefined ? {} : { details: error.details }) } };
    return c.json(body, error.status);
  }
  if (error instanceof HTTPException) return error.getResponse();
  console.error(JSON.stringify({ event: "unhandled_error", path: new URL(c.req.url).pathname, message: error.message, stack: error.stack }));
  return c.json({ error: { code: "internal", message: "服务器出错了，稍后再试" } }, 500);
});

app.notFound((c) => {
  const { pathname } = new URL(c.req.url);
  // 非 API 路径交给静态资源（正常情况下 run_worker_first 只让 /api/* 进到 Worker，这里是兜底）
  if (!pathname.startsWith("/api/")) return c.env.ASSETS.fetch(c.req.raw);
  return c.json({ error: { code: "not_found", message: "没有这个接口" } }, 404);
});

app.use("/api/*", async (c, next) => {
  await next();
  c.header("X-Content-Type-Options", "nosniff");
});

app.route("/api/v1", publicApp);
app.route("/api/admin", adminApp);
