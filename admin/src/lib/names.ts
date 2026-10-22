// 前端专用的中文名映射（shared/types.ts 里已有的别在这里重复：频道、状态、角色、举报原因、检查结果都从 shared 取）。

import type { HiddenReason, Permission, ReportStatus } from "../../../shared/types";

export const HIDDEN_REASON_NAMES: Record<HiddenReason, string> = {
  "": "",
  manual: "维护者手动隐藏",
  reports: "举报够多，自动隐藏",
  check: "检查判成失效，自动隐藏",
};

/** 隐藏原因的短写（挨着「已隐藏」徽章显示）。 */
export const HIDDEN_REASON_SHORT: Record<HiddenReason, string> = {
  "": "",
  manual: "手动",
  reports: "举报",
  check: "失效",
};

export const PERMISSION_NAMES: Record<Permission, string> = {
  "items.moderate": "审核条目（新增 / 编辑 / 通过 / 拒绝 / 隐藏 / 删除）",
  "reports.resolve": "处理举报",
  "checks.run": "手动检查一批 / 指定条目",
  "checks.runAll": "全部检查",
  "audit.read": "查看操作日志",
  "bans.manage": "封禁管理",
  "settings.write": "修改站点设置",
  transfer: "导入 / 导出",
  "users.read": "查看账号和邀请",
  "users.inviteModerator": "邀请协管",
  "users.manage": "管理所有账号（邀请管理员、改角色、停用、重置密钥）",
};

export const REPORT_STATUS_NAMES: Record<ReportStatus, string> = {
  open: "未处理",
  resolved: "已处理",
  dismissed: "已驳回",
};

export const TRIGGER_NAMES: Record<"cron" | "manual", string> = { cron: "定时", manual: "手动" };

export const BAN_KIND_NAMES: Record<"device" | "ip" | "code", string> = { device: "设备", ip: "IP", code: "番号" };

export const INVITE_ROLE_NAMES: Record<"admin" | "moderator", string> = { admin: "管理员", moderator: "协管" };
