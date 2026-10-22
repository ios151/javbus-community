// 前后端共用的类型和常量：Worker（src/）和管理后台（admin/）都从这里 import。
// 只放类型和不依赖运行时的常量 / 纯函数——两边的运行环境不一样（workerd / 浏览器），这里不碰任何全局对象。
//
// 站点设置的取值范围和说明也写在这里（SETTING_FIELDS）：后台的设置页照它自动生成表单，服务端照它校验，
// 加一项设置只改这一处。

export const APP_VERSION = "1.0.0";

// ———— 条目 ————

/** 两份公开列表：网友推荐（任何人在 App 里提交）和作者精选（只有拿着维护者口令的人能提交）。 */
export type Channel = "user" | "author";
export const CHANNELS: readonly Channel[] = ["user", "author"];
export const CHANNEL_NAMES: Record<Channel, string> = { user: "网友推荐", author: "作者精选" };

/** 待审 / 已上线 / 已拒绝 / 已隐藏。只有「已上线」的会进公开列表。 */
export type ItemStatus = "pending" | "approved" | "rejected" | "hidden";
export const ITEM_STATUSES: readonly ItemStatus[] = ["pending", "approved", "rejected", "hidden"];
export const ITEM_STATUS_NAMES: Record<ItemStatus, string> = {
  pending: "待审",
  approved: "已上线",
  rejected: "已拒绝",
  hidden: "已隐藏",
};

/** 为什么被隐藏：维护者手动 / 举报够多自动隐藏 / 自动检查判成失效自动隐藏。 */
export type HiddenReason = "" | "manual" | "reports" | "check";

export type CheckStatus = "unchecked" | "ok" | "warn" | "dead";
export const CHECK_STATUSES: readonly CheckStatus[] = ["unchecked", "ok", "warn", "dead"];
export const CHECK_STATUS_NAMES: Record<CheckStatus, string> = {
  unchecked: "没查过",
  ok: "正常",
  warn: "存疑",
  dead: "失效",
};

/** 公开列表里的一项，和 Scripting 脚本里的 RecItem 一致（四个字段，顺序也别动：脚本按这个读）。 */
export interface RecItem {
  code: string;
  info: string;
  src: string;
  link: string;
}

export interface ItemDTO {
  id: number;
  channel: Channel;
  code: string;
  info: string;
  src: string;
  link: string;
  status: ItemStatus;
  hiddenReason: HiddenReason;
  note: string;
  /** 提交者设备号的加盐哈希（16 位十六进制，还原不出设备号；封禁用它）；维护者建的 / 导入的是空串。 */
  submitter: string;
  /** 提交者 IP 的加盐哈希，同上。 */
  ipHash: string;
  createdAt: number;
  updatedAt: number;
  createdBy: string | null;
  reviewedBy: string | null;
  reviewedAt: number | null;
  reportCount: number;
  checkStatus: CheckStatus;
  checkDetail: string;
  checkFail: number;
  checkedAt: number | null;
}

export interface Paged<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

// ———— 举报 ————

export type ReportStatus = "open" | "resolved" | "dismissed";
export type ReportReason = "dead" | "inappropriate" | "duplicate" | "other";
export const REPORT_REASONS: readonly ReportReason[] = ["dead", "inappropriate", "duplicate", "other"];
export const REPORT_REASON_NAMES: Record<ReportReason, string> = {
  dead: "已失效",
  inappropriate: "内容不当",
  duplicate: "重复",
  other: "其他",
};

export interface ReportDTO {
  id: number;
  itemId: number;
  code: string;
  channel: Channel;
  itemStatus: ItemStatus;
  info: string;
  src: string;
  reason: ReportReason;
  detail: string;
  reporter: string;
  /** 举报者 IP 的加盐哈希（IPv6 已按 /64 归并）。条目的「举报数」就是没处理的举报里不同的 ipHash 有几个。 */
  ipHash: string;
  createdAt: number;
  status: ReportStatus;
  resolvedBy: string | null;
  resolvedAt: number | null;
  resolution: string;
}

// ———— 账号与权限 ————

export type Role = "owner" | "admin" | "moderator";
export const ROLES: readonly Role[] = ["owner", "admin", "moderator"];
export const ROLE_NAMES: Record<Role, string> = { owner: "站长", admin: "管理员", moderator: "协管" };
const ROLE_RANK: Record<Role, number> = { moderator: 1, admin: 2, owner: 3 };

/**
 * 谁能做什么（最低要哪一级）：
 * - 协管：审条目、处理举报、手动查一批 / 一条、看日志；
 * - 管理员：再加改站点设置、封禁、导入导出、查全部、邀请协管；
 * - 站长：再加管理所有账号（邀请管理员、改角色、停用、重置密钥）。
 */
export type Permission =
  | "items.moderate"
  | "reports.resolve"
  | "checks.run"
  | "checks.runAll"
  | "audit.read"
  | "bans.manage"
  | "settings.write"
  | "transfer"
  | "users.read"
  | "users.inviteModerator"
  | "users.manage";

const PERMISSION_MIN_ROLE: Record<Permission, Role> = {
  "items.moderate": "moderator",
  "reports.resolve": "moderator",
  "checks.run": "moderator",
  "checks.runAll": "admin",
  "audit.read": "moderator",
  "bans.manage": "admin",
  "settings.write": "admin",
  transfer: "admin",
  "users.read": "admin",
  "users.inviteModerator": "admin",
  "users.manage": "owner",
};

export function can(role: Role, permission: Permission): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[PERMISSION_MIN_ROLE[permission]];
}

export function allPermissions(role: Role): Permission[] {
  return (Object.keys(PERMISSION_MIN_ROLE) as Permission[]).filter((p) => can(role, p));
}

export interface UserDTO {
  id: number;
  name: string;
  role: Role;
  totpEnabled: boolean;
  disabled: boolean;
  createdAt: number;
  lastLoginAt: number | null;
}

export interface MeDTO {
  user: UserDTO;
  permissions: Permission[];
}

// ———— 站点设置 ————

export interface Settings {
  siteName: string;
  /** 维护模式：暂停收稿（提交一律拒绝），列表照常读。 */
  maintenance: boolean;
  /** 网友推荐提交后直接上线；关掉就先进「待审」，维护者通过了才公开。作者精选永远要口令，通过口令的直接上线。 */
  autoApproveUser: boolean;
  /** 每份公开列表最多多少条（超了拒收）。快照整份存一行，D1 单行上限 2 MB，3000 条约 600 KB。 */
  maxItemsPerChannel: number;
  submitPerHourDevice: number;
  submitPerDayDevice: number;
  submitPerHourIp: number;
  submitPerDayIp: number;
  /** 所有人加起来每天最多收多少条网友提交（总闸）。 */
  submitPerDayGlobal: number;
  reportPerDayDevice: number;
  /** 一个条目被多少个不同的人举报后自动隐藏（进待复核），0 = 不自动隐藏。 */
  reportAutoHide: number;
  /** 提交者在多少天内可以不用口令撤销自己提交的推荐，0 = 不允许。 */
  ownDeleteDays: number;
  /** 每行一个词：info 里出现就拒收。 */
  blockedWords: string;
  /** 每行一个域名（含子域名）：新提交的封面和详情页地址必须落在这些域名下；留空 = 不限制。维护者手动添加不受限。 */
  allowedHosts: string;
  /** 待审的条目超过多少天没人处理就自动拒绝，0 = 不自动处理。 */
  pendingExpireDays: number;
  checksEnabled: boolean;
  /** 每次自动检查最多查几个条目。免费版一次调用最多 50 个子请求，每个条目最多 2 个，别超过 20。 */
  checkBatchSize: number;
  /** 一个条目查过以后至少隔几天才复查。 */
  checkIntervalDays: number;
  /** 连续几次判成「失效」就自动隐藏。 */
  checkFailThreshold: number;
  checkAutoHide: boolean;
  checkCover: boolean;
  checkLink: boolean;
  /** 操作日志留多少天。 */
  auditRetentionDays: number;
}

export interface SettingField {
  key: keyof Settings;
  group: string;
  label: string;
  help: string;
  type: "bool" | "int" | "text" | "lines";
  min?: number;
  max?: number;
}

export const DEFAULT_SETTINGS: Settings = {
  siteName: "JavBus 社区推荐",
  maintenance: false,
  autoApproveUser: true,
  maxItemsPerChannel: 3000,
  submitPerHourDevice: 6,
  submitPerDayDevice: 20,
  submitPerHourIp: 20,
  submitPerDayIp: 60,
  submitPerDayGlobal: 300,
  reportPerDayDevice: 20,
  reportAutoHide: 3,
  ownDeleteDays: 7,
  blockedWords: "",
  allowedHosts: "",
  pendingExpireDays: 14,
  checksEnabled: true,
  checkBatchSize: 10,
  checkIntervalDays: 3,
  checkFailThreshold: 3,
  checkAutoHide: true,
  checkCover: true,
  checkLink: true,
  auditRetentionDays: 365,
};

export const SETTING_FIELDS: readonly SettingField[] = [
  { key: "siteName", group: "站点", label: "站点名称", help: "App 里「测试连接」和后台标题上显示。", type: "text" },
  { key: "maintenance", group: "站点", label: "维护模式", help: "打开后暂停收稿（App 里提交会提示服务暂停），列表照常读。", type: "bool" },
  { key: "maxItemsPerChannel", group: "站点", label: "每份列表的条数上限", help: "超了拒收。列表整份存一行（D1 单行上限 2 MB），3000 条约 600 KB。", type: "int", min: 100, max: 8000 },
  { key: "autoApproveUser", group: "审核", label: "网友推荐直接上线", help: "关掉以后新提交先进「待审」，维护者通过才公开。", type: "bool" },
  { key: "pendingExpireDays", group: "审核", label: "待审自动拒绝（天）", help: "待审条目超过这么多天没人处理就自动拒绝，0 = 不处理。", type: "int", min: 0, max: 365 },
  { key: "reportAutoHide", group: "审核", label: "举报自动隐藏（人数）", help: "一个条目被这么多个不同的人举报后自动隐藏、等维护者复核，0 = 不自动隐藏。", type: "int", min: 0, max: 50 },
  { key: "ownDeleteDays", group: "审核", label: "提交者自己撤销（天）", help: "提交者在这么多天内可以不用口令撤销自己提交的推荐，0 = 不允许。", type: "int", min: 0, max: 365 },
  { key: "blockedWords", group: "审核", label: "屏蔽词", help: "每行一个。info 里出现就拒收（不分大小写）。", type: "lines" },
  { key: "allowedHosts", group: "审核", label: "允许的网站", help: "每行一个域名（含子域名），新提交的封面和详情页地址必须落在这些域名下，留空 = 不限制。被人拿来灌垃圾链接时用。", type: "lines" },
  { key: "submitPerHourDevice", group: "频率限制", label: "每设备每小时提交", help: "按 App 带来的设备号算。", type: "int", min: 1, max: 1000 },
  { key: "submitPerDayDevice", group: "频率限制", label: "每设备每天提交", help: "", type: "int", min: 1, max: 5000 },
  { key: "submitPerHourIp", group: "频率限制", label: "每 IP 每小时提交", help: "按 IP 的哈希算（不存 IP 明文）。同一个出口 IP 后面可能有很多人，别设太小。", type: "int", min: 1, max: 5000 },
  { key: "submitPerDayIp", group: "频率限制", label: "每 IP 每天提交", help: "IPv6 按 /64 一段算一个 IP。", type: "int", min: 1, max: 20000 },
  { key: "submitPerDayGlobal", group: "频率限制", label: "每天最多收多少条（所有人加起来）", help: "总闸。免费版 D1 每天只有 500 万行读额度，而每条新提交上线都要重读整份列表来重建快照（3000 条 ≈ 3000 行）；不管对方换多少个设备号 / IP，一天最多收这么多，防止被人刷光额度。正常使用远用不到。", type: "int", min: 10, max: 5000 },
  { key: "reportPerDayDevice", group: "频率限制", label: "每设备每天举报", help: "", type: "int", min: 1, max: 1000 },
  { key: "checksEnabled", group: "自动检查", label: "开启自动检查", help: "每 30 分钟查一批条目的封面和链接还在不在（定时任务）。关掉不影响「立即检查」。", type: "bool" },
  { key: "checkBatchSize", group: "自动检查", label: "每次检查几个条目", help: "免费版一次调用最多 50 个子请求，每个条目最多 2 个，所以最多 25；默认 10。", type: "int", min: 1, max: 25 },
  { key: "checkIntervalDays", group: "自动检查", label: "复查间隔（天）", help: "一个条目查过以后至少隔这么久才再查。", type: "int", min: 1, max: 90 },
  { key: "checkFailThreshold", group: "自动检查", label: "连续失效几次后隐藏", help: "封面或链接连续这么多次都判成失效，才会自动隐藏。", type: "int", min: 1, max: 20 },
  { key: "checkAutoHide", group: "自动检查", label: "失效自动隐藏", help: "关掉就只标记「失效」，由维护者手动处理。", type: "bool" },
  { key: "checkCover", group: "自动检查", label: "检查封面地址", help: "", type: "bool" },
  { key: "checkLink", group: "自动检查", label: "检查详情页链接", help: "站点拒绝机器访问（403 / 验证页）时只会判「存疑」，不会因此隐藏。JavBus 的详情页会先跳到年龄验证页、看不到真实页面，这样的链接不参与判定（只看封面）。", type: "bool" },
  { key: "auditRetentionDays", group: "其它", label: "操作日志保留（天）", help: "每天凌晨清理更早的。", type: "int", min: 7, max: 3650 },
];

// ———— 检查 ————

export interface CheckRunDTO {
  id: number;
  startedAt: number;
  finishedAt: number | null;
  trigger: "cron" | "manual";
  by: string | null;
  examined: number;
  ok: number;
  warn: number;
  dead: number;
  hidden: number;
  note: string;
}

// ———— 其它 ————

export interface AuditDTO {
  id: number;
  at: number;
  actor: string;
  action: string;
  targetType: string;
  targetId: string;
  detail: unknown;
}

export interface BanDTO {
  kind: "device" | "ip" | "code";
  value: string;
  reason: string;
  createdAt: number;
  createdBy: string | null;
}

export interface AppKeyDTO {
  id: number;
  name: string;
  createdAt: number;
  lastUsedAt: number | null;
  revoked: boolean;
}

export interface InviteDTO {
  /** 邀请令牌哈希的前 12 位，撤销邀请用（令牌本身只在创建时显示一次）。 */
  id: string;
  role: "admin" | "moderator";
  note: string;
  createdBy: string | null;
  createdAt: number;
  expiresAt: number;
  used: boolean;
  usedBy: string | null;
}

export interface StatsDTO {
  channels: Record<Channel, Record<ItemStatus, number>>;
  checks: Record<CheckStatus, number>;
  openReports: number;
  /** 最近 30 天每天新增的条目数（按 UTC 日期），最旧的在前。 */
  submissionsByDay: { day: string; count: number }[];
  lastCheck: CheckRunDTO | null;
  maintainers: number;
}

// ———— 后台接口的响应 ————

export interface SetupStatusDTO {
  /** 还没有任何账号：第一个人凭 SETUP_TOKEN 创建站长。 */
  needsSetup: boolean;
  /** 服务端有没有配置 SETUP_TOKEN（没配就没法创建站长）。 */
  tokenConfigured: boolean;
  siteName: string;
}

export interface InviteInfoDTO {
  valid: boolean;
  role?: "admin" | "moderator";
  note?: string;
  siteName: string;
}

/** 登录 / 创建站长 / 接受邀请的结果。accessKey 只在新建账号时返回一次——服务端只存它的哈希，丢了只能重置。 */
export interface LoginResultDTO {
  me: MeDTO;
  accessKey?: string;
}

export interface ImportResultDTO {
  received: number;
  inserted: number;
  skipped: number;
  invalid: number;
  /** 前几个不合格的（下标 + 原因），给人排查数据用。 */
  samples: { index: number; reason: string }[];
}

export interface CheckRunResultDTO {
  run: CheckRunDTO | null;
  /** 按同样的条件还剩多少个没查。 */
  remaining: number;
}

export interface CreatedInviteDTO {
  /** 邀请令牌，只在这里出现一次。把 `/#/join?token=…` 发给对方。 */
  token: string;
  invite: InviteDTO;
}

export interface CreatedAppKeyDTO {
  /** App 口令（填进脚本「作者通道」的密码），只在这里出现一次。 */
  key: string;
  appKey: AppKeyDTO;
}

export interface ResetKeyDTO {
  accessKey: string;
}

export interface TotpStartDTO {
  secret: string;
  uri: string;
}

/** 脚本里「测试连接」读的。 */
export interface MetaDTO {
  name: string;
  version: string;
  maintenance: boolean;
  autoApprove: boolean;
  channels: Record<Channel, number>;
}
