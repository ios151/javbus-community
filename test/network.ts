// 测试里的外连一律走 msw：自动检查要去 fetch 封面和详情页，测试里不能真的连外网。
import { setupNetwork } from "@msw/cloudflare";

export const network = setupNetwork();
