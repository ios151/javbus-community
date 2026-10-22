import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";

import type { MetaDTO } from "../shared/types";
import {
  api,
  deviceHash,
  ipHash,
  listCodes,
  makeItem,
  parse,
  reportFrom,
  resetDb,
  seedAppKey,
  seedUser,
  setSettings,
  submit,
  upload,
} from "./helpers";

const DAY = 86_400_000;

beforeEach(resetDb);

async function report(code: string, device?: string, extra: Record<string, unknown> = {}): Promise<string> {
  return (await reportFrom(device, code, extra)).text();
}

describe("公开列表", () => {
  it("新提交的排最前（同一毫秒里提交的也按先后）", async () => {
    for (const n of [1, 2, 3]) expect(await submit(n)).toBe("succeed");
    expect(await listCodes("user")).toEqual(["ABC-003", "ABC-002", "ABC-001"]);
  });

  it("列表项只有 code / info / src / link 四个字段（脚本按这个读）", async () => {
    await submit(1);
    const rows = await parse<Record<string, unknown>[]>(await api("/api/v1/rec/user"));
    expect(rows).toEqual([makeItem(1)]);
  });

  it("ETag 随快照版本变；带 If-None-Match 且没变就回 304（不带正文）", async () => {
    await submit(1);
    const first = await api("/api/v1/rec/user");
    const etag = first.headers.get("ETag");
    expect(etag).toBe('W/"user-1"');
    expect(first.headers.get("Cache-Control")).toBe("no-cache");
    expect(first.headers.get("X-Total-Count")).toBe("1");

    const same = await api("/api/v1/rec/user", { headers: { "If-None-Match": etag ?? "" } });
    expect(same.status).toBe(304);
    expect(await same.text()).toBe("");
    expect((await api("/api/v1/rec/user", { headers: { "If-None-Match": "*" } })).status).toBe(304);
    expect((await api("/api/v1/rec/user", { headers: { "If-None-Match": 'W/"user-0", W/"user-1"' } })).status).toBe(304);

    await submit(2);
    const changed = await api("/api/v1/rec/user", { headers: { "If-None-Match": etag ?? "" } });
    expect(changed.status).toBe(200);
    expect(changed.headers.get("ETag")).toBe('W/"user-2"');
  });

  it("两个频道各自独立；不存在的频道 404", async () => {
    await submit(1);
    expect(await listCodes("author")).toEqual([]);
    expect((await api("/api/v1/rec/nope")).status).toBe(404);
  });

  it("读接口允许跨域；改数据的接口没有跨域头", async () => {
    const read = await api("/api/v1/rec/user", { headers: { Origin: "https://example.org" } });
    expect(read.headers.get("Access-Control-Allow-Origin")).toBe("*");
    const write = await api("/api/v1/upload/user", { json: { av: makeItem(1), mode: "upload" }, headers: { Origin: "https://example.org" } });
    expect(write.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("meta：名称 / 版本 / 维护状态 / 各频道条数", async () => {
    await submit(1);
    await submit(2);
    const meta = await parse<MetaDTO>(await api("/api/v1/meta"));
    expect(meta).toEqual({ name: "JavBus 社区推荐", version: "1.0.0", maintenance: false, autoApprove: true, channels: { user: 2, author: 0 } });
  });

  it("health", async () => {
    expect((await api("/api/v1/health")).status).toBe(200);
  });

  it("未知接口返回 JSON 404", async () => {
    const res = await api("/api/v1/nope");
    expect(res.status).toBe(404);
    expect(await parse(res)).toEqual({ error: { code: "not_found", message: "没有这个接口" } });
    expect((await api("/api/v1/rec/user", { method: "POST", json: {} })).status).toBe(404);
  });
});

describe("提交（网友通道）", () => {
  it("成功 = 200 + succeed", async () => {
    const res = await upload("user", { av: makeItem(1), mode: "upload" });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("succeed");
    expect(res.headers.get("Content-Type")).toContain("text/plain");
  });

  it("番号查重不分大小写（409 + RE）", async () => {
    await submit(1);
    const res = await upload("user", { av: makeItem(1, { code: "abc-001" }), mode: "upload" });
    expect(res.status).toBe(409);
    expect(await res.text()).toBe("RE");
    expect(await listCodes("user")).toEqual(["ABC-001"]);
  });

  it("同一个番号可以同时在两个频道（各查各的）", async () => {
    const maintainer = await seedUser("alice", "moderator");
    const pw = await seedAppKey(maintainer);
    await submit(1);
    expect(await (await upload("author", { av: makeItem(1), mode: "upload", pw })).text()).toBe("succeed");
    expect(await listCodes("author")).toEqual(["ABC-001"]);
  });

  it.each([
    ["番号格式不对", { av: makeItem(1, { code: "bad code!" }), mode: "upload" }],
    ["缺详情页地址", { av: makeItem(1, { link: "" }), mode: "upload" }],
    ["内网地址", { av: makeItem(1, { link: "http://192.168.0.1/x" }), mode: "upload" }],
    ["mode 不认识", { av: makeItem(1), mode: "update" }],
    ["缺 mode", { av: makeItem(1) }],
    ["av 不是对象", { av: "ABC-001", mode: "upload" }],
    ["av 缺失", { mode: "upload" }],
  ])("格式错误 → 400 + FE：%s", async (_name, body) => {
    const res = await upload("user", body);
    expect(res.status).toBe(400);
    expect(await res.text()).toBe("FE");
    expect(await listCodes("user")).toEqual([]);
  });

  it("请求体不是 JSON / 是数组 / 超过 8 KB / 频道名不对 → FE", async () => {
    expect(await (await api("/api/v1/upload/user", { raw: "not json" })).text()).toBe("FE");
    expect(await (await api("/api/v1/upload/user", { raw: "[]" })).text()).toBe("FE");
    expect(await (await api("/api/v1/upload/user", { raw: "x".repeat(9000) })).text()).toBe("FE");
    expect(await (await api("/api/v1/upload/nope", { json: { av: makeItem(1), mode: "upload" } })).text()).toBe("FE");
  });

  it("GET 上传接口 = 404", async () => {
    expect((await api("/api/v1/upload/user")).status).toBe(404);
  });

  it("屏蔽词（不分大小写）和网站名单生效", async () => {
    await setSettings({ blockedWords: "spam\nbadword", allowedHosts: "javbus.com" });
    expect(await (await upload("user", { av: makeItem(1, { info: "this is SPAM" }), mode: "upload" })).text()).toBe("FE");
    expect(await (await upload("user", { av: makeItem(2, { link: "https://evil.example.com/x" }), mode: "upload" })).text()).toBe("FE");
    expect(await (await upload("user", { av: makeItem(3, { src: "https://evil.example.com/c.jpg" }), mode: "upload" })).text()).toBe("FE");
    expect(await submit(4)).toBe("succeed");
    expect(await listCodes("user")).toEqual(["ABC-004"]);
  });

  it("关掉「直接上线」：返回 202 + PD，进待审，不进公开列表", async () => {
    await setSettings({ autoApproveUser: false });
    const res = await upload("user", { av: makeItem(1), mode: "upload" });
    expect(res.status).toBe(202);
    expect(await res.text()).toBe("PD");
    expect(await listCodes("user")).toEqual([]);
    const row = await env.DB.prepare("SELECT status FROM items WHERE code = 'ABC-001'").first<{ status: string }>();
    expect(row?.status).toBe("pending");
  });

  it("维护模式：503 + OFF，列表照常读", async () => {
    await submit(1);
    await setSettings({ maintenance: true });
    const res = await upload("user", { av: makeItem(2), mode: "upload" });
    expect(res.status).toBe(503);
    expect(await res.text()).toBe("OFF");
    expect(await listCodes("user")).toEqual(["ABC-001"]);
  });

  it("按设备限频：超了 429 + RL", async () => {
    await setSettings({ submitPerHourDevice: 2 });
    const device = "device-limit-0001";
    expect(await submit(1, { device })).toBe("succeed");
    expect(await submit(2, { device })).toBe("succeed");
    const res = await upload("user", { av: makeItem(3), mode: "upload" }, { device });
    expect(res.status).toBe(429);
    expect(await res.text()).toBe("RL");
    // 换一个设备不受影响
    expect(await submit(3, { device: "device-limit-0002" })).toBe("succeed");
  });

  it("按 IP 限频；没带设备号也照样限", async () => {
    await setSettings({ submitPerHourIp: 2 });
    expect(await submit(1, { ip: "198.51.100.1" })).toBe("succeed");
    expect(await submit(2, { ip: "198.51.100.1" })).toBe("succeed");
    expect(await submit(3, { ip: "198.51.100.1" })).toBe("RL");
    expect(await submit(3, { ip: "198.51.100.2" })).toBe("succeed");
  });

  it("IPv6 按 /64 归并：同一段里换地址绕不过按 IP 的限频（家庭 / 机构拿到的是整段 /64）", async () => {
    await setSettings({ submitPerHourIp: 3 });
    const results: string[] = [];
    for (let i = 1; i <= 5; i++) results.push(await submit(i, { ip: `2001:db8:abcd:12::${i.toString(16)}` }));
    expect(results).toEqual(["succeed", "succeed", "succeed", "RL", "RL"]);
    expect(await submit(6, { ip: "2001:db8:abcd:13::1" })).toBe("succeed"); // 另一个 /64 不受影响
  });

  it("IPv6 封禁也是按 /64：封的是那一整段", async () => {
    const banned = "2001:db8:abcd:12::1";
    await env.DB.prepare("INSERT INTO banned (kind, value, created_at) VALUES ('ip', ?, ?)").bind(await ipHash(banned), Date.now()).run();
    expect(await submit(1, { ip: "2001:db8:abcd:12::beef" })).toBe("BN");
    expect(await submit(2, { ip: "2001:db8:abcd:13::1" })).toBe("succeed");
  });

  it("设备号格式不对（太短 / 含怪字符）当没带：不能靠乱填设备号绕过 IP 限频", async () => {
    await setSettings({ submitPerHourIp: 1 });
    expect(await submit(1, { device: "short" })).toBe("succeed");
    expect(await submit(2, { device: "bad device id!!" })).toBe("RL");
  });

  it("被封的设备 / IP / 番号：403 + BN", async () => {
    const device = "device-banned-001";
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO banned (kind, value, created_at) VALUES ('device', ?, ?)").bind(await deviceHash(device), now),
      env.DB.prepare("INSERT INTO banned (kind, value, created_at) VALUES ('ip', ?, ?)").bind(await ipHash("198.51.100.9"), now),
      env.DB.prepare("INSERT INTO banned (kind, value, created_at) VALUES ('code', ?, ?)").bind("abc-777", now),
    ]);
    const byDevice = await upload("user", { av: makeItem(1), mode: "upload" }, { device });
    expect(byDevice.status).toBe(403);
    expect(await byDevice.text()).toBe("BN");
    expect(await submit(2, { ip: "198.51.100.9" })).toBe("BN");
    expect(await submit(777)).toBe("BN"); // 番号封禁不分大小写
    expect(await submit(3)).toBe("succeed");
  });

  it("列表装满了：507 + FULL", async () => {
    // 条数上限最小 100；直接把快照改成「已满」，不用真插 100 条
    await setSettings({ maxItemsPerChannel: 100 });
    await submit(1);
    await env.DB.prepare("UPDATE snapshots SET count = 100 WHERE channel = 'user'").run();
    const res = await upload("user", { av: makeItem(2), mode: "upload" });
    expect(res.status).toBe(507);
    expect(await res.text()).toBe("FULL");
  });

  it("快照接近 2 MB 单行上限也算满", async () => {
    await submit(1);
    await env.DB.prepare("UPDATE snapshots SET bytes = 1900000 WHERE channel = 'user'").run();
    expect(await submit(2)).toBe("FULL");
  });

  it("同一个已被拒绝的番号可以重新提交；已隐藏的不行", async () => {
    await setSettings({ autoApproveUser: false });
    expect(await submit(1)).toBe("PD");
    await env.DB.prepare("UPDATE items SET status = 'rejected' WHERE code = 'ABC-001'").run();
    expect(await submit(1)).toBe("PD");
    const row = await env.DB.prepare("SELECT status, reviewed_by FROM items WHERE code = 'ABC-001'").first();
    expect(row).toEqual({ status: "pending", reviewed_by: null });

    await env.DB.prepare("UPDATE items SET status = 'hidden' WHERE code = 'ABC-001'").run();
    expect(await submit(1)).toBe("RE");
  });

  it("匿名提交不写操作日志（条目本身带着提交者哈希和时间；每条都写一行，日志会被刷爆）；维护者用口令提交才记一条", async () => {
    await submit(1, { device: "device-audit-001" });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM audit_log").first()).toEqual({ n: 0 });
    const pw = await seedAppKey(await seedUser("alice", "moderator"));
    await upload("author", { av: makeItem(2), mode: "upload", pw });
    expect(await env.DB.prepare("SELECT actor, action, target_id FROM audit_log").first()).toEqual({ actor: "alice", action: "item.create", target_id: "ABC-002" });
  });

  it("总闸：所有人加起来每天最多收这么多条，超了 429 + RL；被前面拦下的（按 IP 限频、重复）不占名额；维护者不受限", async () => {
    await setSettings({ submitPerDayGlobal: 10, submitPerHourIp: 1 });
    // 一个 IP 狂发 15 次：只有第 1 条入库，其余被按 IP 限频拦下，不该占总闸的名额
    const burst: string[] = [];
    for (let i = 1; i <= 15; i++) burst.push(await submit(i, { ip: "198.51.100.100" }));
    expect(burst.filter((r) => r === "succeed")).toHaveLength(1);
    // 重复提交（已在列表）也不占名额
    for (let i = 0; i < 5; i++) expect(await submit(1, { ip: `198.51.100.${150 + i}` })).toBe("RE");
    // 剩下 9 个名额：9 个不同的 IP 各提交一条新的
    for (let i = 0; i < 9; i++) expect(await submit(100 + i, { ip: `198.51.100.${110 + i}` })).toBe("succeed");
    // 再来一条新的：总闸挡下
    const blocked = await upload("user", { av: makeItem(200), mode: "upload" }, { ip: "198.51.100.200" });
    expect(blocked.status).toBe(429);
    expect(await blocked.text()).toBe("RL");
    // 维护者带口令提交不受总闸限制
    const pw = await seedAppKey(await seedUser("alice", "moderator"));
    expect(await (await upload("user", { av: makeItem(201), mode: "upload", pw }, { ip: "198.51.100.201" })).text()).toBe("succeed");
  });
});

describe("作者通道（维护者 App 口令）", () => {
  it("没口令 → 401 + NA", async () => {
    const res = await upload("author", { av: makeItem(1), mode: "upload" });
    expect(res.status).toBe(401);
    expect(await res.text()).toBe("NA");
  });

  it("口令不对 → NA；连续试错 20 次后 429 + RL", async () => {
    for (let i = 0; i < 20; i++) {
      expect(await (await upload("author", { av: makeItem(1), mode: "upload", pw: `jca_wrong${i}` })).text()).toBe("NA");
    }
    expect(await (await upload("author", { av: makeItem(1), mode: "upload", pw: "jca_wrong-again" })).text()).toBe("RL");
  });

  it("口令对 → 直接上线（不受网站名单 / 屏蔽词限制）", async () => {
    await setSettings({ allowedHosts: "javbus.com", blockedWords: "spam" });
    const maintainer = await seedUser("alice", "moderator");
    const pw = await seedAppKey(maintainer);
    const res = await upload("author", { av: makeItem(1, { link: "https://other.example.com/x", info: "spam ok" }), mode: "upload", pw });
    expect(await res.text()).toBe("succeed");
    expect(await listCodes("author")).toEqual(["ABC-001"]);
    const row = await env.DB.prepare("SELECT created_by FROM items WHERE code = 'ABC-001'").first<{ created_by: number }>();
    expect(row?.created_by).toBe(maintainer.id);
  });

  it("口令也能往网友频道提交，且不受限频和维护模式影响", async () => {
    await setSettings({ maintenance: true, submitPerHourIp: 1 });
    const pw = await seedAppKey(await seedUser("alice", "moderator"));
    for (const n of [1, 2, 3]) expect(await (await upload("user", { av: makeItem(n), mode: "upload", pw })).text()).toBe("succeed");
  });

  it("撤销的口令 / 被停用账号的口令都不能用", async () => {
    const maintainer = await seedUser("alice", "moderator");
    const pw = await seedAppKey(maintainer);
    await env.DB.prepare("UPDATE app_keys SET revoked = 1").run();
    expect(await (await upload("author", { av: makeItem(1), mode: "upload", pw })).text()).toBe("NA");
    await env.DB.prepare("UPDATE app_keys SET revoked = 0").run();
    await env.DB.prepare("UPDATE users SET disabled = 1").run();
    expect(await (await upload("author", { av: makeItem(1), mode: "upload", pw })).text()).toBe("NA");
  });

  it("使用口令会记下最后使用时间", async () => {
    const pw = await seedAppKey(await seedUser("alice", "moderator"));
    await upload("author", { av: makeItem(1), mode: "upload", pw });
    const row = await env.DB.prepare("SELECT last_used_at FROM app_keys").first<{ last_used_at: number | null }>();
    expect(row?.last_used_at).not.toBeNull();
  });
});

describe("撤销（mode: del）", () => {
  it("口令撤销：成功；没有这条 → 404 + NF", async () => {
    const pw = await seedAppKey(await seedUser("alice", "moderator"));
    await submit(1);
    expect(await (await upload("user", { av: "ABC-001", mode: "del", pw })).text()).toBe("succeed");
    expect(await listCodes("user")).toEqual([]);
    const missing = await upload("user", { av: "ABC-001", mode: "del", pw });
    expect(missing.status).toBe(404);
    expect(await missing.text()).toBe("NF");
  });

  it("撤销的 av 是番号字符串，不是对象", async () => {
    const pw = await seedAppKey(await seedUser("alice", "moderator"));
    await submit(1);
    expect(await (await upload("user", { av: makeItem(1), mode: "del", pw })).text()).toBe("FE");
  });

  it("提交者自己（同一个设备）可以在期限内撤销", async () => {
    const device = "device-self-0001";
    await submit(1, { device });
    expect(await (await upload("user", { av: "ABC-001", mode: "del" }, { device })).text()).toBe("succeed");
    expect(await listCodes("user")).toEqual([]);
  });

  it("别的设备撤销 = 401 + NA，条目还在", async () => {
    await submit(1, { device: "device-self-0001" });
    const res = await upload("user", { av: "ABC-001", mode: "del" }, { device: "device-other-0002" });
    expect(res.status).toBe(401);
    expect(await res.text()).toBe("NA");
    expect(await listCodes("user")).toEqual(["ABC-001"]);
  });

  it("没带设备号 = NA（没法证明是自己提交的）", async () => {
    await submit(1, { device: "device-self-0001" });
    expect(await (await upload("user", { av: "ABC-001", mode: "del" })).text()).toBe("NA");
  });

  it("超过期限 = NA；期限设成 0 = 一律不许", async () => {
    const device = "device-self-0001";
    await submit(1, { device });
    await env.DB.prepare("UPDATE items SET created_at = created_at - ?").bind(8 * DAY).run();
    expect(await (await upload("user", { av: "ABC-001", mode: "del" }, { device })).text()).toBe("NA");
    await env.DB.prepare("UPDATE items SET created_at = created_at + ?").bind(8 * DAY).run();
    await setSettings({ ownDeleteDays: 0 });
    expect(await (await upload("user", { av: "ABC-001", mode: "del" }, { device })).text()).toBe("NA");
  });

  it("待审的也能自己撤销", async () => {
    await setSettings({ autoApproveUser: false });
    const device = "device-self-0001";
    expect(await submit(1, { device })).toBe("PD");
    expect(await (await upload("user", { av: "ABC-001", mode: "del" }, { device })).text()).toBe("succeed");
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM items").first()).toEqual({ n: 0 });
  });

  it("已被维护者隐藏的，提交者不能自己删（留着证据）", async () => {
    const device = "device-self-0001";
    await submit(1, { device });
    await env.DB.prepare("UPDATE items SET status = 'hidden'").run();
    expect(await (await upload("user", { av: "ABC-001", mode: "del" }, { device })).text()).toBe("NA");
  });

  it("作者频道没口令不能删；自己提交的网友推荐没有的番号 = NF", async () => {
    expect(await (await upload("author", { av: "ABC-001", mode: "del" }, { device: "device-self-0001" })).text()).toBe("NA");
    const res = await upload("user", { av: "ABC-999", mode: "del" }, { device: "device-self-0001" });
    expect(res.status).toBe(404);
  });

  it("被封禁的设备不能撤销", async () => {
    const device = "device-banned-001";
    await submit(1, { device });
    await env.DB.prepare("INSERT INTO banned (kind, value, created_at) VALUES ('device', ?, ?)").bind(await deviceHash(device), Date.now()).run();
    expect(await (await upload("user", { av: "ABC-001", mode: "del" }, { device })).text()).toBe("BN");
  });

  it("撤销会重建快照并留日志", async () => {
    const device = "device-self-0001";
    await submit(1, { device });
    await submit(2, { device });
    await upload("user", { av: "ABC-001", mode: "del" }, { device });
    expect(await listCodes("user")).toEqual(["ABC-002"]);
    const row = await env.DB.prepare("SELECT actor, action FROM audit_log WHERE action = 'item.self_delete'").first();
    expect(row).toEqual({ actor: "app", action: "item.self_delete" });
  });
});

describe("举报", () => {
  it("三个不同的人举报 → 自动隐藏并从公开列表里拿掉", async () => {
    await submit(1);
    expect(await report("ABC-001", "device-rep-0001")).toBe("succeed");
    expect(await report("ABC-001", "device-rep-0002")).toBe("succeed");
    expect(await listCodes("user")).toEqual(["ABC-001"]);
    expect(await report("ABC-001", "device-rep-0003")).toBe("succeed");
    expect(await listCodes("user")).toEqual([]);
    const row = await env.DB.prepare("SELECT status, hidden_reason, report_count FROM items WHERE code = 'ABC-001'").first();
    expect(row).toEqual({ status: "hidden", hidden_reason: "reports", report_count: 3 });
    const log = await env.DB.prepare("SELECT actor FROM audit_log WHERE action = 'item.auto_hide_reports'").first();
    expect(log).toEqual({ actor: "system" });
  });

  it("同一个人重复举报只算一次（也不报错）", async () => {
    await submit(1);
    for (let i = 0; i < 3; i++) expect(await report("ABC-001", "device-rep-0001")).toBe("succeed");
    expect(await report("ABC-001", "device-rep-0002")).toBe("succeed");
    const row = await env.DB.prepare("SELECT report_count FROM items WHERE code = 'ABC-001'").first();
    expect(row).toEqual({ report_count: 2 });
    expect(await listCodes("user")).toEqual(["ABC-001"]);
  });

  it("同一个 IP 换几个设备号只算一个人：设备号是 App 自己报的、谁都能编，一个人编三个设备号不能把条目刷下架", async () => {
    await submit(1);
    for (const device of ["device-forge-001", "device-forge-002", "device-forge-003", "device-forge-004"]) {
      expect(await (await api("/api/v1/report", { json: { channel: "user", code: "ABC-001" }, device, ip: "198.51.100.200" })).text()).toBe("succeed");
    }
    expect(await listCodes("user")).toEqual(["ABC-001"]);
    expect(await env.DB.prepare("SELECT report_count FROM items").first()).toEqual({ report_count: 1 });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM reports").first()).toEqual({ n: 4 }); // 举报本身都留着，给维护者看
    // 另外两个不同的 IP 来了才算三个人
    await report("ABC-001", "device-real-0001");
    expect(await listCodes("user")).toEqual(["ABC-001"]);
    await report("ABC-001", "device-real-0002");
    expect(await listCodes("user")).toEqual([]);
  });

  it("IPv6 同一个 /64 里换地址举报也只算一个人", async () => {
    await submit(1);
    for (const [i, device] of ["device-v6-0001", "device-v6-0002", "device-v6-0003"].entries()) {
      await api("/api/v1/report", { json: { channel: "user", code: "ABC-001" }, device, ip: `2001:db8:abcd:12::${i + 1}` });
    }
    expect(await env.DB.prepare("SELECT report_count FROM items").first()).toEqual({ report_count: 1 });
    expect(await listCodes("user")).toEqual(["ABC-001"]);
  });

  it("作者精选不会被举报自动隐藏（匿名举报不能直接下架维护者挑的），但举报数照常显示、进待复核", async () => {
    const pw = await seedAppKey(await seedUser("alice", "moderator"));
    await upload("author", { av: makeItem(1), mode: "upload", pw });
    for (const device of ["device-rep-0001", "device-rep-0002", "device-rep-0003", "device-rep-0004"]) {
      expect(await (await reportFrom(device, "ABC-001", {}, "author")).text()).toBe("succeed");
    }
    expect(await listCodes("author")).toEqual(["ABC-001"]);
    expect(await env.DB.prepare("SELECT status, report_count FROM items").first()).toEqual({ status: "approved", report_count: 4 });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'item.auto_hide_reports'").first()).toEqual({ n: 0 });
  });

  it("老举报人重复举报时，如果阈值刚被调小、条目已经过线：照样隐藏并重建快照（不是等到凌晨）", async () => {
    await submit(1);
    await report("ABC-001", "device-rep-0001");
    await report("ABC-001", "device-rep-0002");
    expect(await listCodes("user")).toEqual(["ABC-001"]);
    await setSettings({ reportAutoHide: 2 });
    expect(await report("ABC-001", "device-rep-0001")).toBe("succeed"); // 重复举报，对外还是「成功」
    expect(await listCodes("user")).toEqual([]);
    expect(await env.DB.prepare("SELECT status, hidden_reason FROM items").first()).toEqual({ status: "hidden", hidden_reason: "reports" });
  });

  it("没带设备号的举报按 IP 算同一个人", async () => {
    await submit(1);
    for (let i = 0; i < 3; i++) expect(await report("ABC-001")).toBe("succeed");
    expect(await env.DB.prepare("SELECT report_count FROM items").first()).toEqual({ report_count: 1 });
  });

  it("阈值设成 0 = 不自动隐藏", async () => {
    await setSettings({ reportAutoHide: 0 });
    await submit(1);
    for (const d of ["device-rep-0001", "device-rep-0002", "device-rep-0003", "device-rep-0004"]) await report("ABC-001", d);
    expect(await listCodes("user")).toEqual(["ABC-001"]);
    expect(await env.DB.prepare("SELECT report_count FROM items").first()).toEqual({ report_count: 4 });
  });

  it("举报的条目不存在 / 已隐藏 = 404 + NF；格式不对 = FE", async () => {
    const missing = await api("/api/v1/report", { json: { channel: "user", code: "ABC-999" } });
    expect(missing.status).toBe(404);
    expect(await missing.text()).toBe("NF");
    await submit(1);
    await env.DB.prepare("UPDATE items SET status = 'hidden'").run();
    expect(await report("ABC-001", "device-rep-0001")).toBe("NF");
    expect(await (await api("/api/v1/report", { json: { channel: "user" } })).text()).toBe("FE");
    expect(await (await api("/api/v1/report", { raw: "oops" })).text()).toBe("FE");
  });

  it("按设备每天限频；被封禁的不能举报", async () => {
    await setSettings({ reportPerDayDevice: 2 });
    await submit(1);
    await submit(2);
    await submit(3);
    expect(await report("ABC-001", "device-rep-0001")).toBe("succeed");
    expect(await report("ABC-002", "device-rep-0001")).toBe("succeed");
    const limited = await reportFrom("device-rep-0001", "ABC-003");
    expect(limited.status).toBe(429);
    expect(await limited.text()).toBe("RL");

    await env.DB.prepare("INSERT INTO banned (kind, value, created_at) VALUES ('device', ?, ?)").bind(await deviceHash("device-rep-0009"), Date.now()).run();
    expect(await report("ABC-003", "device-rep-0009")).toBe("BN");
  });

  it("举报详情和原因被记下来", async () => {
    await submit(1);
    await report("ABC-001", "device-rep-0001", { reason: "inappropriate", detail: "  内容不对  " });
    const row = await env.DB.prepare("SELECT reason, detail, status FROM reports").first();
    expect(row).toEqual({ reason: "inappropriate", detail: "内容不对", status: "open" });
  });
});
