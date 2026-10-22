// 测试专用的绑定（vitest.config.ts 里传进去的）
declare namespace Cloudflare {
  interface Env {
    TEST_MIGRATIONS: import("cloudflare:test").D1Migration[];
  }
}
