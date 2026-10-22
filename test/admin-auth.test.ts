import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";

import { ROLES, can, type AppKeyDTO, type CreatedAppKeyDTO, type CreatedInviteDTO, type InviteDTO, type InviteInfoDTO, type LoginResultDTO, type MeDTO, type Permission, type SetupStatusDTO, type TotpStartDTO, type UserDTO } from "../shared/types";
import worker from "../src/index";
import { totpCode } from "../src/lib/totp";
import { BASE, DEFAULT_IP, api, call, listCodes, makeItem, parse, resetDb, seedAppKey, seedUser, upload } from "./helpers";

beforeEach(resetDb);

interface ErrorBody {
  error: { code: string; message: string; details?: unknown };
}

/** 从 Set-Cookie 里取出会话 cookie（name=value）。 */
function cookieOf(response: Response): string {
  const match = /jc_session=([^;]*)/.exec(response.headers.get("set-cookie") ?? "");
  return match ? `jc_session=${match[1]}` : "";
}

function login(key: string, extra: { ip?: string; totp?: string } = {}): Promise<Response> {
  return api("/api/admin/login", { json: { key, totp: extra.totp }, admin: true, ip: extra.ip });
}

function setup(body: unknown): Promise<Response> {
  return api("/api/admin/setup", { json: body, admin: true });
}

async function errorCode(response: Response): Promise<string> {
  return (await parse<ErrorBody>(response)).error.code;
}

describe("首次安装", () => {
  it("全新部署：需要安装，口令已配置", async () => {
    const status = await parse<SetupStatusDTO>(await api("/api/admin/setup-status"));
    expect(status).toEqual({ needsSetup: true, tokenConfigured: true, siteName: "JavBus 社区推荐" });
  });

  it("没带 X-JC-Admin 头 → 403 csrf", async () => {
    const res = await api("/api/admin/setup", { json: { token: "test-setup-token", name: "boss" } });
    expect(res.status).toBe(403);
    expect(await errorCode(res)).toBe("csrf");
  });

  it("安装口令不对 → 403", async () => {
    const res = await setup({ token: "wrong", name: "boss" });
    expect(res.status).toBe(403);
    expect(await errorCode(res)).toBe("bad_setup_token");
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM users").first()).toEqual({ n: 0 });
  });

  it("名字格式不对 → 422", async () => {
    for (const name of ["", "a", "x".repeat(25), "bad name", "<script>"]) {
      const res = await setup({ token: "test-setup-token", name });
      expect(res.status).toBe(422);
      expect(await errorCode(res)).toBe("invalid_name");
    }
  });

  it("成功：站长账号 + 访问密钥（只此一次）+ 会话 cookie，随后 /me 能用", async () => {
    const res = await setup({ token: "test-setup-token", name: "老王" });
    expect(res.status).toBe(200);
    const body = await parse<LoginResultDTO>(res);
    expect(body.accessKey).toMatch(/^jck_/);
    expect(body.me.user).toMatchObject({ name: "老王", role: "owner", totpEnabled: false, disabled: false });
    expect(body.me.permissions).toContain("users.manage");

    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain("Secure"); // 测试地址是 https

    const me = await api("/api/admin/me", { cookie: cookieOf(res) });
    expect(me.status).toBe(200);
    expect((await parse<MeDTO>(me)).user.name).toBe("老王");

    // 库里只存哈希，不存明文密钥
    const row = await env.DB.prepare("SELECT key_hash FROM users").first<{ key_hash: string }>();
    expect(row?.key_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(row)).not.toContain(body.accessKey ?? "?");
  });

  it("创建之后这个入口永久关闭", async () => {
    expect((await setup({ token: "test-setup-token", name: "boss" })).status).toBe(200);
    const again = await setup({ token: "test-setup-token", name: "another" });
    expect(again.status).toBe(409);
    expect(await errorCode(again)).toBe("already_setup");
    expect((await parse<SetupStatusDTO>(await api("/api/admin/setup-status"))).needsSetup).toBe(false);
  });

  it("服务端没配 SETUP_TOKEN → 403 setup_disabled", async () => {
    const ctx = createExecutionContext();
    const request = new Request(`${BASE}/api/admin/setup`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-JC-Admin": "1", "CF-Connecting-IP": DEFAULT_IP },
      body: JSON.stringify({ token: "anything", name: "boss" }),
    });
    const res = await worker.fetch(request, { ...env, SETUP_TOKEN: undefined }, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(403);
    expect(await errorCode(res)).toBe("setup_disabled");
  });

  it("按 IP 限频：猜安装口令一小时最多 10 次", async () => {
    for (let i = 0; i < 10; i++) expect((await setup({ token: `wrong${i}`, name: "boss" })).status).toBe(403);
    const res = await setup({ token: "test-setup-token", name: "boss" });
    expect(res.status).toBe(429);
  });
});

describe("登录 / 退出", () => {
  it("密钥不对 → 401；没给密钥 → 401", async () => {
    await seedUser("boss");
    const wrong = await login("jck_nope");
    expect(wrong.status).toBe(401);
    expect(await errorCode(wrong)).toBe("invalid_key");
    expect((await login("")).status).toBe(401);
  });

  it("密钥对 → 会话 cookie；记下最后登录时间；留日志", async () => {
    const boss = await seedUser("boss");
    const res = await login(boss.accessKey);
    expect(res.status).toBe(200);
    const body = await parse<LoginResultDTO>(res);
    expect(body.me.user.lastLoginAt).not.toBeNull();
    expect(body.accessKey).toBeUndefined();
    expect((await api("/api/admin/me", { cookie: cookieOf(res) })).status).toBe(200);
    expect(await env.DB.prepare("SELECT actor, action FROM audit_log WHERE action = 'user.login'").first()).toEqual({ actor: "boss", action: "user.login" });
  });

  it("被停用的账号 → 403", async () => {
    const boss = await seedUser("boss");
    await env.DB.prepare("UPDATE users SET disabled = 1").run();
    const res = await login(boss.accessKey);
    expect(res.status).toBe(403);
    expect(await errorCode(res)).toBe("disabled");
  });

  it("按 IP 限频：10 分钟 30 次", async () => {
    for (let i = 0; i < 30; i++) expect((await login("jck_nope", { ip: "198.51.100.50" })).status).toBe(401);
    expect((await login("jck_nope", { ip: "198.51.100.50" })).status).toBe(429);
    expect((await login("jck_nope", { ip: "198.51.100.51" })).status).toBe(401);
  });

  it("退出：旧 cookie 立刻作废", async () => {
    const boss = await seedUser("boss");
    expect((await boss.post("/logout")).status).toBe(200);
    expect((await boss.get("/me")).status).toBe(401);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM sessions").first()).toEqual({ n: 0 });
  });
});

describe("访问保护", () => {
  it("没登录 / cookie 是假的 → 401", async () => {
    for (const path of ["/me", "/items", "/stats", "/settings", "/reports", "/checks"]) {
      expect((await api(`/api/admin${path}`)).status).toBe(401);
    }
    expect((await api("/api/admin/me", { cookie: "jc_session=jcs_fake" })).status).toBe(401);
  });

  it("会话过期 → 401，并清掉 cookie", async () => {
    const boss = await seedUser("boss");
    await env.DB.prepare("UPDATE sessions SET expires_at = 1").run();
    const res = await boss.get("/me");
    expect(res.status).toBe(401);
    expect(res.headers.get("set-cookie")).toContain("jc_session=;");
  });

  it("账号被停用 → 已登录的会话也立刻失效", async () => {
    const boss = await seedUser("boss");
    await env.DB.prepare("UPDATE users SET disabled = 1").run();
    const res = await boss.get("/me");
    expect(res.status).toBe(401);
    expect(await errorCode(res)).toBe("unauthorized");
  });

  it("改数据的请求必须带 X-JC-Admin；GET 不用", async () => {
    const boss = await seedUser("boss");
    const noHeader = await api("/api/admin/items/status", { cookie: boss.cookie, json: { ids: [1], status: "hidden" } });
    expect(noHeader.status).toBe(403);
    expect(await errorCode(noHeader)).toBe("csrf");
    expect((await api("/api/admin/me", { cookie: boss.cookie })).status).toBe(200);
  });

  it("Origin 和本站不同 → 403；同源 → 放行", async () => {
    const boss = await seedUser("boss");
    const cross = await api("/api/admin/items/status", { cookie: boss.cookie, admin: true, json: { ids: [1], status: "hidden" }, headers: { Origin: "https://evil.example" } });
    expect(cross.status).toBe(403);
    const same = await api("/api/admin/items/status", { cookie: boss.cookie, admin: true, json: { ids: [1], status: "hidden" }, headers: { Origin: BASE } });
    expect(same.status).toBe(200);
  });

  it("Origin: null（沙箱 iframe、跨站重定向会发）→ 403，不是 500", async () => {
    const boss = await seedUser("boss");
    const res = await api("/api/admin/items/status", { cookie: boss.cookie, admin: true, json: { ids: [1], status: "hidden" }, headers: { Origin: "null" } });
    expect(res.status).toBe(403);
    expect(await errorCode(res)).toBe("csrf");
  });

  it("会话 cookie 带 Secure：https 和自有域名的 http 都带；只有本机的 http（localhost / 127.0.0.1）不带，方便本地开发", async () => {
    const boss = await seedUser("boss");
    const loginAt = async (origin: string) => {
      const res = await call(
        new Request(`${origin}/api/admin/login`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-JC-Admin": "1", "CF-Connecting-IP": DEFAULT_IP },
          body: JSON.stringify({ key: boss.accessKey }),
        }),
      );
      expect(res.status).toBe(200);
      return res.headers.get("set-cookie") ?? "";
    };
    expect(await loginAt("https://jc.test")).toContain("Secure");
    expect(await loginAt("http://jc.test")).toContain("Secure");
    expect(await loginAt("http://localhost:8787")).not.toContain("Secure");
    expect(await loginAt("http://127.0.0.1:8787")).not.toContain("Secure");
    expect(await loginAt("http://[::1]:8787")).not.toContain("Secure");
  });

  it("后台接口响应不缓存", async () => {
    const boss = await seedUser("boss");
    expect((await boss.get("/me")).headers.get("Cache-Control")).toBe("no-store");
    expect((await api("/api/admin/setup-status")).headers.get("Cache-Control")).toBe("no-store");
  });

  it("不存在的后台接口 → JSON 404（已登录）", async () => {
    const boss = await seedUser("boss");
    const res = await boss.get("/nope");
    expect(res.status).toBe(404);
    expect(await errorCode(res)).toBe("not_found");
  });
});

describe("权限矩阵：接口上的限制和 shared/types.ts 里的矩阵一致", () => {
  const cases: { permission: Permission; send: (a: Awaited<ReturnType<typeof seedUser>>) => Promise<Response> }[] = [
    { permission: "settings.write", send: (a) => a.put("/settings", {}) },
    { permission: "bans.manage", send: (a) => a.get("/bans") },
    { permission: "transfer", send: (a) => a.get("/export") },
    { permission: "transfer", send: (a) => a.post("/items/import", {}) },
    { permission: "users.read", send: (a) => a.get("/users") },
    { permission: "users.read", send: (a) => a.get("/invites") },
    { permission: "users.inviteModerator", send: (a) => a.post("/invites", { role: "moderator" }) },
    { permission: "users.manage", send: (a) => a.patch("/users/999999", {}) },
    { permission: "users.manage", send: (a) => a.post("/users/999999/reset-key") },
    { permission: "checks.runAll", send: (a) => a.post("/checks/run", { olderThan: Date.now() }) },
    { permission: "items.moderate", send: (a) => a.post("/items/status", {}) },
    { permission: "items.moderate", send: (a) => a.post("/items/delete", {}) },
    { permission: "reports.resolve", send: (a) => a.get("/reports") },
    { permission: "checks.run", send: (a) => a.get("/checks") },
    { permission: "audit.read", send: (a) => a.get("/audit") },
  ];

  for (const role of ROLES) {
    it(`${role}`, async () => {
      const user = await seedUser(`u-${role}`, role);
      for (const { permission, send } of cases) {
        const status = (await send(user)).status;
        expect(status === 403, `${role} → ${permission}（HTTP ${status}）`).toBe(!can(role, permission));
      }
    });
  }
});

describe("邀请与加入", () => {
  it("协管不能邀请；管理员只能邀请协管；站长能邀请管理员", async () => {
    const moderator = await seedUser("m", "moderator");
    const admin = await seedUser("a", "admin");
    const owner = await seedUser("o", "owner");
    expect((await moderator.post("/invites", { role: "moderator" })).status).toBe(403);
    expect((await admin.post("/invites", { role: "moderator" })).status).toBe(201);
    const adminInvite = await admin.post("/invites", { role: "admin" });
    expect(adminInvite.status).toBe(403);
    expect((await owner.post("/invites", { role: "admin" })).status).toBe(201);
    expect((await owner.post("/invites", { role: "owner" })).status).toBe(422);
    expect((await owner.post("/invites", { role: "moderator", days: 31 })).status).toBe(422);
  });

  it("完整流程：创建 → 预览 → 加入 → 令牌作废", async () => {
    const owner = await seedUser("boss");
    const created = await parse<CreatedInviteDTO>(await owner.post("/invites", { role: "moderator", note: "小李", days: 3 }));
    expect(created.token).toMatch(/^jci_/);
    expect(created.invite).toMatchObject({ role: "moderator", note: "小李", createdBy: "boss", used: false });

    const preview = await parse<InviteInfoDTO>(await api(`/api/admin/invite?token=${encodeURIComponent(created.token)}`));
    expect(preview).toEqual({ valid: true, role: "moderator", note: "小李", siteName: "JavBus 社区推荐" });

    const joined = await api("/api/admin/join", { json: { token: created.token, name: "xiaoli" }, admin: true });
    expect(joined.status).toBe(200);
    const body = await parse<LoginResultDTO>(joined);
    expect(body.me.user).toMatchObject({ name: "xiaoli", role: "moderator" });
    expect(body.accessKey).toMatch(/^jck_/);
    expect((await api("/api/admin/me", { cookie: cookieOf(joined) })).status).toBe(200);

    const reuse = await api("/api/admin/join", { json: { token: created.token, name: "another" }, admin: true });
    expect(reuse.status).toBe(400);
    expect(await errorCode(reuse)).toBe("invalid_invite");
    expect((await parse<InviteInfoDTO>(await api(`/api/admin/invite?token=${encodeURIComponent(created.token)}`))).valid).toBe(false);

    const list = await parse<InviteDTO[]>(await owner.get("/invites"));
    expect(list[0]).toMatchObject({ used: true, usedBy: "xiaoli" });
    // 新账号归到邀请人名下
    const row = await env.DB.prepare("SELECT created_by FROM users WHERE name = 'xiaoli'").first<{ created_by: number }>();
    expect(row?.created_by).toBe(owner.id);
  });

  it("乱填 / 过期的令牌无效", async () => {
    const owner = await seedUser("boss");
    expect((await api("/api/admin/join", { json: { token: "jci_nope", name: "xiaoli" }, admin: true })).status).toBe(400);
    expect((await parse<InviteInfoDTO>(await api("/api/admin/invite?token=jci_nope"))).valid).toBe(false);
    expect((await parse<InviteInfoDTO>(await api("/api/admin/invite"))).valid).toBe(false);

    const created = await parse<CreatedInviteDTO>(await owner.post("/invites", { role: "moderator" }));
    await env.DB.prepare("UPDATE invites SET expires_at = 1").run();
    expect((await api("/api/admin/join", { json: { token: created.token, name: "xiaoli" }, admin: true })).status).toBe(400);
  });

  it("名字重复 → 409，邀请还能再用", async () => {
    const owner = await seedUser("boss");
    const created = await parse<CreatedInviteDTO>(await owner.post("/invites", { role: "moderator" }));
    const taken = await api("/api/admin/join", { json: { token: created.token, name: "BOSS" }, admin: true }); // 名字不分大小写
    expect(taken.status).toBe(409);
    expect(await errorCode(taken)).toBe("name_taken");
    const ok = await api("/api/admin/join", { json: { token: created.token, name: "xiaoli" }, admin: true });
    expect(ok.status).toBe(200);
  });

  it("名字格式不对 → 422，邀请不受影响", async () => {
    const owner = await seedUser("boss");
    const created = await parse<CreatedInviteDTO>(await owner.post("/invites", { role: "moderator" }));
    expect((await api("/api/admin/join", { json: { token: created.token, name: "x" }, admin: true })).status).toBe(422);
    expect((await api("/api/admin/join", { json: { token: created.token, name: "xiaoli" }, admin: true })).status).toBe(200);
  });

  it("撤销没用过的邀请；用过的撤销不了", async () => {
    const owner = await seedUser("boss");
    const first = await parse<CreatedInviteDTO>(await owner.post("/invites", { role: "moderator" }));
    expect((await owner.del(`/invites/${first.invite.id}`)).status).toBe(200);
    expect((await api("/api/admin/join", { json: { token: first.token, name: "xiaoli" }, admin: true })).status).toBe(400);
    expect((await owner.del(`/invites/${first.invite.id}`)).status).toBe(404);

    const second = await parse<CreatedInviteDTO>(await owner.post("/invites", { role: "moderator" }));
    await api("/api/admin/join", { json: { token: second.token, name: "xiaoli" }, admin: true });
    expect((await owner.del(`/invites/${second.invite.id}`)).status).toBe(404);
    expect((await owner.del("/invites/not-hex")).status).toBe(400);
  });

  const joinWith = (token: string, name = "xiaoli") => api("/api/admin/join", { json: { token, name }, admin: true });
  const inviteInfo = async (token: string) => (await parse<InviteInfoDTO>(await api(`/api/admin/invite?token=${encodeURIComponent(token)}`))).valid;

  it("发邀请的人被停用以后，他发出去还没用的邀请就失效了（预览和加入都不行），库里也顺手清掉", async () => {
    const owner = await seedUser("boss");
    const admin = await seedUser("adm", "admin");
    const created = await parse<CreatedInviteDTO>(await admin.post("/invites", { role: "moderator" }));
    expect(await inviteInfo(created.token)).toBe(true);
    expect((await owner.patch(`/users/${admin.id}`, { disabled: true })).status).toBe(200);
    expect(await inviteInfo(created.token)).toBe(false);
    const res = await joinWith(created.token);
    expect(res.status).toBe(400);
    expect(await errorCode(res)).toBe("invalid_invite");
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM invites").first()).toEqual({ n: 0 });
  });

  it("创建者被降级：他发的邀请跟着作废", async () => {
    const owner = await seedUser("boss");
    const other = await seedUser("boss2");
    const created = await parse<CreatedInviteDTO>(await other.post("/invites", { role: "admin" }));
    expect(await inviteInfo(created.token)).toBe(true);
    await owner.patch(`/users/${other.id}`, { role: "admin" });
    expect(await inviteInfo(created.token)).toBe(false);
    expect((await joinWith(created.token)).status).toBe(400);
  });

  it("就算邀请还留在库里（直接改过库、绕过了清理），创建者被停用 / 权限不够了也不能用；资格回来又能用", async () => {
    const owner = await seedUser("boss");
    const created = await parse<CreatedInviteDTO>(await owner.post("/invites", { role: "admin" }));
    await env.DB.prepare("UPDATE users SET disabled = 1").run();
    expect(await inviteInfo(created.token)).toBe(false);
    expect((await joinWith(created.token)).status).toBe(400);
    await env.DB.prepare("UPDATE users SET disabled = 0, role = 'admin'").run(); // 降成管理员：不再有资格发「管理员」邀请
    expect(await inviteInfo(created.token)).toBe(false);
    expect((await joinWith(created.token)).status).toBe(400);
    await env.DB.prepare("UPDATE users SET role = 'owner'").run();
    expect(await inviteInfo(created.token)).toBe(true);
    expect((await joinWith(created.token)).status).toBe(200);
  });

  it("按 README 的应急办法清空账号表以后，旧邀请失效，真站长还能走安装页（不会先被拿旧邀请的人抢走）", async () => {
    const owner = await seedUser("boss");
    const created = await parse<CreatedInviteDTO>(await owner.post("/invites", { role: "moderator" }));
    await env.DB.prepare("DELETE FROM users").run();
    expect(await inviteInfo(created.token)).toBe(false);
    expect((await joinWith(created.token)).status).toBe(400);
    expect((await setup({ token: "test-setup-token", name: "newboss" })).status).toBe(200);
    expect((await joinWith(created.token)).status).toBe(400); // 安装以后旧邀请依然不能用
  });

  it("保留名（system / app）不能注册：操作日志里 actor 用它们表示定时任务和脚本里的提交", async () => {
    const owner = await seedUser("boss");
    for (const name of ["system", "SYSTEM", "app", "App"]) {
      const created = await parse<CreatedInviteDTO>(await owner.post("/invites", { role: "moderator" }));
      const res = await joinWith(created.token, name);
      expect(res.status, name).toBe(422);
      expect(await errorCode(res)).toBe("invalid_name");
    }
  });

  it("看不见的字符不能进名字（零宽空格、韩文填充符、方向控制符）；全角字母规整成普通字母，不能用 ＢＯＳＳ 冒充 boss", async () => {
    const owner = await seedUser("boss");
    const token = async () => (await parse<CreatedInviteDTO>(await owner.post("/invites", { role: "moderator" }))).token;
    const hidden = [`xia${String.fromCharCode(0x200b)}oli`, String.fromCharCode(0x3164, 0x3164, 0x3164), `xiaoli${String.fromCharCode(0x202e)}`];
    for (const name of hidden) {
      const res = await joinWith(await token(), name);
      expect(res.status, JSON.stringify(name)).toBe(422);
    }
    expect((await joinWith(await token(), "ＢＯＳＳ")).status).toBe(409); // 规整成 BOSS，和已有的 boss 撞（不分大小写）
    const ok = await joinWith(await token(), "ｘｉａｏｌｉ");
    expect((await parse<LoginResultDTO>(ok)).me.user.name).toBe("xiaoli");
  });

  it("同时有效的邀请最多 20 个", async () => {
    const owner = await seedUser("boss");
    const now = Date.now();
    for (let i = 0; i < 20; i++) {
      await env.DB.prepare("INSERT INTO invites (token_hash, role, created_at, expires_at) VALUES (?, 'moderator', ?, ?)").bind(`hash${i}`, now, now + 86_400_000).run();
    }
    const res = await owner.post("/invites", { role: "moderator" });
    expect(res.status).toBe(409);
    expect(await errorCode(res)).toBe("too_many_invites");
  });

  it("加入接口按 IP 限频", async () => {
    for (let i = 0; i < 20; i++) expect((await api("/api/admin/join", { json: { token: `jci_x${i}`, name: "xiaoli" }, admin: true })).status).toBe(400);
    expect((await api("/api/admin/join", { json: { token: "jci_x", name: "xiaoli" }, admin: true })).status).toBe(429);
  });
});

describe("账号管理（站长）", () => {
  it("改角色 / 停用 / 恢复；留日志", async () => {
    const owner = await seedUser("boss");
    const target = await seedUser("xiaoli", "moderator");
    const promoted = await owner.patch(`/users/${target.id}`, { role: "admin" });
    expect(promoted.status).toBe(200);
    expect(await parse<UserDTO>(promoted)).toMatchObject({ role: "admin", disabled: false });

    const disabled = await parse<UserDTO>(await owner.patch(`/users/${target.id}`, { disabled: true }));
    expect(disabled.disabled).toBe(true);
    const enabled = await parse<UserDTO>(await owner.patch(`/users/${target.id}`, { disabled: false }));
    expect(enabled.disabled).toBe(false);

    const log = await env.DB.prepare("SELECT actor, target_id FROM audit_log WHERE action = 'user.update' ORDER BY id").all();
    expect(log.results).toHaveLength(3);
    expect(log.results[0]).toEqual({ actor: "boss", target_id: "xiaoli" });
  });

  it("没变化就原样返回，不写日志", async () => {
    const owner = await seedUser("boss");
    const target = await seedUser("xiaoli", "moderator");
    expect((await owner.patch(`/users/${target.id}`, { role: "moderator", disabled: false })).status).toBe(200);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'user.update'").first()).toEqual({ n: 0 });
  });

  it("不能改自己；角色 / 状态值不合法 → 422；账号不存在 → 404", async () => {
    const owner = await seedUser("boss");
    const target = await seedUser("xiaoli", "moderator");
    const self = await owner.patch(`/users/${owner.id}`, { role: "moderator" });
    expect(self.status).toBe(409);
    expect(await errorCode(self)).toBe("self");
    expect((await owner.patch(`/users/${target.id}`, { role: "emperor" })).status).toBe(422);
    expect((await owner.patch(`/users/${target.id}`, { disabled: "yes" })).status).toBe(422);
    expect((await owner.patch("/users/999999", { role: "admin" })).status).toBe(404);
  });

  it("停用 → 对方的会话立刻失效，App 口令也不能用", async () => {
    const owner = await seedUser("boss");
    const target = await seedUser("xiaoli", "moderator");
    const pw = await seedAppKey(target);
    expect((await target.get("/me")).status).toBe(200);
    await owner.patch(`/users/${target.id}`, { disabled: true });
    expect((await target.get("/me")).status).toBe(401);
    expect(await (await upload("author", { av: makeItem(1), mode: "upload", pw })).text()).toBe("NA");
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?").bind(target.id).first()).toEqual({ n: 0 });
  });

  it("改角色立刻生效（会话不用重登）", async () => {
    const owner = await seedUser("boss");
    const target = await seedUser("xiaoli", "admin");
    expect((await target.get("/bans")).status).toBe(200);
    await owner.patch(`/users/${target.id}`, { role: "moderator" });
    expect((await target.get("/bans")).status).toBe(403);
  });

  it("重置访问密钥：旧密钥登不上，新密钥可以，对方会话被踢", async () => {
    const owner = await seedUser("boss");
    const target = await seedUser("xiaoli", "moderator");
    const res = await owner.post(`/users/${target.id}/reset-key`);
    expect(res.status).toBe(200);
    const { accessKey } = await parse<{ accessKey: string }>(res);
    expect((await login(target.accessKey)).status).toBe(401);
    expect((await login(accessKey)).status).toBe(200);
    expect((await target.get("/me")).status).toBe(401);
  });

  it("重置访问密钥会同时撤销他的 App 口令（账号被盗期间攻击者生成的口令不能留着）", async () => {
    const owner = await seedUser("boss");
    const target = await seedUser("xiaoli", "moderator");
    const pw = await seedAppKey(target);
    expect(await (await upload("author", { av: makeItem(1), mode: "upload", pw })).text()).toBe("succeed");
    expect((await owner.post(`/users/${target.id}/reset-key`)).status).toBe(200);
    expect(await (await upload("author", { av: makeItem(2), mode: "upload", pw })).text()).toBe("NA");
    // 自己换密钥（rotate-key）不撤口令：那是日常操作，口令由本人单独管理
    const mine = await seedUser("amy", "moderator");
    const minePw = await seedAppKey(mine);
    await mine.post("/me/rotate-key");
    expect(await (await upload("author", { av: makeItem(3), mode: "upload", pw: minePw })).text()).toBe("succeed");
  });

  it("两位站长同时把对方降级：不会一个站长都不剩（「还有别的站长」是写在 UPDATE 里判断的，不是先数后改）", async () => {
    const a = await seedUser("owner-a");
    const b = await seedUser("owner-b");
    const results = await Promise.all([a.patch(`/users/${b.id}`, { role: "admin" }), b.patch(`/users/${a.id}`, { role: "admin" })]);
    expect(results.map((r) => r.status)).toContain(200);
    const owners = await env.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'owner' AND disabled = 0").first<{ n: number }>();
    expect(owners?.n).toBe(1);
  });

  it("重置二次验证", async () => {
    const owner = await seedUser("boss");
    const target = await seedUser("xiaoli", "moderator");
    await env.DB.prepare("UPDATE users SET totp_enabled = 1, totp_secret = 'ABCDEFGH' WHERE id = ?").bind(target.id).run();
    expect((await owner.post(`/users/${target.id}/reset-totp`)).status).toBe(200);
    expect(await env.DB.prepare("SELECT totp_enabled, totp_secret FROM users WHERE id = ?").bind(target.id).first()).toEqual({ totp_enabled: 0, totp_secret: "" });
    expect((await owner.post("/users/999999/reset-totp")).status).toBe(404);
  });

  it("账号列表：站长在前，其次管理员、协管，同级按名字", async () => {
    const admin = await seedUser("zed", "admin");
    await seedUser("amy", "moderator");
    await seedUser("bob", "owner");
    await seedUser("cat", "admin");
    const list = await parse<UserDTO[]>(await admin.get("/users"));
    expect(list.map((u) => u.name)).toEqual(["bob", "cat", "zed", "amy"]);
  });
});

describe("二次验证（TOTP）", () => {
  it("完整流程：开始 → 开启 → 登录要验证码 → 关闭", async () => {
    const boss = await seedUser("boss");
    const started = await parse<TotpStartDTO>(await boss.post("/me/totp/start"));
    expect(started.secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(started.uri).toContain(started.secret);

    expect((await boss.post("/me/totp/enable", { code: "000000" })).status).toBe(401);
    expect((await boss.post("/me/totp/enable", { code: await totpCode(started.secret, Date.now()) })).status).toBe(200);
    expect((await parse<MeDTO>(await boss.get("/me"))).user.totpEnabled).toBe(true);

    const missing = await login(boss.accessKey);
    expect(missing.status).toBe(401);
    expect(await errorCode(missing)).toBe("totp_required");
    const wrong = await login(boss.accessKey, { totp: "123456" });
    expect(await errorCode(wrong)).toBe("totp_invalid");
    const ok = await login(boss.accessKey, { totp: await totpCode(started.secret, Date.now()) });
    expect(ok.status).toBe(200);

    expect((await boss.post("/me/totp/disable", { code: "000000" })).status).toBe(401);
    expect((await boss.post("/me/totp/disable", { code: await totpCode(started.secret, Date.now()) })).status).toBe(200);
    expect((await login(boss.accessKey)).status).toBe(200);
  });

  it("验证码试错 5 次后锁 10 分钟（密钥是对的也一样）", async () => {
    const boss = await seedUser("boss");
    const started = await parse<TotpStartDTO>(await boss.post("/me/totp/start"));
    await boss.post("/me/totp/enable", { code: await totpCode(started.secret, Date.now()) });
    for (let i = 0; i < 5; i++) expect((await login(boss.accessKey, { totp: "000000" })).status).toBe(401);
    const locked = await login(boss.accessKey, { totp: await totpCode(started.secret, Date.now()) });
    expect(locked.status).toBe(429);
  });

  it("并发猜验证码也只放得过 5 次（先原子占名额再校验，不是先读后写）", async () => {
    const boss = await seedUser("boss");
    const started = await parse<TotpStartDTO>(await boss.post("/me/totp/start"));
    await boss.post("/me/totp/enable", { code: await totpCode(started.secret, Date.now()) });
    const results = await Promise.all(Array.from({ length: 25 }, () => login(boss.accessKey, { totp: "000000" })));
    const statuses = results.map((r) => r.status);
    expect(statuses.filter((s) => s === 401)).toHaveLength(5);
    expect(statuses.filter((s) => s === 429)).toHaveLength(20);
  });

  it("验证码输对了，前面的试错作废：不会因为偶尔输错几次，累积着把自己锁在外面", async () => {
    const boss = await seedUser("boss");
    const started = await parse<TotpStartDTO>(await boss.post("/me/totp/start"));
    await boss.post("/me/totp/enable", { code: await totpCode(started.secret, Date.now()) });
    for (let round = 0; round < 3; round++) {
      for (let i = 0; i < 4; i++) expect((await login(boss.accessKey, { totp: "000000" })).status).toBe(401);
      expect((await login(boss.accessKey, { totp: await totpCode(started.secret, Date.now()) })).status).toBe(200);
    }
  });

  it("状态不对 → 409：没开始就开启 / 已开启还要开始 / 没开启就关闭", async () => {
    const boss = await seedUser("boss");
    expect((await boss.post("/me/totp/enable", { code: "123456" })).status).toBe(409);
    expect((await boss.post("/me/totp/disable", { code: "123456" })).status).toBe(409);
    const started = await parse<TotpStartDTO>(await boss.post("/me/totp/start"));
    await boss.post("/me/totp/enable", { code: await totpCode(started.secret, Date.now()) });
    expect((await boss.post("/me/totp/start")).status).toBe(409);
    expect((await boss.post("/me/totp/enable", { code: "123456" })).status).toBe(409);
  });
});

describe("换访问密钥", () => {
  it("旧密钥作废；当前会话保留，别的会话被踢", async () => {
    const boss = await seedUser("boss");
    const other = await login(boss.accessKey);
    const otherCookie = cookieOf(other);
    expect((await api("/api/admin/me", { cookie: otherCookie })).status).toBe(200);

    const res = await boss.post("/me/rotate-key");
    expect(res.status).toBe(200);
    const { accessKey } = await parse<{ accessKey: string }>(res);
    expect(accessKey).not.toBe(boss.accessKey);

    expect((await boss.get("/me")).status).toBe(200);
    expect((await api("/api/admin/me", { cookie: otherCookie })).status).toBe(401);
    expect((await login(boss.accessKey)).status).toBe(401);
    expect((await login(accessKey)).status).toBe(200);
  });
});

describe("App 口令", () => {
  it("创建 → 列表（不含明文）→ 用它在作者通道提交 → 撤销 → 不能再用", async () => {
    const boss = await seedUser("boss", "moderator");
    const created = await boss.post("/me/app-keys", { name: "我的 iPhone" });
    expect(created.status).toBe(201);
    const { key, appKey } = await parse<CreatedAppKeyDTO>(created);
    expect(key).toMatch(/^jca_/);
    expect(appKey).toMatchObject({ name: "我的 iPhone", revoked: false, lastUsedAt: null });

    const list = await parse<AppKeyDTO[]>(await boss.get("/me/app-keys"));
    expect(list).toHaveLength(1);
    expect(JSON.stringify(list)).not.toContain(key);

    expect(await (await upload("author", { av: makeItem(1), mode: "upload", pw: key })).text()).toBe("succeed");
    expect(await listCodes("author")).toEqual(["ABC-001"]);
    expect((await parse<AppKeyDTO[]>(await boss.get("/me/app-keys")))[0]?.lastUsedAt).not.toBeNull();

    expect((await boss.del(`/me/app-keys/${appKey.id}`)).status).toBe(200);
    expect(await (await upload("author", { av: makeItem(2), mode: "upload", pw: key })).text()).toBe("NA");
    expect((await parse<AppKeyDTO[]>(await boss.get("/me/app-keys")))[0]?.revoked).toBe(true);
    expect((await boss.del(`/me/app-keys/${appKey.id}`)).status).toBe(404); // 已经撤销了
  });

  it("名字不能空；最多 10 个有效口令", async () => {
    const boss = await seedUser("boss", "moderator");
    expect((await boss.post("/me/app-keys", { name: "  " })).status).toBe(422);
    for (let i = 0; i < 10; i++) expect((await boss.post("/me/app-keys", { name: `k${i}` })).status).toBe(201);
    const res = await boss.post("/me/app-keys", { name: "one-more" });
    expect(res.status).toBe(409);
    expect(await errorCode(res)).toBe("too_many_keys");
  });

  it("别人的口令撤销不了（404）；列表只看得到自己的", async () => {
    const alice = await seedUser("alice", "moderator");
    const bob = await seedUser("bob", "moderator");
    const { appKey } = await parse<CreatedAppKeyDTO>(await alice.post("/me/app-keys", { name: "alice-phone" }));
    expect((await bob.del(`/me/app-keys/${appKey.id}`)).status).toBe(404);
    expect(await parse<AppKeyDTO[]>(await bob.get("/me/app-keys"))).toEqual([]);
  });
});

describe("安全性小检查", () => {
  it("响应里永远不出现密钥哈希 / TOTP 密钥", async () => {
    const boss = await seedUser("boss");
    await boss.post("/me/totp/start");
    const bodies = [await (await boss.get("/me")).text(), await (await boss.get("/users")).text()];
    for (const text of bodies) {
      expect(text).not.toContain("key_hash");
      expect(text).not.toContain("totp_secret");
      expect(text).not.toMatch(/[0-9a-f]{64}/);
    }
  });

  it("call() 走的是真实入口：不存在的路径落到静态资源兜底，不是后台接口", async () => {
    const res = await call(new Request(`${BASE}/api/admin/definitely-not-here`, { headers: { "X-JC-Admin": "1" } }));
    expect(res.status).toBe(401); // 先过登录，没登录就别想探路径
  });
});
