// 维护者登录态：会话 cookie + 权限检查 + CSRF 防护。
//
// 会话令牌是 256 位随机数，库里只存它的 SHA-256；cookie 是 HttpOnly + SameSite=Strict（本地 http 开发时不带 Secure）。
// 改数据的请求还必须带自定义头 X-JC-Admin（跨站表单 / 图片请求带不了自定义头），带了 Origin 的还要和本站一致。

import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";

import { can, type MeDTO, type Permission, type Role, type UserDTO, allPermissions } from "../../shared/types";
import type { AppEnv, AuthUser } from "../context";
import { sha256Hex, randomToken } from "./crypto";
import { defer } from "./http";
import { clearRateLimit, hitRateLimits } from "./ratelimit";
import { verifyTotp } from "./totp";
import { DAY, HOUR, HttpError, MINUTE } from "./util";

export const SESSION_COOKIE = "jc_session";
export const SESSION_TTL_MS = 14 * DAY;
const TOUCH_AFTER_MS = HOUR;

export interface UserRow {
  id: number;
  name: string;
  role: Role;
  totp_enabled: number;
  disabled: number;
  created_at: number;
  last_login_at: number | null;
}

export function toUserDTO(row: UserRow): UserDTO {
  return {
    id: row.id,
    name: row.name,
    role: row.role,
    totpEnabled: row.totp_enabled === 1,
    disabled: row.disabled === 1,
    createdAt: row.created_at,
    lastLoginAt: row.last_login_at,
  };
}

export function toMe(row: UserRow): MeDTO {
  return { user: toUserDTO(row), permissions: allPermissions(row.role) };
}

/**
 * 会话 cookie 要不要带 Secure：除了本地开发（http://localhost 一类，浏览器不一定接受 http 下的 Secure cookie）一律带。
 * 包括没开「始终使用 HTTPS」的自有域名——宁可登录不上，也不下发一个明文也会跟着走的会话。
 */
function secureCookie(c: Context): boolean {
  const { protocol, hostname } = new URL(c.req.url);
  const loopback = hostname === "localhost" || hostname.endsWith(".localhost") || hostname === "127.0.0.1" || hostname === "[::1]";
  return !(protocol === "http:" && loopback);
}

/** 建一个会话并种 cookie。 */
export async function startSession(c: Context<AppEnv>, userId: number, ipHash: string, now: number): Promise<void> {
  const token = randomToken("jcs");
  await c.env.DB.prepare(
    `INSERT INTO sessions (id_hash, user_id, created_at, expires_at, last_seen_at, ip_hash, user_agent)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(await sha256Hex(token), userId, now, now + SESSION_TTL_MS, now, ipHash, (c.req.header("User-Agent") ?? "").slice(0, 200))
    .run();
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: secureCookie(c),
    sameSite: "Strict",
    path: "/",
    maxAge: SESSION_TTL_MS / 1000,
  });
}

export async function endSession(c: Context<AppEnv>): Promise<void> {
  const token = getCookie(c, SESSION_COOKIE);
  if (token) await c.env.DB.prepare("DELETE FROM sessions WHERE id_hash = ?").bind(await sha256Hex(token)).run();
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
}

interface SessionJoin extends UserRow {
  expires_at: number;
  last_seen_at: number;
  id_hash: string;
}

/** 必须已登录：认出会话和账号，把维护者信息挂到 c.var.user。 */
export const authenticate = createMiddleware<AppEnv>(async (c, next) => {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token) throw new HttpError(401, "unauthorized", "请先登录");
  const hash = await sha256Hex(token);
  const now = Date.now();
  const row = await c.env.DB.prepare(
    `SELECT s.id_hash, s.expires_at, s.last_seen_at,
            u.id, u.name, u.role, u.totp_enabled, u.disabled, u.created_at, u.last_login_at
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.id_hash = ?`,
  )
    .bind(hash)
    .first<SessionJoin>();
  if (!row || row.expires_at <= now || row.disabled === 1) {
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    throw new HttpError(401, "unauthorized", row?.disabled === 1 ? "账号已被停用" : "登录已过期，请重新登录");
  }
  if (now - row.last_seen_at > TOUCH_AFTER_MS) {
    defer(c, c.env.DB.prepare("UPDATE sessions SET last_seen_at = ? WHERE id_hash = ?").bind(now, hash).run());
  }
  const user: AuthUser = { id: row.id, name: row.name, role: row.role, totpEnabled: row.totp_enabled === 1 };
  c.set("user", user);
  await next();
});

/**
 * 校验一个账号的 TOTP 验证码；不对就抛错。6 位验证码 10 分钟内只能试 5 次，输对了清零。
 * 登录、开启 / 关闭二次验证共用这一处。
 *
 * 先原子地占一个名额（一条 upsert 语句）、再校验：「先读计数、校验失败了再 +1」的话，并发的一批请求都在计数还没涨之前读到「没超限」，
 * 全都会真正去校验，等于没有限制。
 */
export async function verifyTotpWithLimit(db: D1Database, userId: number, secret: string, code: string, now: number): Promise<void> {
  const rule = { name: `totp:${userId}`, limit: 5, windowMs: 10 * MINUTE };
  if (await hitRateLimits(db, [rule], now)) throw new HttpError(429, "rate_limited", "验证码试错太多次了，10 分钟后再试");
  if (!secret || !(await verifyTotp(secret, code, now))) throw new HttpError(401, "totp_invalid", "验证码不对");
  await clearRateLimit(db, rule, now);
}

/** 这个接口要哪项权限（权限矩阵在 shared/types.ts，前端也用同一份）。 */
export function requirePermission(permission: Permission) {
  return createMiddleware<AppEnv>(async (c, next) => {
    if (!can(c.var.user.role, permission)) throw new HttpError(403, "forbidden", "你没有这个操作的权限");
    await next();
  });
}

/** CSRF：改数据的请求必须带 X-JC-Admin 头；带了 Origin 的必须和本站同源。 */
export const csrfGuard = createMiddleware<AppEnv>(async (c, next) => {
  const method = c.req.method;
  if (method !== "GET" && method !== "HEAD" && method !== "OPTIONS") {
    if (!c.req.header("X-JC-Admin")) throw new HttpError(403, "csrf", "缺少 X-JC-Admin 请求头");
    const origin = c.req.header("Origin");
    if (origin) {
      // Origin: null（沙箱 iframe、跨站重定向会发）不是合法的地址，new URL 会抛错，按「不同源」处理
      let sameSite = false;
      try {
        sameSite = new URL(origin).host === new URL(c.req.url).host;
      } catch {
        /* 不同源 */
      }
      if (!sameSite) throw new HttpError(403, "csrf", "跨站请求被拒绝");
    }
  }
  await next();
});
