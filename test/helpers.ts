// 测试公用：清库、造请求、造账号（直接写库，绕过登录流程）、解析响应。

import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";

import type { Channel, Role, Settings } from "../shared/types";
import { hashId, randomToken, sha256Hex } from "../src/lib/crypto";
import { normalizeIp } from "../src/lib/http";
import { loadConfig, saveSettings } from "../src/lib/settings";
import worker from "../src/index";

export const BASE = "https://jc.test";
export const DEFAULT_IP = "203.0.113.7";

// 子表在前、被引用的在后（外键）
const TABLES = ["reports", "banned", "audit_log", "check_runs", "snapshots", "rate_limits", "items", "app_keys", "sessions", "invites", "users", "settings"];

/** 每个测试文件的存储是隔离的，但同一个文件里的测试之间数据会留着，所以每个测试前清一遍。 */
export async function resetDb(): Promise<void> {
  await env.DB.batch(TABLES.map((table) => env.DB.prepare(`DELETE FROM ${table}`)));
}

/** 走真实的 Worker 入口，并等 waitUntil 里的事做完。 */
export async function call(request: Request): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

export interface ReqOptions {
  method?: string;
  json?: unknown;
  /** 原样当请求体（测非法 JSON / 超大请求体用）。 */
  raw?: string;
  headers?: Record<string, string>;
  cookie?: string;
  /** 带上后台要求的 X-JC-Admin 头。 */
  admin?: boolean;
  device?: string;
  ip?: string;
}

export function api(path: string, options: ReqOptions = {}): Promise<Response> {
  const headers = new Headers(options.headers);
  if (options.json !== undefined) headers.set("Content-Type", "application/json");
  if (options.cookie) headers.set("Cookie", options.cookie);
  if (options.admin) headers.set("X-JC-Admin", "1");
  if (options.device) headers.set("X-Device-Id", options.device);
  headers.set("CF-Connecting-IP", options.ip ?? DEFAULT_IP);
  const body = options.raw ?? (options.json === undefined ? undefined : JSON.stringify(options.json));
  const method = options.method ?? (body === undefined ? "GET" : "POST");
  return call(new Request(`${BASE}${path}`, { method, headers, body }));
}

const deviceIps = new Map<string, string>();

/** 每个设备号配一个不同的 IP：举报按「不同的 IP」算人数，测试里要模拟「不同的人」就得有不同的 IP。 */
export function ipFor(device: string): string {
  if (!deviceIps.has(device)) deviceIps.set(device, `198.51.100.${deviceIps.size + 10}`);
  return deviceIps.get(device) ?? DEFAULT_IP;
}

/** 以某个设备（和它自己的 IP）的身份举报一个条目；没给设备号就是没带设备号、用默认 IP。 */
export function reportFrom(device: string | undefined, code: string, extra: Record<string, unknown> = {}, channel = "user"): Promise<Response> {
  return api("/api/v1/report", { json: { channel, code, reason: "dead", ...extra }, device, ip: device ? ipFor(device) : undefined });
}

export async function parse<T = unknown>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

/** 一个已登录的维护者：.get / .post / … 自动带上会话 cookie 和 X-JC-Admin。 */
export class Admin {
  constructor(
    readonly id: number,
    readonly name: string,
    readonly role: Role,
    readonly accessKey: string,
    readonly cookie: string,
  ) {}

  request(method: string, path: string, json?: unknown): Promise<Response> {
    return api(`/api/admin${path}`, { method, json, cookie: this.cookie, admin: true });
  }
  get = (path: string) => this.request("GET", path);
  post = (path: string, json: unknown = {}) => this.request("POST", path, json);
  put = (path: string, json: unknown) => this.request("PUT", path, json);
  patch = (path: string, json: unknown) => this.request("PATCH", path, json);
  del = (path: string) => this.request("DELETE", path);
}

/** 直接在库里建账号 + 会话，返回已登录的 Admin。 */
export async function seedUser(name: string, role: Role = "owner"): Promise<Admin> {
  const accessKey = randomToken("jck");
  const now = Date.now();
  const row = await env.DB.prepare("INSERT INTO users (name, role, key_hash, created_at) VALUES (?, ?, ?, ?) RETURNING id")
    .bind(name, role, await sha256Hex(accessKey), now)
    .first<{ id: number }>();
  if (!row) throw new Error("建账号失败");
  const token = randomToken("jcs");
  await env.DB.prepare("INSERT INTO sessions (id_hash, user_id, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?, ?)")
    .bind(await sha256Hex(token), row.id, now, now + 86_400_000, now)
    .run();
  return new Admin(row.id, name, role, accessKey, `jc_session=${token}`);
}

/** 新建一个 App 口令（脚本里「作者通道」的密码），返回明文口令。 */
export async function seedAppKey(admin: Admin, name = "测试口令"): Promise<string> {
  const key = randomToken("jca");
  await env.DB.prepare("INSERT INTO app_keys (user_id, name, key_hash, created_at) VALUES (?, ?, ?, ?)")
    .bind(admin.id, name, await sha256Hex(key), Date.now())
    .run();
  return key;
}

export async function setSettings(patch: Partial<Settings>): Promise<void> {
  await saveSettings(env.DB, patch, Date.now());
}

/** 某个设备号在库里的哈希（封禁 / 比对 submitter 用）。 */
export async function deviceHash(device: string): Promise<string> {
  const { salt } = await loadConfig(env.DB);
  return hashId(salt, device);
}

/** 某个 IP 在库里的哈希：和服务端一样先按 normalizeIp 归并（IPv6 按 /64）再哈希。 */
export async function ipHash(ip = DEFAULT_IP): Promise<string> {
  const { salt } = await loadConfig(env.DB);
  return hashId(salt, normalizeIp(ip));
}

/** 造一个合法的推荐条目。 */
export function makeItem(n: number, extra: Record<string, unknown> = {}): { code: string; info: string; src: string; link: string } {
  const code = `ABC-${String(n).padStart(3, "0")}`;
  return {
    code,
    info: `${code} | 2026-10-22`,
    src: `https://www.javbus.com/pics/thumb/abc${n}.jpg`,
    link: `https://www.javbus.com/${code}`,
    ...extra,
  };
}

export function upload(channel: Channel, body: unknown, options: ReqOptions = {}): Promise<Response> {
  return api(`/api/v1/upload/${channel}`, { json: body, ...options });
}

/** 一次提交（网友通道），返回响应正文里的返回码。 */
export async function submit(n: number, options: ReqOptions = {}): Promise<string> {
  return (await upload("user", { av: makeItem(n), mode: "upload" }, options)).text();
}

/** 公开列表里现有的番号（按列表顺序）。 */
export async function listCodes(channel: Channel): Promise<string[]> {
  const rows = await parse<{ code: string }[]>(await api(`/api/v1/rec/${channel}`));
  return rows.map((row) => row.code);
}
