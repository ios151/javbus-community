// 后台的「还没登录也能调」的接口：首次安装、登录、退出、接受邀请。

import type { Context } from "hono";
import { Hono } from "hono";

import { can, type InviteInfoDTO, type LoginResultDTO, type Role, type SetupStatusDTO } from "../../../shared/types";
import type { AppEnv } from "../../context";
import { auditStatement } from "../../lib/audit";
import { endSession, startSession, toMe, verifyTotpWithLimit, type UserRow } from "../../lib/auth";
import { hashId, randomToken, sha256Hex, timingSafeEqual } from "../../lib/crypto";
import { asRecord, clientIp, readJson } from "../../lib/http";
import { isUniqueViolation } from "../../lib/items";
import { hitRateLimits } from "../../lib/ratelimit";
import { loadConfig } from "../../lib/settings";
import { HOUR, HttpError, MINUTE } from "../../lib/util";

export const authPublic = new Hono<AppEnv>();

const USER_COLUMNS = "id, name, role, totp_enabled, disabled, created_at, last_login_at";
const NAME_RE = /^[\p{L}\p{N}_.-]{2,24}$/u;
/** 操作日志里 actor 的保留值：system = 定时任务 / 自动规则，app = 脚本里的提交。注册成这两个名字，日志里就分不清是人还是系统。 */
const RESERVED_NAMES = new Set(["system", "app"]);
/** 看不见、会让名字显示成空白的字符（零宽字符、韩文填充符、控制符……）。 */
const HIDDEN_CHARS = /[\p{Default_Ignorable_Code_Point}\p{Cc}\p{Cf}]/u;

export function parseUserName(value: unknown): string {
  // NFKC：全角字母、带圈字符这些规整成通常的写法（ＢＯＳＳ → BOSS），不然「boss」和「ＢＯＳＳ」是两个人
  const name = (typeof value === "string" ? value : "").normalize("NFKC").trim();
  if (!NAME_RE.test(name) || HIDDEN_CHARS.test(name)) throw new HttpError(422, "invalid_name", "名字要 2 到 24 个字，只能用文字、数字和 _ . -，不能含看不见的字符");
  if (RESERVED_NAMES.has(name.toLowerCase())) throw new HttpError(422, "invalid_name", "这个名字是系统保留的，换一个");
  return name;
}

/** 按 IP 限频，超限直接 429；通过就返回 IP 哈希（写会话、审计用）。 */
async function limitByIp(c: Context<AppEnv>, kind: string, limit: number, windowMs: number, now: number): Promise<string> {
  const { salt } = await loadConfig(c.env.DB, now);
  const ipHash = await hashId(salt, clientIp(c));
  const hit = await hitRateLimits(c.env.DB, [{ name: `${kind}:${ipHash}`, limit, windowMs }], now);
  if (hit) throw new HttpError(429, "rate_limited", "尝试太频繁了，过一会儿再试");
  return ipHash;
}

authPublic.get("/setup-status", async (c) => {
  const { settings } = await loadConfig(c.env.DB);
  const row = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM users").first<{ n: number }>();
  const status: SetupStatusDTO = { needsSetup: (row?.n ?? 0) === 0, tokenConfigured: Boolean(c.env.SETUP_TOKEN), siteName: settings.siteName };
  return c.json(status);
});

/** 第一次：凭服务端的 SETUP_TOKEN 创建站长。创建成功后这个接口就永久关闭。 */
authPublic.post("/setup", async (c) => {
  const body = asRecord(await readJson(c.req.raw, 2048));
  const now = Date.now();
  const ipHash = await limitByIp(c, "setup", 10, HOUR, now);

  const configured = c.env.SETUP_TOKEN;
  if (!configured) throw new HttpError(403, "setup_disabled", "服务端还没有设置 SETUP_TOKEN：先执行 wrangler secret put SETUP_TOKEN，再回来创建站长");
  const given = typeof body.token === "string" ? body.token : "";
  if (!timingSafeEqual(await sha256Hex(given), await sha256Hex(configured))) {
    throw new HttpError(403, "bad_setup_token", "安装口令不对");
  }
  const name = parseUserName(body.name);

  const accessKey = randomToken("jck");
  const inserted = await c.env.DB.prepare("INSERT INTO users (name, role, key_hash, created_at) SELECT ?1, 'owner', ?2, ?3 WHERE NOT EXISTS (SELECT 1 FROM users)")
    .bind(name, await sha256Hex(accessKey), now)
    .run();
  if (inserted.meta.changes === 0) throw new HttpError(409, "already_setup", "已经创建过站长了，请直接登录");

  const user = await c.env.DB.prepare(`SELECT ${USER_COLUMNS} FROM users WHERE name = ?`).bind(name).first<UserRow>();
  if (!user) throw new HttpError(500, "internal", "创建站长失败");
  await startSession(c, user.id, ipHash, now);
  await auditStatement(c.env.DB, { actor: name, userId: user.id, action: "user.setup", targetType: "user", targetId: user.id, ipHash }, now).run();
  const result: LoginResultDTO = { me: toMe(user), accessKey };
  return c.json(result);
});

authPublic.post("/login", async (c) => {
  const body = asRecord(await readJson(c.req.raw, 2048));
  const now = Date.now();
  const db = c.env.DB;
  const ipHash = await limitByIp(c, "login", 30, 10 * MINUTE, now);

  const key = typeof body.key === "string" ? body.key.trim() : "";
  const row = key
    ? await db
        .prepare(`SELECT ${USER_COLUMNS}, totp_secret FROM users WHERE key_hash = ?`)
        .bind(await sha256Hex(key))
        .first<UserRow & { totp_secret: string }>()
    : null;
  if (!row) throw new HttpError(401, "invalid_key", "访问密钥不对");
  if (row.disabled === 1) throw new HttpError(403, "disabled", "这个账号已被停用");

  if (row.totp_enabled === 1) {
    const code = typeof body.totp === "string" ? body.totp : "";
    if (!code.trim()) throw new HttpError(401, "totp_required", "请输入验证器里的 6 位验证码");
    // 密钥对了才会走到这里
    await verifyTotpWithLimit(db, row.id, row.totp_secret, code, now);
  }

  await startSession(c, row.id, ipHash, now);
  await db.batch([
    db.prepare("UPDATE users SET last_login_at = ? WHERE id = ?").bind(now, row.id),
    auditStatement(db, { actor: row.name, userId: row.id, action: "user.login", targetType: "user", targetId: row.id, ipHash }, now),
  ]);
  const result: LoginResultDTO = { me: toMe({ ...row, last_login_at: now }) };
  return c.json(result);
});

authPublic.post("/logout", async (c) => {
  await endSession(c);
  return c.json({ ok: true });
});

interface InviteLookup {
  role: "admin" | "moderator";
  note: string;
  expires_at: number;
  used_at: number | null;
  creator_role: Role | null;
  creator_disabled: number | null;
}

async function lookupInvite(db: D1Database, tokenHash: string): Promise<InviteLookup | null> {
  return db
    .prepare(
      `SELECT i.role, i.note, i.expires_at, i.used_at, u.role AS creator_role, u.disabled AS creator_disabled
       FROM invites i LEFT JOIN users u ON u.id = i.created_by
       WHERE i.token_hash = ?`,
    )
    .bind(tokenHash)
    .first<InviteLookup>();
}

/**
 * 邀请现在还能用吗：没用过、没过期，**并且发邀请的人还在、没被停用、现在的权限还够发这个角色的邀请**（只有站长能邀请管理员）。
 * 光看「没过期」的话：站长被盗后停用了，他之前发的管理员邀请还能用来留后门；按 README 的应急办法清空账号表以后，旧邀请先于真站长被人用掉，
 * 真站长会被「已经有账号了」挡在安装页外面（清空账号表后 created_by 变成 NULL，这里就不再放行）。
 */
function redeemable(invite: InviteLookup | null, now: number): invite is InviteLookup {
  if (!invite || invite.used_at !== null || invite.expires_at <= now) return false;
  if (invite.creator_role === null || invite.creator_disabled !== 0) return false;
  return can(invite.creator_role, invite.role === "admin" ? "users.manage" : "users.inviteModerator");
}

authPublic.get("/invite", async (c) => {
  const { settings } = await loadConfig(c.env.DB);
  const token = c.req.query("token") ?? "";
  const invite = token ? await lookupInvite(c.env.DB, await sha256Hex(token)) : null;
  const info: InviteInfoDTO = redeemable(invite, Date.now())
    ? { valid: true, role: invite.role, note: invite.note, siteName: settings.siteName }
    : { valid: false, siteName: settings.siteName };
  return c.json(info);
});

/** 凭邀请令牌创建账号（角色由邀请决定）。令牌一次有效。 */
authPublic.post("/join", async (c) => {
  const body = asRecord(await readJson(c.req.raw, 2048));
  const now = Date.now();
  const db = c.env.DB;
  const ipHash = await limitByIp(c, "join", 20, HOUR, now);

  const token = typeof body.token === "string" ? body.token.trim() : "";
  const name = parseUserName(body.name);
  const tokenHash = await sha256Hex(token);

  if (!redeemable(await lookupInvite(db, tokenHash), now)) throw new HttpError(400, "invalid_invite", "邀请无效、已被使用或已过期");

  // 先占住邀请（一条语句里判断「没用过、没过期」并标记已用），再建账号；账号建失败（重名）就把邀请放回去
  const claimed = await db
    .prepare("UPDATE invites SET used_at = ?1 WHERE token_hash = ?2 AND used_at IS NULL AND expires_at > ?1 RETURNING role, created_by")
    .bind(now, tokenHash)
    .first<{ role: "admin" | "moderator"; created_by: number | null }>();
  if (!claimed) throw new HttpError(400, "invalid_invite", "邀请无效、已被使用或已过期");

  const accessKey = randomToken("jck");
  try {
    await db
      .prepare("INSERT INTO users (name, role, key_hash, created_at, created_by) VALUES (?, ?, ?, ?, ?)")
      .bind(name, claimed.role, await sha256Hex(accessKey), now, claimed.created_by)
      .run();
  } catch (error) {
    await db.prepare("UPDATE invites SET used_at = NULL WHERE token_hash = ?").bind(tokenHash).run();
    if (isUniqueViolation(error)) throw new HttpError(409, "name_taken", "这个名字已经有人用了，换一个");
    throw error;
  }
  const user = await db.prepare(`SELECT ${USER_COLUMNS} FROM users WHERE name = ?`).bind(name).first<UserRow>();
  if (!user) throw new HttpError(500, "internal", "创建账号失败");
  await db.batch([
    db.prepare("UPDATE invites SET used_by = ? WHERE token_hash = ?").bind(user.id, tokenHash),
    auditStatement(db, { actor: name, userId: user.id, action: "user.join", targetType: "user", targetId: user.id, detail: { role: claimed.role }, ipHash }, now),
  ]);
  await startSession(c, user.id, ipHash, now);
  const result: LoginResultDTO = { me: toMe(user), accessKey };
  return c.json(result);
});
