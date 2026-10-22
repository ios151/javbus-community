// 邀请相关的小逻辑：拼邀请链接、算邀请当前的状态。

import type { InviteDTO } from "../../../shared/types";

/** 邀请链接：`https://站点/#/join?token=…`。令牌是 base64url，本来不用转义，保险起见还是 encode 一下。 */
export function inviteLink(origin: string, token: string): string {
  return `${origin}/#/join?token=${encodeURIComponent(token)}`;
}

export type InviteState = "active" | "used" | "expired";

export const INVITE_STATE_NAMES: Record<InviteState, string> = { active: "有效", used: "已使用", expired: "已过期" };

export function inviteState(invite: Pick<InviteDTO, "used" | "expiresAt">, now: number): InviteState {
  if (invite.used) return "used";
  return invite.expiresAt <= now ? "expired" : "active";
}
