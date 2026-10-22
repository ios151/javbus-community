// 管理后台的 Vite 配置：根目录指向 admin/，产物输出到 admin/dist（由 Worker 的静态资源托管）。
// 根目录的脚本是 `vite --config admin/vite.config.ts`，所以这里必须显式指定 root，不能靠 cwd。

import { fileURLToPath } from "node:url";

import preact from "@preact/preset-vite";
import { defineConfig } from "vite";

const root = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = fileURLToPath(new URL("..", import.meta.url));

/**
 * 开发时 /api 代理到 wrangler dev（8787）。写 127.0.0.1 而不是 localhost：
 * Node 会先把 localhost 解析成 IPv6 的 ::1，而 wrangler dev 只监听 127.0.0.1，写 localhost 代理会 500（ECONNREFUSED）。
 */
const API_TARGET = "http://127.0.0.1:8787";

export default defineConfig({
  root,
  plugins: [preact()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2022",
    // 内部后台，不需要 sourcemap；少一份文件就少一份被扒源码的可能
    sourcemap: false,
  },
  server: {
    port: 5173,
    // shared/types.ts 在 admin/ 外面，开发服务器要允许读仓库根目录
    fs: { allow: [repoRoot] },
    proxy: {
      "/api": {
        target: API_TARGET,
        changeOrigin: true,
        // 后端的 CSRF 检查要求 Origin 和请求地址同源。浏览器发的是 5173 的 Origin，
        // 转发到 8787 之前改成目标的 Origin，否则所有 POST 都会被当成跨站请求拒掉。
        configure: (proxy) => {
          proxy.on("proxyReq", (proxyReq) => {
            if (proxyReq.getHeader("origin")) proxyReq.setHeader("origin", API_TARGET);
          });
        },
      },
    },
  },
});
