// 管理后台纯逻辑（admin/src/lib）的单元测试配置：普通 Node 环境，不用 workers 池。
// 根目录的 vitest.config.ts 只收 test/**（后端），不会误收这里；这边用 `npm run test:admin` 单独跑。

import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
});
