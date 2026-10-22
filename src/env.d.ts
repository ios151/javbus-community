// wrangler types 只认 wrangler.jsonc 里写了的绑定；机密（wrangler secret put / .dev.vars）要自己补声明。
// 全局的 Env（Worker 代码里用）和 Cloudflare.Env（cloudflare:workers 的 env，测试里用）是两个独立的接口，各补一份。

interface Env {
  /** 第一次创建「站长」账号用的一次性口令。没设就没法创建站长（后台会提示去设置）。 */
  SETUP_TOKEN?: string;
}

declare namespace Cloudflare {
  interface Env {
    SETUP_TOKEN?: string;
  }
}
