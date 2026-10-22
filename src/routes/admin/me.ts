// 「我的账号」：看自己、换访问密钥、开关二次验证（TOTP）、管理自己的 App 口令。

import { Hono } from "hono";
import { getCookie } from "hono/cookie";

import type { AppKeyDTO, CreatedAppKeyDTO, ResetKeyDTO, TotpStartDTO } from "../../../shared/types";
import type { AppEnv } from "../../context";
import { auditStatement } from "../../lib/audit";
import { SESSION_COOKIE, toMe, verifyTotpWithLimit, type UserRow } from "../../lib/auth";
import { randomToken, sha256Hex } from "../../lib/crypto";
import { asRecord, idParam, readJson } from "../../lib/http";
import { loadConfig } from "../../lib/settings";
import { generateTotpSecret, otpauthUri } from "../../lib/totp";
import { HttpError } from "../../lib/util";
import { cleanText } from "../../lib/validate";

export const meRoutes = new Hono<AppEnv>();

const MAX_APP_KEYS = 10;

type FullUser = UserRow & { totp_secret: string };

async function loadUser(db: D1Database, id: number): Promise<FullUser> {
  const row = await db
    .prepare("SELECT id, name, role, totp_enabled, disabled, created_at, last_login_at, totp_secret FROM users WHERE id = ?")
    .bind(id)
    .first<FullUser>();
  if (!row) throw new HttpError(401, "unauthorized", "账号不存在");
  return row;
}

meRoutes.get("/me", async (c) => c.json(toMe(await loadUser(c.env.DB, c.var.user.id))));

/** 换访问密钥：旧密钥立刻作废，除当前这个以外的会话全部踢下线。 */
meRoutes.post("/me/rotate-key", async (c) => {
  const { id, name } = c.var.user;
  const now = Date.now();
  const accessKey = randomToken("jck");
  const current = getCookie(c, SESSION_COOKIE);
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE users SET key_hash = ? WHERE id = ?").bind(await sha256Hex(accessKey), id),
    c.env.DB.prepare("DELETE FROM sessions WHERE user_id = ? AND id_hash != ?").bind(id, current ? await sha256Hex(current) : ""),
    auditStatement(c.env.DB, { actor: name, userId: id, action: "user.rotate_key", targetType: "user", targetId: id }, now),
  ]);
  const result: ResetKeyDTO = { accessKey };
  return c.json(result);
});

// ———— 二次验证 ————

meRoutes.post("/me/totp/start", async (c) => {
  const user = await loadUser(c.env.DB, c.var.user.id);
  if (user.totp_enabled === 1) throw new HttpError(409, "totp_enabled", "已经开启了二次验证，要重新设置请先关闭");
  const { settings } = await loadConfig(c.env.DB);
  const secret = generateTotpSecret();
  await c.env.DB.prepare("UPDATE users SET totp_secret = ? WHERE id = ?").bind(secret, user.id).run();
  const result: TotpStartDTO = { secret, uri: otpauthUri(user.name, secret, settings.siteName) };
  return c.json(result);
});

meRoutes.post("/me/totp/enable", async (c) => {
  const body = asRecord(await readJson(c.req.raw, 1024));
  const now = Date.now();
  const user = await loadUser(c.env.DB, c.var.user.id);
  if (user.totp_enabled === 1) throw new HttpError(409, "totp_enabled", "已经开启了二次验证");
  if (!user.totp_secret) throw new HttpError(409, "totp_not_started", "先点「开始设置」拿到密钥");
  await verifyTotpWithLimit(c.env.DB, user.id, user.totp_secret, String(body.code ?? ""), now);
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE users SET totp_enabled = 1 WHERE id = ?").bind(user.id),
    auditStatement(c.env.DB, { actor: user.name, userId: user.id, action: "user.totp_enable", targetType: "user", targetId: user.id }, now),
  ]);
  return c.json({ ok: true });
});

meRoutes.post("/me/totp/disable", async (c) => {
  const body = asRecord(await readJson(c.req.raw, 1024));
  const now = Date.now();
  const user = await loadUser(c.env.DB, c.var.user.id);
  if (user.totp_enabled !== 1) throw new HttpError(409, "totp_disabled", "没有开启二次验证");
  await verifyTotpWithLimit(c.env.DB, user.id, user.totp_secret, String(body.code ?? ""), now);
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE users SET totp_enabled = 0, totp_secret = '' WHERE id = ?").bind(user.id),
    auditStatement(c.env.DB, { actor: user.name, userId: user.id, action: "user.totp_disable", targetType: "user", targetId: user.id }, now),
  ]);
  return c.json({ ok: true });
});

// ———— App 口令（脚本里「作者通道」的密码）————

interface AppKeyRow {
  id: number;
  name: string;
  created_at: number;
  last_used_at: number | null;
  revoked: number;
}

function toAppKeyDTO(row: AppKeyRow): AppKeyDTO {
  return { id: row.id, name: row.name, createdAt: row.created_at, lastUsedAt: row.last_used_at, revoked: row.revoked === 1 };
}

meRoutes.get("/me/app-keys", async (c) => {
  const { results } = await c.env.DB.prepare("SELECT id, name, created_at, last_used_at, revoked FROM app_keys WHERE user_id = ? ORDER BY id DESC")
    .bind(c.var.user.id)
    .all<AppKeyRow>();
  return c.json(results.map(toAppKeyDTO));
});

meRoutes.post("/me/app-keys", async (c) => {
  const body = asRecord(await readJson(c.req.raw, 1024));
  const { id, name: actor } = c.var.user;
  const name = cleanText(body.name).slice(0, 40);
  if (!name) throw new HttpError(422, "invalid_name", "给这个口令起个名字（比如「我的 iPhone」）");
  const now = Date.now();
  const active = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM app_keys WHERE user_id = ? AND revoked = 0").bind(id).first<{ n: number }>();
  if ((active?.n ?? 0) >= MAX_APP_KEYS) throw new HttpError(409, "too_many_keys", `最多同时有 ${MAX_APP_KEYS} 个有效口令，先撤销不用的`);

  const key = randomToken("jca");
  const inserted = await c.env.DB.prepare("INSERT INTO app_keys (user_id, name, key_hash, created_at) VALUES (?, ?, ?, ?) RETURNING id, name, created_at, last_used_at, revoked")
    .bind(id, name, await sha256Hex(key), now)
    .first<AppKeyRow>();
  if (!inserted) throw new HttpError(500, "internal", "创建口令失败");
  await auditStatement(c.env.DB, { actor, userId: id, action: "appkey.create", targetType: "app_key", targetId: inserted.id, detail: { name } }, now).run();
  const result: CreatedAppKeyDTO = { key, appKey: toAppKeyDTO(inserted) };
  return c.json(result, 201);
});

meRoutes.delete("/me/app-keys/:id", async (c) => {
  const keyId = idParam(c);
  const { id, name } = c.var.user;
  const now = Date.now();
  const [revoked] = await c.env.DB.batch([
    c.env.DB.prepare("UPDATE app_keys SET revoked = 1 WHERE id = ? AND user_id = ? AND revoked = 0").bind(keyId, id),
    auditStatement(c.env.DB, { actor: name, userId: id, action: "appkey.revoke", targetType: "app_key", targetId: keyId }, now),
  ]);
  if ((revoked?.meta.changes ?? 0) === 0) throw new HttpError(404, "not_found", "没有这个口令，或者已经撤销了");
  return c.json({ ok: true });
});
