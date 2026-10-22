// /api/admin 的组装：先是不要求登录的几个入口，再是需要登录的所有接口。

import { Hono } from "hono";

import type { AppEnv } from "../../context";
import { authenticate, csrfGuard } from "../../lib/auth";
import { authPublic } from "./auth";
import { checksRoutes } from "./checks";
import { itemsRoutes } from "./items";
import { meRoutes } from "./me";
import { miscRoutes } from "./misc";
import { reportsRoutes } from "./reports";
import { settingsRoutes } from "./settings";
import { usersRoutes } from "./users";

export const adminApp = new Hono<AppEnv>();

adminApp.use("*", async (c, next) => {
  await next();
  // 一律不缓存；只有封面代理自己声明了可以缓存（封面地址不变图就不变），别把它盖掉
  if (!c.res.headers.has("Cache-Control")) c.header("Cache-Control", "no-store");
});
adminApp.use("*", csrfGuard);

// ——— 不要求登录 ———
adminApp.route("/", authPublic);

// ——— 以下都要登录（路由按注册顺序匹配，上面的入口先处理完就返回了）———
adminApp.use("*", authenticate);
adminApp.route("/", meRoutes);
adminApp.route("/", itemsRoutes);
adminApp.route("/", reportsRoutes);
adminApp.route("/", checksRoutes);
adminApp.route("/", settingsRoutes);
adminApp.route("/", usersRoutes);
adminApp.route("/", miscRoutes);
