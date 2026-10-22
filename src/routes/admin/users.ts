// 团队管理：账号列表、改角色 / 停用、重置密钥和二次验证、邀请。

import { Hono } from "hono";

import { can, ROLES, type CreatedInviteDTO, type InviteDTO, type ResetKeyDTO, type Role } from "../../../shared/types";
import type { AppEnv } from "../../context";
import { auditStatement } from "../../lib/audit";
import { requirePermission, toUserDTO, type UserRow } from "../../lib/auth";
import { randomToken, sha256Hex } from "../../lib/crypto";
import { asRecord, idParam, readJson } from "../../lib/http";
import { DAY, HttpError } from "../../lib/util";
import { cleanText } from "../../lib/validate";

export const usersRoutes = new Hono<AppEnv>();

const read = requirePermission("users.read");
const manage = requirePermission("users.manage");
const invite = requirePermission("users.inviteModerator");

const COLUMNS = "id, name, role, totp_enabled, disabled, created_at, last_login_at";

async function loadTarget(db: D1Database, id: number): Promise<UserRow> {
  const row = await db.prepare(`SELECT ${COLUMNS} FROM users WHERE id = ?`).bind(id).first<UserRow>();
  if (!row) throw new HttpError(404, "not_found", "没有这个账号");
  return row;
}

usersRoutes.get("/users", read, async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT ${COLUMNS} FROM users ORDER BY CASE role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, name`,
  ).all<UserRow>();
  return c.json(results.map(toUserDTO));
});

usersRoutes.patch("/users/:id", manage, async (c) => {
  const id = idParam(c);
  const actor = c.var.user;
  const body = asRecord(await readJson(c.req.raw, 1024));
  if (id === actor.id) throw new HttpError(409, "self", "不能改自己的角色或状态，让另一位站长来改");
  const target = await loadTarget(c.env.DB, id);

  const role: Role = body.role === undefined ? target.role : (ROLES.find((r) => r === body.role) ?? target.role);
  if (body.role !== undefined && role !== body.role) throw new HttpError(422, "invalid_role", "role 只能是 owner / admin / moderator");
  if (body.disabled !== undefined && typeof body.disabled !== "boolean") throw new HttpError(422, "invalid_disabled", "disabled 应该是 true / false");
  const disabled = typeof body.disabled === "boolean" ? body.disabled : target.disabled === 1;
  if (role === target.role && disabled === (target.disabled === 1)) return c.json(toUserDTO(target));

  // 至少要留一位启用中的站长，不然没人能管账号了。「还有别的启用中的站长」写进这条 UPDATE 的 WHERE 里一起判断：
  // 先数一数再改的话，两位站长同时把对方降级，两边都看到「对方还是站长」、都放行，最后一个站长都不剩
  const changed = await c.env.DB.prepare(
    `UPDATE users SET role = ?2, disabled = ?3
     WHERE id = ?1 AND (
       NOT (role = 'owner' AND disabled = 0)
       OR (?2 = 'owner' AND ?3 = 0)
       OR EXISTS (SELECT 1 FROM users o WHERE o.role = 'owner' AND o.disabled = 0 AND o.id != ?1)
     )`,
  )
    .bind(id, role, disabled ? 1 : 0)
    .run();
  if (changed.meta.changes === 0) throw new HttpError(409, "last_owner", "这是最后一位站长，不能降级或停用");

  const now = Date.now();
  await c.env.DB.batch([
    ...(disabled ? [c.env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(id)] : []),
    // 角色变了 / 停用了：他发出去还没用的邀请一并作废（邀请的权限跟着他的角色走）
    c.env.DB.prepare("DELETE FROM invites WHERE created_by = ? AND used_at IS NULL").bind(id),
    auditStatement(
      c.env.DB,
      {
        actor: actor.name,
        userId: actor.id,
        action: "user.update",
        targetType: "user",
        targetId: target.name,
        detail: { role: [target.role, role], disabled: [target.disabled === 1, disabled] },
      },
      now,
    ),
  ]);
  return c.json(toUserDTO(await loadTarget(c.env.DB, id)));
});

/**
 * 重置某个账号的访问密钥（对方丢了密钥 / 账号可能被盗时用）：旧密钥作废、会话全部踢下线、他的 App 口令全部撤销，新密钥只在这里显示一次。
 * App 口令也要撤：账号被盗期间攻击者可能已经生成了自己的口令，不撤的话密钥换了他照样能往作者精选里写、删别人的推荐。
 */
usersRoutes.post("/users/:id/reset-key", manage, async (c) => {
  const id = idParam(c);
  const actor = c.var.user;
  const target = await loadTarget(c.env.DB, id);
  const accessKey = randomToken("jck");
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE users SET key_hash = ? WHERE id = ?").bind(await sha256Hex(accessKey), id),
    c.env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(id),
    c.env.DB.prepare("UPDATE app_keys SET revoked = 1 WHERE user_id = ?").bind(id),
    auditStatement(c.env.DB, { actor: actor.name, userId: actor.id, action: "user.reset_key", targetType: "user", targetId: target.name }, Date.now()),
  ]);
  const result: ResetKeyDTO = { accessKey };
  return c.json(result);
});

/** 对方丢了验证器时：关掉他的二次验证，让他重新设置。 */
usersRoutes.post("/users/:id/reset-totp", manage, async (c) => {
  const id = idParam(c);
  const actor = c.var.user;
  const target = await loadTarget(c.env.DB, id);
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE users SET totp_enabled = 0, totp_secret = '' WHERE id = ?").bind(id),
    auditStatement(c.env.DB, { actor: actor.name, userId: actor.id, action: "user.reset_totp", targetType: "user", targetId: target.name }, Date.now()),
  ]);
  return c.json({ ok: true });
});

// ———— 邀请 ————

interface InviteRow {
  token_hash: string;
  role: "admin" | "moderator";
  note: string;
  created_at: number;
  expires_at: number;
  used_at: number | null;
  created_by_name: string | null;
  used_by_name: string | null;
}

function toInviteDTO(row: InviteRow): InviteDTO {
  return {
    id: row.token_hash.slice(0, 12),
    role: row.role,
    note: row.note,
    createdBy: row.created_by_name,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    used: row.used_at !== null,
    usedBy: row.used_by_name,
  };
}

const INVITE_SELECT = `SELECT i.token_hash, i.role, i.note, i.created_at, i.expires_at, i.used_at,
         cu.name AS created_by_name, uu.name AS used_by_name
  FROM invites i
  LEFT JOIN users cu ON cu.id = i.created_by
  LEFT JOIN users uu ON uu.id = i.used_by`;

const MAX_OPEN_INVITES = 20;

usersRoutes.get("/invites", read, async (c) => {
  const { results } = await c.env.DB.prepare(`${INVITE_SELECT} ORDER BY i.created_at DESC LIMIT 100`).all<InviteRow>();
  return c.json(results.map(toInviteDTO));
});

usersRoutes.post("/invites", invite, async (c) => {
  const body = asRecord(await readJson(c.req.raw, 1024));
  const actor = c.var.user;
  const role = body.role === "admin" || body.role === "moderator" ? body.role : null;
  if (!role) throw new HttpError(422, "invalid_role", "role 只能是 admin / moderator");
  if (role === "admin" && !can(actor.role, "users.manage")) throw new HttpError(403, "forbidden", "只有站长能邀请管理员");
  const days = body.days === undefined ? 7 : Number(body.days);
  if (!Number.isInteger(days) || days < 1 || days > 30) throw new HttpError(422, "invalid_days", "有效期是 1 到 30 天");
  const now = Date.now();
  const open = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM invites WHERE used_at IS NULL AND expires_at > ?").bind(now).first<{ n: number }>();
  if ((open?.n ?? 0) >= MAX_OPEN_INVITES) throw new HttpError(409, "too_many_invites", `同时最多 ${MAX_OPEN_INVITES} 个有效邀请，先撤销不用的`);

  const token = randomToken("jci");
  const hash = await sha256Hex(token);
  const note = cleanText(body.note).slice(0, 100);
  await c.env.DB.batch([
    c.env.DB.prepare("INSERT INTO invites (token_hash, role, note, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)").bind(
      hash,
      role,
      note,
      actor.id,
      now,
      now + days * DAY,
    ),
    auditStatement(c.env.DB, { actor: actor.name, userId: actor.id, action: "invite.create", targetType: "invite", targetId: hash.slice(0, 12), detail: { role, note, days } }, now),
  ]);
  const created = await c.env.DB.prepare(`${INVITE_SELECT} WHERE i.token_hash = ?`).bind(hash).first<InviteRow>();
  if (!created) throw new HttpError(500, "internal", "创建邀请失败");
  const result: CreatedInviteDTO = { token, invite: toInviteDTO(created) };
  return c.json(result, 201);
});

usersRoutes.delete("/invites/:id", invite, async (c) => {
  const id = c.req.param("id");
  if (!/^[0-9a-f]{12}$/.test(id)) throw new HttpError(400, "bad_id", "邀请 id 不对");
  const actor = c.var.user;
  const [removed] = await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM invites WHERE substr(token_hash, 1, 12) = ? AND used_at IS NULL").bind(id),
    auditStatement(c.env.DB, { actor: actor.name, userId: actor.id, action: "invite.revoke", targetType: "invite", targetId: id }, Date.now()),
  ]);
  if ((removed?.meta.changes ?? 0) === 0) throw new HttpError(404, "not_found", "没有这个邀请，或者已经被用掉了");
  return c.json({ ok: true });
});
