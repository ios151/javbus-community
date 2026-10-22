// 操作日志里的动作名翻译成中文（动作列表见 docs/api.md 末尾），以及把 detail 概括成一句话。
// 没见过的动作原样显示——后端以后加了新动作，页面不会坏，只是暂时显示英文代号。

export interface ActionGroup {
  label: string;
  actions: { value: string; label: string }[];
}

export const ACTION_GROUPS: readonly ActionGroup[] = [
  {
    label: "账号",
    actions: [
      { value: "user.setup", label: "创建站长" },
      { value: "user.login", label: "登录" },
      { value: "user.join", label: "接受邀请加入" },
      { value: "user.update", label: "修改账号（角色 / 状态）" },
      { value: "user.reset_key", label: "重置访问密钥" },
      { value: "user.reset_totp", label: "重置二次验证" },
      { value: "user.rotate_key", label: "更换自己的访问密钥" },
      { value: "user.totp_enable", label: "开启二次验证" },
      { value: "user.totp_disable", label: "关闭二次验证" },
    ],
  },
  {
    label: "邀请与口令",
    actions: [
      { value: "invite.create", label: "创建邀请" },
      { value: "invite.revoke", label: "撤销邀请" },
      { value: "appkey.create", label: "新建 App 口令" },
      { value: "appkey.revoke", label: "撤销 App 口令" },
    ],
  },
  {
    label: "条目",
    actions: [
      { value: "item.submit", label: "App 提交条目" },
      { value: "item.create", label: "新增条目" },
      { value: "item.edit", label: "编辑条目" },
      { value: "item.approve", label: "通过条目" },
      { value: "item.reject", label: "拒绝条目" },
      { value: "item.hide", label: "隐藏条目" },
      { value: "item.delete", label: "删除条目" },
      { value: "item.self_delete", label: "提交者自助撤销" },
      { value: "item.import", label: "批量导入" },
      { value: "item.auto_hide_reports", label: "举报够多，自动隐藏" },
      { value: "item.expire_pending", label: "待审超时，自动拒绝" },
    ],
  },
  {
    label: "举报",
    actions: [
      { value: "report.hide", label: "举报：隐藏条目" },
      { value: "report.dismiss", label: "举报：驳回" },
      { value: "report.delete", label: "举报：删除条目" },
    ],
  },
  {
    label: "检查",
    actions: [
      { value: "check.run", label: "手动检查" },
      { value: "check.visibility", label: "检查后自动隐藏 / 恢复" },
    ],
  },
  {
    label: "设置与封禁",
    actions: [
      { value: "settings.update", label: "修改站点设置" },
      { value: "ban.add", label: "添加封禁" },
      { value: "ban.remove", label: "解除封禁" },
    ],
  },
];

const NAMES = new Map(ACTION_GROUPS.flatMap((group) => group.actions.map((a) => [a.value, a.label] as const)));

export const ALL_ACTIONS: readonly string[] = [...NAMES.keys()];

export function actionLabel(action: string): string {
  return NAMES.get(action) ?? action;
}

/** `system` = 定时任务 / 自动规则；`app` = 脚本里的提交；其余是维护者名字。 */
export function actorLabel(actor: string): string {
  if (actor === "system") return "系统（定时任务 / 自动规则）";
  if (actor === "app") return "App（脚本提交）";
  return actor;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 把 detail 概括成一句话（列表里直接看，不用展开 JSON）。认不出的形状返回空串。 */
export function summarizeDetail(action: string, detail: unknown): string {
  if (!isRecord(detail)) return "";
  const codes = Array.isArray(detail.codes) ? detail.codes.filter((c): c is string => typeof c === "string") : [];
  const count = typeof detail.count === "number" ? detail.count : codes.length;

  if (action === "item.approve" || action === "item.reject" || action === "item.hide" || action === "item.delete") {
    const shown = codes.slice(0, 3).join("、");
    return `${count} 个条目${shown ? `：${shown}${count > 3 ? " 等" : ""}` : ""}`;
  }
  if (action === "item.edit" || action === "settings.update") {
    const keys = Object.keys(detail);
    return keys.length > 0 ? `改了：${keys.join("、")}` : "";
  }
  if (action === "item.import") {
    const { received, inserted, skipped } = detail;
    if (typeof received === "number" && typeof inserted === "number") return `收到 ${received}，新增 ${inserted}，跳过 ${typeof skipped === "number" ? skipped : 0}`;
  }
  if (action === "check.run") {
    const { examined, ok, warn, dead, hidden } = detail;
    if (typeof examined === "number") return `查了 ${examined}：正常 ${ok ?? 0}、存疑 ${warn ?? 0}、失效 ${dead ?? 0}、自动隐藏 ${hidden ?? 0}`;
  }
  if (action === "ban.add" && typeof detail.purged === "number" && detail.purged > 0) return `同时清理了 ${detail.purged} 个条目`;
  if (action === "item.create" || action === "item.submit") {
    const { channel, status } = detail;
    if (typeof channel === "string" && typeof status === "string") return `${channel === "author" ? "作者精选" : "网友推荐"}，${status === "pending" ? "待审" : "已上线"}`;
  }
  return "";
}
