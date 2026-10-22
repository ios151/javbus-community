// 后台接口的带类型客户端：路径、参数、返回值都和 docs/api.md、shared/types.ts 对得上。
//
// 约定：所有请求带 X-JC-Admin: 1（后端的 CSRF 防护要求，GET 带着也无妨）、cookie 走同源；
// 出错统一抛 ApiError；非登录类接口收到「会话没了」（401 unauthorized）就通知外面清登录态。
// 用工厂函数 createApi 造，测试里可以换成假的 fetch。

import type {
  AppKeyDTO,
  AuditDTO,
  BanDTO,
  Channel,
  CheckRunDTO,
  CheckRunResultDTO,
  CreatedAppKeyDTO,
  CreatedInviteDTO,
  ImportResultDTO,
  InviteDTO,
  InviteInfoDTO,
  ItemDTO,
  ItemStatus,
  LoginResultDTO,
  MeDTO,
  Paged,
  ReportDTO,
  ReportStatus,
  ResetKeyDTO,
  Role,
  SetupStatusDTO,
  Settings,
  StatsDTO,
  TotpStartDTO,
  UserDTO,
} from "../../shared/types";
import { cleanQuery, type QueryValue } from "./lib/format";
import { ApiError, networkError, parseErrorBody } from "./lib/errors";

export interface ClientOptions {
  fetch?: typeof fetch;
  base?: string;
  /** 会话没了（401 unauthorized）时调用。登录前就会调的接口（session: false）不触发。 */
  onSessionLost?: (error: ApiError) => void;
}

interface RequestOptions {
  query?: Record<string, QueryValue>;
  body?: unknown;
  /** false = 登录前就可能调的接口，401 不当成「掉线」。默认 true。 */
  session?: boolean;
}

// ———— 请求体 ————

export interface NewItemBody {
  channel: Channel;
  code: string;
  info?: string;
  src?: string;
  link: string;
  status?: "approved" | "pending";
  note?: string;
}

export interface ItemPatchBody {
  code?: string;
  info?: string;
  src?: string;
  link?: string;
  note?: string;
  channel?: Channel;
}

export interface ChecksRunBody {
  /** 指定条目（≤ 25）：有几个查几个，不受设置里「每次检查几个条目」的限制。 */
  itemIds?: number[];
  /** 不指定条目时，这一批最多查几个（临时改掉设置里的数量；最多 25）。 */
  limit?: number;
  olderThan?: number;
}

/**
 * POST /items/import/fetch 取回的条目：服务端只做了最便宜的结构检查（是对象、有字符串的 code 和 link），
 * 其它字段（info / src …）原样保留、可能缺失；真正的校验在分批导入时做。
 */
export interface FetchedItem {
  code: string;
  link: string;
  [key: string]: unknown;
}

export interface ImportBody {
  channel: Channel;
  status?: "approved" | "pending";
  items: unknown[];
  /**
   * 分批导入必须带：整个导入共用同一个 base（开始时的毫秒时间戳，一天以内、不能在未来），
   * offset = 这一批前面有多少条。带了以后批次之间的先后只看位置，和发送顺序、重试无关。
   */
  order?: { base: number; offset: number };
}

export interface NewInviteBody {
  role: "admin" | "moderator";
  note?: string;
  days?: number;
}

export interface NewBanBody {
  kind: "device" | "ip" | "code";
  value: string;
  reason?: string;
  purge?: boolean;
}

export type ResolveAction = "hide" | "dismiss" | "delete";

export interface ExportQuery {
  channel?: Channel;
  status?: ItemStatus;
}

export function createApi(options: ClientOptions = {}) {
  const base = options.base ?? "/api/admin";
  // 每次调用时再取全局 fetch：测试里 stub 了也能生效
  const doFetch: typeof fetch = (input, init) => (options.fetch ?? globalThis.fetch)(input, init);

  function urlOf(path: string, query?: Record<string, QueryValue>): string {
    const qs = query ? new URLSearchParams(cleanQuery(query)).toString() : "";
    return `${base}${path}${qs ? `?${qs}` : ""}`;
  }

  async function request<T>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
    const headers: Record<string, string> = { Accept: "application/json", "X-JC-Admin": "1" };
    let body: string | undefined;
    // 会改数据的请求一律带 JSON 体（有的接口，比如 /checks/run，空体会被当成非法 JSON）
    if (opts.body !== undefined || method === "POST" || method === "PUT" || method === "PATCH") {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(opts.body ?? {});
    }

    let text: string;
    let response: Response;
    try {
      response = await doFetch(urlOf(path, opts.query), { method, headers, body, credentials: "same-origin" });
      text = await response.text();
    } catch {
      throw networkError();
    }

    if (!response.ok) {
      const error = parseErrorBody(response.status, text);
      if (opts.session !== false && error.isSessionLost) options.onSessionLost?.(error);
      throw error;
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new ApiError(response.status, "bad_response", "服务器返回的内容不是合法的 JSON");
    }
  }

  const get = <T>(path: string, query?: Record<string, QueryValue>, session?: boolean) => request<T>("GET", path, { query, session });
  const post = <T>(path: string, body?: unknown, session?: boolean) => request<T>("POST", path, { body, session });
  const del = <T>(path: string) => request<T>("DELETE", path);

  return {
    // ——— 不需要登录 ———
    setupStatus: () => get<SetupStatusDTO>("/setup-status", undefined, false),
    setup: (body: { token: string; name: string }) => post<LoginResultDTO>("/setup", body, false),
    login: (body: { key: string; totp?: string }) => post<LoginResultDTO>("/login", body, false),
    logout: () => post<{ ok: true }>("/logout", {}, false),
    invite: (token: string) => get<InviteInfoDTO>("/invite", { token }, false),
    join: (body: { token: string; name: string }) => post<LoginResultDTO>("/join", body, false),

    // ——— 我的账号 ———
    /** 启动时探测「有没有登录」用，没登录的 401 属于正常情况，所以不触发掉线处理。 */
    me: () => get<MeDTO>("/me", undefined, false),
    rotateKey: () => post<ResetKeyDTO>("/me/rotate-key"),
    totpStart: () => post<TotpStartDTO>("/me/totp/start"),
    totpEnable: (code: string) => post<{ ok: true }>("/me/totp/enable", { code }),
    totpDisable: (code: string) => post<{ ok: true }>("/me/totp/disable", { code }),
    appKeys: () => get<AppKeyDTO[]>("/me/app-keys"),
    createAppKey: (name: string) => post<CreatedAppKeyDTO>("/me/app-keys", { name }),
    revokeAppKey: (id: number) => del<{ ok: true }>(`/me/app-keys/${id}`),

    // ——— 条目 ———
    items: (query: Record<string, QueryValue>) => get<Paged<ItemDTO>>("/items", query),
    item: (id: number) => get<ItemDTO>(`/items/${id}`),
    createItem: (body: NewItemBody) => post<ItemDTO>("/items", body),
    patchItem: (id: number, body: ItemPatchBody) => request<ItemDTO>("PATCH", `/items/${id}`, { body }),
    setItemsStatus: (ids: number[], status: Exclude<ItemStatus, "pending">) => post<{ changed: number }>("/items/status", { ids, status }),
    deleteItems: (ids: number[]) => post<{ deleted: number }>("/items/delete", { ids }),
    importItems: (body: ImportBody) => post<ImportResultDTO>("/items/import", body),
    fetchRemote: (url: string) => post<{ items: FetchedItem[]; invalid: number }>("/items/import/fetch", { url }),
    /** 导出是文件下载：页面里用普通 <a href download> 指向这个地址（cookie 会自动带上）。 */
    exportUrl: (query: ExportQuery = {}) => urlOf("/export", { channel: query.channel, status: query.status }),

    // ——— 举报 ———
    reports: (query: { status?: ReportStatus; page?: number; pageSize?: number }) => get<Paged<ReportDTO>>("/reports", query),
    resolveReports: (itemId: number, action: ResolveAction) => post<{ ok: true }>("/reports/resolve", { itemId, action }),

    // ——— 自动检查 ———
    checks: () => get<{ runs: CheckRunDTO[]; remaining: number }>("/checks"),
    runChecks: (body: ChecksRunBody = {}) => post<CheckRunResultDTO>("/checks/run", body),

    // ——— 设置 ———
    settings: () => get<{ settings: Settings }>("/settings"),
    saveSettings: (patch: Partial<Settings>) => request<{ settings: Settings }>("PUT", "/settings", { body: patch }),

    // ——— 团队 ———
    users: () => get<UserDTO[]>("/users"),
    patchUser: (id: number, body: { role?: Role; disabled?: boolean }) => request<UserDTO>("PATCH", `/users/${id}`, { body }),
    resetUserKey: (id: number) => post<ResetKeyDTO>(`/users/${id}/reset-key`),
    resetUserTotp: (id: number) => post<{ ok: true }>(`/users/${id}/reset-totp`),
    invites: () => get<InviteDTO[]>("/invites"),
    createInvite: (body: NewInviteBody) => post<CreatedInviteDTO>("/invites", body),
    revokeInvite: (id: string) => del<{ ok: true }>(`/invites/${encodeURIComponent(id)}`),

    // ——— 概览、日志、封禁 ———
    stats: () => get<StatsDTO>("/stats"),
    audit: (query: { action?: string; actor?: string; page?: number; pageSize?: number }) => get<Paged<AuditDTO>>("/audit", query),
    bans: () => get<BanDTO[]>("/bans"),
    addBan: (body: NewBanBody) => post<{ ok: true; purged: number }>("/bans", body),
    removeBan: (kind: BanDTO["kind"], value: string) => del<{ ok: true }>(`/bans/${kind}/${encodeURIComponent(value)}`),
  };
}

export type Api = ReturnType<typeof createApi>;

// ———— 全局实例 ————

let sessionLostHandler: ((error: ApiError) => void) | undefined;

/** 登录态丢了怎么办（清状态、回登录页）由 App 在启动时注册。 */
export function setSessionLostHandler(handler: (error: ApiError) => void): void {
  sessionLostHandler = handler;
}

export const api: Api = createApi({ onSessionLost: (error) => sessionLostHandler?.(error) });
