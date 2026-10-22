import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterAll, afterEach, beforeAll } from "vitest";

import { network } from "./network";

// setup 文件在每个测试文件的存储隔离之外跑、可能跑多次；applyD1Migrations 只会应用还没应用过的，重复调用是安全的
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

beforeAll(() => {
  // 没有 mock 的外连直接报错，免得测试悄悄去连真实网络
  network.configure({ onUnhandledFrame: "error" });
  network.enable();
});
afterEach(() => network.resetHandlers());
afterAll(() => network.disable());
