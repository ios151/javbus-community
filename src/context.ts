// Hono 应用的类型：绑定（来自 wrangler types 生成的全局 Env）和请求里挂的变量。

import type { Role } from "../shared/types";

/** 登录后挂在请求上的维护者信息（authenticate 中间件写入）。 */
export interface AuthUser {
  id: number;
  name: string;
  role: Role;
  totpEnabled: boolean;
}

export interface Variables {
  user: AuthUser;
}

export type AppEnv = { Bindings: Env; Variables: Variables };
