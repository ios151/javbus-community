// 登录态与站点基本信息：启动时探测一次（setup-status + me），之后由登录 / 退出 / 掉线更新。
// 登录后的页面通过 MeContext 拿到「当前用户和权限」（非空），不用到处判空。

import { createContext } from "preact";
import { useContext } from "preact/hooks";

import type { MeDTO, Permission } from "../../../shared/types";
import { api } from "../api";
import { ApiError, errorMessage } from "../lib/errors";
import { clearStats } from "./stats";
import { createStore } from "./store";

export interface SessionState {
  /** booting = 正在探测；ready = 知道了（登没登录看 me）；failed = 连后端都没连上。 */
  phase: "booting" | "ready" | "failed";
  failure?: string;
  me: MeDTO | null;
  /** 还没有任何账号：该走安装流程。 */
  needsSetup: boolean;
  /** 服务端有没有配置 SETUP_TOKEN。 */
  tokenConfigured: boolean;
  siteName: string;
}

export const DEFAULT_SITE_NAME = "社区推荐";

export const sessionStore = createStore<SessionState>({
  phase: "booting",
  me: null,
  needsSetup: false,
  tokenConfigured: false,
  siteName: DEFAULT_SITE_NAME,
});

/** 问「我登录了吗」：没登录（401）是正常结果，返回 null；别的错误（断网、500）才往外抛。 */
async function probeMe(): Promise<MeDTO | null> {
  try {
    return await api.me();
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) return null;
    throw error;
  }
}

/** 启动：并行问「要不要安装」和「我登录了吗」。 */
export async function bootSession(): Promise<void> {
  sessionStore.set((s) => ({ ...s, phase: "booting", failure: undefined }));
  try {
    const [setup, me] = await Promise.all([api.setupStatus(), probeMe()]);
    sessionStore.set({ phase: "ready", me, needsSetup: setup.needsSetup, tokenConfigured: setup.tokenConfigured, siteName: setup.siteName });
  } catch (error) {
    sessionStore.set((s) => ({ ...s, phase: "failed", failure: errorMessage(error) }));
  }
}

/** 安装 / 登录 / 加入成功：进入后台。 */
export function signedIn(me: MeDTO): void {
  sessionStore.set((s) => ({ ...s, me, needsSetup: false }));
}

/** 更新当前用户信息（比如开启二次验证后）。 */
export function updateMe(me: MeDTO): void {
  sessionStore.set((s) => ({ ...s, me }));
}

/** 会话没了（过期 / 被停用 / 被踢）：清掉本地状态，界面会回到登录页。 */
export function sessionLost(): void {
  clearStats();
  sessionStore.set((s) => ({ ...s, me: null }));
}

/** 主动退出：先通知服务端作废会话；就算这一步失败，本地也照样退出。 */
export async function signOut(): Promise<void> {
  try {
    await api.logout();
  } catch {
    // 服务端没退成功也不卡住用户
  }
  sessionLost();
}

export function setSiteName(siteName: string): void {
  sessionStore.set((s) => ({ ...s, siteName }));
}

// ———— 给登录后的页面用 ————

export const MeContext = createContext<MeDTO | null>(null);

export function useMe(): MeDTO {
  const me = useContext(MeContext);
  if (!me) throw new Error("useMe 只能在登录后的页面里用");
  return me;
}

export function useCan(permission: Permission): boolean {
  return useMe().permissions.includes(permission);
}
