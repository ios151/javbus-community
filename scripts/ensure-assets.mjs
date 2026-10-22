// 测试前确保 admin/dist 存在：wrangler.jsonc 的 assets.directory 指向它，目录不存在时 wrangler / vitest 插件会直接报错。
// 测试用不到真正的后台页面，放一个占位的 index.html 就行；npm run build:admin 会把整个目录换成真的构建产物。

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const dist = fileURLToPath(new URL("../admin/dist/", import.meta.url));

if (!existsSync(dist)) {
  mkdirSync(dist, { recursive: true });
  writeFileSync(`${dist}index.html`, "<!doctype html><title>placeholder</title>\n");
  console.log("admin/dist 不存在，已放一个占位页（只给测试用，部署前 npm run build:admin 会换成真的）");
}
