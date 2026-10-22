import { env } from "cloudflare:workers";
import { http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it } from "vitest";

import type { AuditDTO, BanDTO, ImportResultDTO, ItemDTO, Paged, ReportDTO, Settings, StatsDTO } from "../shared/types";
import { api, deviceHash, ipHash, listCodes, makeItem, parse, reportFrom, resetDb, seedUser, setSettings, submit, upload, type Admin } from "./helpers";
import { network } from "./network";

beforeEach(resetDb);

interface ErrorBody {
  error: { code: string; message: string; details?: { fields?: Record<string, string> } };
}

async function errorCode(response: Response): Promise<string> {
  return (await parse<ErrorBody>(response)).error.code;
}

async function owner(): Promise<Admin> {
  return seedUser("boss", "owner");
}

/** 公开通道提交 n 条（番号 ABC-001…），返回它们在库里的 id（按番号顺序）。 */
async function seedItems(count: number): Promise<number[]> {
  for (let i = 1; i <= count; i++) expect(await submit(i)).toBe("succeed");
  const { results } = await env.DB.prepare("SELECT id FROM items ORDER BY code").all<{ id: number }>();
  return results.map((r) => r.id);
}

async function itemById(id: number): Promise<{ status: string; hidden_reason: string; report_count: number; channel: string } | null> {
  return env.DB.prepare("SELECT status, hidden_reason, report_count, channel FROM items WHERE id = ?").bind(id).first();
}

describe("条目：新增", () => {
  it("维护者新增到作者精选：直接上线、记下创建人、留日志", async () => {
    const boss = await owner();
    const res = await boss.post("/items", { channel: "author", ...makeItem(1), note: "  经典  " });
    expect(res.status).toBe(201);
    expect(await parse<ItemDTO>(res)).toMatchObject({ channel: "author", code: "ABC-001", status: "approved", createdBy: "boss", note: "经典", checkStatus: "unchecked" });
    expect(await listCodes("author")).toEqual(["ABC-001"]);
    expect(await env.DB.prepare("SELECT actor, action, target_id FROM audit_log").first()).toEqual({ actor: "boss", action: "item.create", target_id: "ABC-001" });
  });

  it("可以建成待审（不进公开列表）", async () => {
    const boss = await owner();
    const res = await boss.post("/items", { channel: "user", ...makeItem(1), status: "pending" });
    expect((await parse<ItemDTO>(res)).status).toBe("pending");
    expect(await listCodes("user")).toEqual([]);
  });

  it("重复 → 409；格式不对 / 频道不对 → 422；条目的地址不受网站名单限制", async () => {
    const boss = await owner();
    await boss.post("/items", { channel: "user", ...makeItem(1) });
    const dup = await boss.post("/items", { channel: "user", ...makeItem(1, { code: "abc-001" }) });
    expect(dup.status).toBe(409);
    expect(await errorCode(dup)).toBe("exists");
    expect((await boss.post("/items", { channel: "user", ...makeItem(2, { code: "bad code" }) })).status).toBe(422);
    expect((await boss.post("/items", { channel: "nope", ...makeItem(3) })).status).toBe(422);
    await setSettings({ allowedHosts: "javbus.com" });
    expect((await boss.post("/items", { channel: "user", ...makeItem(4, { link: "https://other.example.com/x" }) })).status).toBe(201);
  });

  it("列表装满了 → 409 list_full", async () => {
    const boss = await owner();
    await boss.post("/items", { channel: "user", ...makeItem(1) });
    await env.DB.prepare("UPDATE snapshots SET count = 3000 WHERE channel = 'user'").run();
    const res = await boss.post("/items", { channel: "user", ...makeItem(2) });
    expect(res.status).toBe(409);
    expect(await errorCode(res)).toBe("list_full");
  });
});

describe("条目：列表 / 筛选 / 搜索 / 排序 / 分页", () => {
  it("返回完整字段，带分页信息", async () => {
    const boss = await owner();
    await seedItems(3);
    const page = await parse<Paged<ItemDTO>>(await boss.get("/items"));
    expect(page).toMatchObject({ total: 3, page: 1, pageSize: 50 });
    expect(page.items.map((i) => i.code)).toEqual(["ABC-003", "ABC-002", "ABC-001"]);
    expect(page.items[0]).toMatchObject({ channel: "user", status: "approved", hiddenReason: "", reportCount: 0, checkStatus: "unchecked", checkedAt: null, createdBy: null, reviewedBy: null });
    expect(page.items[0]?.ipHash).toMatch(/^[0-9a-f]{16}$/);
  });

  it("按频道 / 状态 / 检查结果 / 被举报 筛选", async () => {
    const boss = await owner();
    const ids = await seedItems(4);
    await boss.post("/items", { channel: "author", ...makeItem(9) });
    await boss.post("/items/status", { ids: [ids[0]], status: "hidden" });
    await boss.post("/items/status", { ids: [ids[1]], status: "rejected" });
    await env.DB.prepare("UPDATE items SET check_status = 'dead' WHERE id = ?").bind(ids[2]).run();
    await env.DB.prepare("UPDATE items SET report_count = 2 WHERE id = ?").bind(ids[3]).run();

    const total = async (query: string) => (await parse<Paged<ItemDTO>>(await boss.get(`/items?${query}`))).total;
    expect(await total("")).toBe(5);
    expect(await total("channel=author")).toBe(1);
    expect(await total("channel=user")).toBe(4);
    expect(await total("status=hidden")).toBe(1);
    expect(await total("status=rejected")).toBe(1);
    expect(await total("status=approved")).toBe(3);
    expect(await total("check=dead")).toBe(1);
    expect(await total("reported=1")).toBe(1);
    expect(await total("channel=user&status=approved")).toBe(2);
    expect(await total("status=nonsense")).toBe(5); // 不认识的筛选值当没写
  });

  it("搜索：番号和 info 都匹配；% 和 _ 按字面量处理", async () => {
    const boss = await owner();
    await boss.post("/items", { channel: "user", ...makeItem(1, { info: "ABC-001 | 100% 原味" }) });
    await boss.post("/items", { channel: "user", ...makeItem(2, { info: "ABC-002 | under_score" }) });
    await boss.post("/items", { channel: "user", ...makeItem(3) });
    const find = async (q: string) => (await parse<Paged<ItemDTO>>(await boss.get(`/items?q=${encodeURIComponent(q)}`))).items.map((i) => i.code);
    expect(await find("ABC-002")).toEqual(["ABC-002"]);
    expect(await find("abc-00")).toEqual(["ABC-003", "ABC-002", "ABC-001"]);
    expect(await find("100%")).toEqual(["ABC-001"]);
    expect(await find("%")).toEqual(["ABC-001"]); // 只有 info 里真有 % 的才匹配，不是通配
    expect(await find("under_score")).toEqual(["ABC-002"]);
    expect(await find("under-score")).toEqual([]);
    expect(await find("ABC_001")).toEqual([]); // _ 不是任意单字符
    expect(await find("原味")).toEqual(["ABC-001"]);
  });

  it("排序：最新 / 最早 / 最近更新 / 最久没检查 / 举报最多", async () => {
    const boss = await owner();
    const ids = await seedItems(3);
    await env.DB.prepare("UPDATE items SET updated_at = 5000 WHERE id = ?").bind(ids[0]).run();
    await env.DB.prepare("UPDATE items SET checked_at = 2000 WHERE id = ?").bind(ids[1]).run();
    await env.DB.prepare("UPDATE items SET checked_at = 1000 WHERE id = ?").bind(ids[2]).run();
    await env.DB.prepare("UPDATE items SET report_count = 4 WHERE id = ?").bind(ids[1]).run();
    const order = async (sort: string) => (await parse<Paged<ItemDTO>>(await boss.get(`/items?sort=${sort}`))).items.map((i) => i.code);
    await env.DB.prepare("UPDATE items SET updated_at = 1").run(); // 先抹平，再单独抬高第一条
    await env.DB.prepare("UPDATE items SET updated_at = 5000 WHERE id = ?").bind(ids[0]).run();
    expect(await order("new")).toEqual(["ABC-003", "ABC-002", "ABC-001"]);
    expect(await order("old")).toEqual(["ABC-001", "ABC-002", "ABC-003"]);
    expect((await order("updated"))[0]).toBe("ABC-001");
    expect(await order("checked")).toEqual(["ABC-001", "ABC-003", "ABC-002"]); // 没查过的在最前，然后是最久没查的
    expect((await order("reports"))[0]).toBe("ABC-002");
    expect(await order("nonsense")).toEqual(["ABC-003", "ABC-002", "ABC-001"]);
  });

  it("排序参数是对象原型链上的名字（toString / constructor / __proto__）：当不认识的，不是 500", async () => {
    const boss = await owner();
    await seedItems(2);
    for (const sort of ["toString", "constructor", "__proto__", "hasOwnProperty", "valueOf"]) {
      const res = await boss.get(`/items?sort=${sort}`);
      expect(res.status, sort).toBe(200);
      expect((await parse<Paged<ItemDTO>>(res)).items.map((i) => i.code)).toEqual(["ABC-002", "ABC-001"]);
    }
  });

  it("分页", async () => {
    const boss = await owner();
    await seedItems(5);
    const page3 = await parse<Paged<ItemDTO>>(await boss.get("/items?pageSize=2&page=3"));
    expect(page3).toMatchObject({ total: 5, page: 3, pageSize: 2 });
    expect(page3.items.map((i) => i.code)).toEqual(["ABC-001"]);
    const capped = await parse<Paged<ItemDTO>>(await boss.get("/items?pageSize=9999"));
    expect(capped.pageSize).toBe(100);
  });

  it("单条详情；不存在 404；id 不合法 400", async () => {
    const boss = await owner();
    const [id] = await seedItems(1);
    expect((await parse<ItemDTO>(await boss.get(`/items/${id}`))).code).toBe("ABC-001");
    expect((await boss.get("/items/999999")).status).toBe(404);
    expect((await boss.get("/items/abc")).status).toBe(400);
  });
});

describe("条目：编辑", () => {
  it("改 info / 地址 / 备注：公开列表跟着变；留日志（含新旧值）", async () => {
    const boss = await owner();
    const [id] = await seedItems(1);
    const res = await boss.patch(`/items/${id}`, { info: "新的标题", link: "https://www.javbus.com/new", note: "改过" });
    expect(res.status).toBe(200);
    expect(await parse<ItemDTO>(res)).toMatchObject({ info: "新的标题", link: "https://www.javbus.com/new", note: "改过" });
    const list = await parse<{ info: string; link: string }[]>(await api("/api/v1/rec/user"));
    expect(list[0]).toMatchObject({ info: "新的标题", link: "https://www.javbus.com/new" });
    const log = await env.DB.prepare("SELECT detail FROM audit_log WHERE action = 'item.edit'").first<{ detail: string }>();
    expect(JSON.parse(log?.detail ?? "{}")).toMatchObject({ info: ["ABC-001 | 2026-10-22", "新的标题"] });
  });

  it("什么都没改就原样返回，不写日志", async () => {
    const boss = await owner();
    const [id] = await seedItems(1);
    expect((await boss.patch(`/items/${id}`, { info: "ABC-001 | 2026-10-22" })).status).toBe(200);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'item.edit'").first()).toEqual({ n: 0 });
  });

  it("改地址会清掉检查结果，下次重新查", async () => {
    const boss = await owner();
    const [id] = await seedItems(1);
    await env.DB.prepare("UPDATE items SET check_status = 'dead', check_detail = '链接 HTTP 404', check_fail = 2, checked_at = 123 WHERE id = ?").bind(id).run();
    const dto = await parse<ItemDTO>(await boss.patch(`/items/${id}`, { link: "https://www.javbus.com/fixed" }));
    expect(dto).toMatchObject({ checkStatus: "unchecked", checkDetail: "", checkFail: 0, checkedAt: null });
    // 只改备注不影响检查结果
    await env.DB.prepare("UPDATE items SET check_status = 'warn', checked_at = 456 WHERE id = ?").bind(id).run();
    expect(await parse<ItemDTO>(await boss.patch(`/items/${id}`, { note: "x" }))).toMatchObject({ checkStatus: "warn", checkedAt: 456 });
  });

  it("改番号撞了同频道的另一条 → 409；不合法 → 422；不存在 → 404", async () => {
    const boss = await owner();
    const [first] = await seedItems(2);
    const clash = await boss.patch(`/items/${first}`, { code: "abc-002" });
    expect(clash.status).toBe(409);
    expect(await errorCode(clash)).toBe("exists");
    expect((await boss.patch(`/items/${first}`, { code: "bad code" })).status).toBe(422);
    expect((await boss.patch(`/items/${first}`, { link: "http://localhost/x" })).status).toBe(422);
    expect((await boss.patch(`/items/${first}`, { info: 123 })).status).toBe(422);
    expect((await boss.patch(`/items/${first}`, { channel: "nope" })).status).toBe(422);
    expect((await boss.patch("/items/999999", { info: "x" })).status).toBe(404);
  });

  it("移到另一个频道：两边的公开列表都更新", async () => {
    const boss = await owner();
    const [id] = await seedItems(2);
    expect(await listCodes("user")).toEqual(["ABC-002", "ABC-001"]);
    expect((await parse<ItemDTO>(await boss.patch(`/items/${id}`, { channel: "author" }))).channel).toBe("author");
    expect(await listCodes("user")).toEqual(["ABC-002"]);
    expect(await listCodes("author")).toEqual(["ABC-001"]);
  });

  it("已上线的条目移到已经装满的频道 → 409（直接新增、批量通过都查容量，移过去不能是后门）；隐藏的不占公开列表，可以移", async () => {
    const boss = await owner();
    const [id] = await seedItems(1);
    await env.DB.prepare("INSERT INTO snapshots (channel, version, count, bytes, body, updated_at) VALUES ('author', 1, 3000, 10, '[]', 1)").run();
    const res = await boss.patch(`/items/${id}`, { channel: "author" });
    expect(res.status).toBe(409);
    expect(await errorCode(res)).toBe("list_full");
    expect(await itemById(id as number)).toMatchObject({ channel: "user" });
    await boss.post("/items/status", { ids: [id], status: "hidden" });
    expect((await boss.patch(`/items/${id}`, { channel: "author" })).status).toBe(200);
  });

  it("移到的频道里已有同番号 → 409，原来的不动", async () => {
    const boss = await owner();
    const [id] = await seedItems(1);
    await boss.post("/items", { channel: "author", ...makeItem(1) });
    expect((await boss.patch(`/items/${id}`, { channel: "author" })).status).toBe(409);
    expect(await listCodes("user")).toEqual(["ABC-001"]);
  });

  it("改的是已隐藏的条目：不影响公开列表", async () => {
    const boss = await owner();
    const [id] = await seedItems(1);
    await boss.post("/items/status", { ids: [id], status: "hidden" });
    const before = (await api("/api/v1/rec/user")).headers.get("ETag");
    await boss.patch(`/items/${id}`, { info: "悄悄改" });
    expect((await api("/api/v1/rec/user")).headers.get("ETag")).toBe(before);
  });
});

describe("条目：通过 / 拒绝 / 隐藏 / 恢复", () => {
  it("待审 → 通过后进公开列表；拒绝 / 隐藏后拿掉；恢复后回来", async () => {
    const boss = await owner();
    await setSettings({ autoApproveUser: false });
    for (const n of [1, 2, 3]) expect(await submit(n)).toBe("PD");
    const { results } = await env.DB.prepare("SELECT id FROM items ORDER BY code").all<{ id: number }>();
    const [a, b, c] = results.map((r) => r.id);
    expect(await listCodes("user")).toEqual([]);

    const approved = await boss.post("/items/status", { ids: [a, b], status: "approved" });
    expect(await parse(approved)).toEqual({ changed: 2 });
    expect(await listCodes("user")).toHaveLength(2);
    expect(await boss.post("/items/status", { ids: [c], status: "rejected" })).toBeTruthy();
    expect(await itemById(c as number)).toMatchObject({ status: "rejected" });

    await boss.post("/items/status", { ids: [a], status: "hidden" });
    expect(await itemById(a as number)).toMatchObject({ status: "hidden", hidden_reason: "manual" });
    expect(await listCodes("user")).toEqual(["ABC-002"]);

    await boss.post("/items/status", { ids: [a], status: "approved" });
    expect(await itemById(a as number)).toMatchObject({ status: "approved", hidden_reason: "" });
    expect(await listCodes("user")).toHaveLength(2);
  });

  it("记下审核人和时间；状态没变的不算", async () => {
    const boss = await owner();
    const [id] = await seedItems(1);
    expect(await parse(await boss.post("/items/status", { ids: [id], status: "approved" }))).toEqual({ changed: 0 });
    await boss.post("/items/status", { ids: [id], status: "hidden" });
    const dto = await parse<ItemDTO>(await boss.get(`/items/${id}`));
    expect(dto).toMatchObject({ status: "hidden", hiddenReason: "manual", reviewedBy: "boss" });
    expect(dto.reviewedAt).not.toBeNull();
  });

  it("批量操作只写一条日志，带数量和番号", async () => {
    const boss = await owner();
    const ids = await seedItems(3);
    await boss.post("/items/status", { ids, status: "hidden" });
    const rows = await env.DB.prepare("SELECT detail FROM audit_log WHERE action = 'item.hide'").all<{ detail: string }>();
    expect(rows.results).toHaveLength(1);
    expect(JSON.parse(rows.results[0]?.detail ?? "{}")).toMatchObject({ count: 3, to: "hidden" });
  });

  it("参数不对 → 422：ids 空 / 太多 / 不是数字，状态不认识", async () => {
    const boss = await owner();
    expect((await boss.post("/items/status", { ids: [], status: "hidden" })).status).toBe(422);
    expect((await boss.post("/items/status", { ids: Array.from({ length: 101 }, (_, i) => i + 1), status: "hidden" })).status).toBe(422);
    expect((await boss.post("/items/status", { ids: ["1"], status: "hidden" })).status).toBe(422);
    expect((await boss.post("/items/status", { ids: [1], status: "pending" })).status).toBe(422);
    expect((await boss.post("/items/status", { ids: [1] })).status).toBe(422);
  });

  it("通过时列表已满 → 409 list_full，条目保持待审", async () => {
    const boss = await owner();
    await setSettings({ autoApproveUser: false });
    await submit(1);
    const row = await env.DB.prepare("SELECT id FROM items").first<{ id: number }>();
    await env.DB.prepare("INSERT INTO snapshots (channel, version, count, bytes, body, updated_at) VALUES ('user', 1, 3000, 10, '[]', 1)").run();
    const res = await boss.post("/items/status", { ids: [row?.id], status: "approved" });
    expect(res.status).toBe(409);
    expect(await errorCode(res)).toBe("list_full");
    expect(await itemById(row?.id as number)).toMatchObject({ status: "pending" });
  });

  it("隐藏 / 拒绝时，这个条目没处理的举报一并标成已处理，举报数清零", async () => {
    const boss = await owner();
    const [id] = await seedItems(1);
    await reportFrom("device-rep-0001", "ABC-001");
    expect(await itemById(id as number)).toMatchObject({ report_count: 1 });
    await boss.post("/items/status", { ids: [id], status: "hidden" });
    expect(await itemById(id as number)).toMatchObject({ report_count: 0 });
    expect(await env.DB.prepare("SELECT status, resolution FROM reports").first()).toEqual({ status: "resolved", resolution: "条目已被处理" });
  });
});

describe("条目：删除", () => {
  it("批量删除：连同举报一起，公开列表重建", async () => {
    const boss = await owner();
    const ids = await seedItems(3);
    await reportFrom("device-rep-0001", "ABC-001");
    const res = await boss.post("/items/delete", { ids: [ids[0], ids[1]] });
    expect(await parse(res)).toEqual({ deleted: 2 });
    expect(await listCodes("user")).toEqual(["ABC-003"]);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM reports").first()).toEqual({ n: 0 });
  });

  it("不存在的 id 忽略；ids 不合法 → 422", async () => {
    const boss = await owner();
    expect(await parse(await boss.post("/items/delete", { ids: [999999] }))).toEqual({ deleted: 0 });
    expect((await boss.post("/items/delete", { ids: [] })).status).toBe(422);
  });

  it("删除已隐藏的条目不动公开列表", async () => {
    const boss = await owner();
    const [id] = await seedItems(1);
    await boss.post("/items/status", { ids: [id], status: "hidden" });
    const before = (await api("/api/v1/rec/user")).headers.get("ETag");
    await boss.post("/items/delete", { ids: [id] });
    expect((await api("/api/v1/rec/user")).headers.get("ETag")).toBe(before);
  });
});

describe("条目：导入 / 导出", () => {
  it("导入：合格的进库；文件内重复、库里已有、格式不对的分别计数；数组顺序 = 显示顺序", async () => {
    const boss = await owner();
    await seedItems(1);
    const res = await boss.post("/items/import", {
      channel: "user",
      items: [makeItem(10), makeItem(11), makeItem(10), makeItem(1), makeItem(12, { code: "bad code" }), "垃圾", makeItem(13)],
    });
    expect(res.status).toBe(200);
    const result = await parse<ImportResultDTO>(res);
    expect(result).toMatchObject({ received: 7, inserted: 3, skipped: 2, invalid: 2 });
    expect(result.samples).toEqual([
      { index: 4, reason: "番号格式不对" },
      { index: 5, reason: "不是对象" },
    ]);
    // 导入的排在原来那条前面（created_at 更晚），内部保持数组顺序：ABC-010 在 ABC-011 前
    expect(await listCodes("user")).toEqual(["ABC-010", "ABC-011", "ABC-013", "ABC-001"]);
  });

  it("分批导入：不同批次之间也保持文件里的顺序（order.base 全程用同一个，order.offset 是这一批前面有多少条），发送顺序无所谓", async () => {
    const boss = await owner();
    const file = Array.from({ length: 6 }, (_, i) => makeItem(i + 1)); // 文件顺序：ABC-001 最新 … ABC-006 最旧
    const base = Date.now();
    // 故意倒着发：先导最后一批，再导第一批——不带 order 的话，后导的批次时间更晚，会整批排到前面
    await boss.post("/items/import", { channel: "user", items: file.slice(4), order: { base, offset: 4 } });
    await boss.post("/items/import", { channel: "user", items: file.slice(0, 2), order: { base, offset: 0 } });
    await boss.post("/items/import", { channel: "user", items: file.slice(2, 4), order: { base, offset: 2 } });
    expect(await listCodes("user")).toEqual(["ABC-001", "ABC-002", "ABC-003", "ABC-004", "ABC-005", "ABC-006"]);
  });

  it("分批导入没带 order：每批以导入那一刻为基准，所以先导的批次排在后面（这就是需要 order 的原因）", async () => {
    const boss = await owner();
    await boss.post("/items/import", { channel: "user", items: [makeItem(1), makeItem(2)] });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await boss.post("/items/import", { channel: "user", items: [makeItem(3), makeItem(4)] });
    expect(await listCodes("user")).toEqual(["ABC-003", "ABC-004", "ABC-001", "ABC-002"]);
  });

  it("order 不合法 → 422：base 不是数字 / 太早 / 在未来；offset 是负数 / 太大 / 不是整数", async () => {
    const boss = await owner();
    const now = Date.now();
    const bad: unknown[] = [
      { base: "now", offset: 0 },
      { base: now - 3 * 86_400_000, offset: 0 },
      { base: now + 10 * 60_000, offset: 0 },
      { base: now, offset: -1 },
      { base: now, offset: 1_000_001 },
      { base: now, offset: 1.5 },
      { base: now },
      "x",
    ];
    for (const order of bad) {
      const res = await boss.post("/items/import", { channel: "user", items: [makeItem(1)], order });
      expect(res.status, JSON.stringify(order)).toBe(422);
    }
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM items").first()).toEqual({ n: 0 });
  });

  it("导入宽松：info 过长截断，不查屏蔽词和网站名单", async () => {
    const boss = await owner();
    await setSettings({ blockedWords: "spam", allowedHosts: "javbus.com" });
    const res = await boss.post("/items/import", {
      channel: "user",
      items: [makeItem(1, { info: `spam ${"x".repeat(300)}`, link: "https://other.example.com/1" })],
    });
    expect(await parse<ImportResultDTO>(res)).toMatchObject({ inserted: 1, invalid: 0 });
    const row = await env.DB.prepare("SELECT LENGTH(info) AS n FROM items").first<{ n: number }>();
    expect(row?.n).toBe(160);
  });

  it("导入成待审：不进公开列表；记日志", async () => {
    const boss = await owner();
    await boss.post("/items/import", { channel: "user", status: "pending", items: [makeItem(1)] });
    expect(await listCodes("user")).toEqual([]);
    expect(await env.DB.prepare("SELECT status FROM items").first()).toEqual({ status: "pending" });
    expect(await env.DB.prepare("SELECT actor FROM audit_log WHERE action = 'item.import'").first()).toEqual({ actor: "boss" });
  });

  it("参数不对 → 422：没有频道 / 空 / 超过 1000 条 / 不是数组", async () => {
    const boss = await owner();
    expect((await boss.post("/items/import", { items: [makeItem(1)] })).status).toBe(422);
    expect((await boss.post("/items/import", { channel: "user", items: [] })).status).toBe(422);
    expect((await boss.post("/items/import", { channel: "user", items: Array.from({ length: 1001 }, (_, i) => makeItem(i)) })).status).toBe(422);
    expect((await boss.post("/items/import", { channel: "user", items: "nope" })).status).toBe(422);
  });

  it("上线导入装不下 → 409，一条都不进", async () => {
    const boss = await owner();
    await env.DB.prepare("INSERT INTO snapshots (channel, version, count, bytes, body, updated_at) VALUES ('user', 1, 2999, 10, '[]', 1)").run();
    const res = await boss.post("/items/import", { channel: "user", items: [makeItem(1), makeItem(2)] });
    expect(res.status).toBe(409);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM items").first()).toEqual({ n: 0 });
  });

  it("快照快到 2 MB 了：一批大条目导进去会超过上限 → 409；小的照常（只看「现在有多大」会放行一批让快照涨过 2 MB 的）", async () => {
    const boss = await owner();
    await env.DB.prepare("INSERT INTO snapshots (channel, version, count, bytes, body, updated_at) VALUES ('user', 1, 100, 1790000, '[]', 1)").run();
    const fat = Array.from({ length: 50 }, (_, i) => makeItem(i, { info: "标".repeat(150), src: `https://www.javbus.com/pics/${"x".repeat(240)}${i}.jpg` }));
    const res = await boss.post("/items/import", { channel: "user", items: fat });
    expect(res.status).toBe(409);
    expect(await errorCode(res)).toBe("list_full");
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM items").first()).toEqual({ n: 0 });
    expect((await boss.post("/items/import", { channel: "user", items: [makeItem(1), makeItem(2)] })).status).toBe(200);
  });

  it("批量通过也按这批的字节数判断容量", async () => {
    const boss = await owner();
    await setSettings({ autoApproveUser: false });
    for (let i = 1; i <= 3; i++) expect(await submit(i)).toBe("PD");
    await env.DB.prepare("UPDATE items SET info = ?").bind("标".repeat(150)).run();
    await env.DB.prepare("INSERT INTO snapshots (channel, version, count, bytes, body, updated_at) VALUES ('user', 1, 10, 1799800, '[]', 1)").run();
    const ids = (await env.DB.prepare("SELECT id FROM items").all<{ id: number }>()).results.map((r) => r.id);
    const res = await boss.post("/items/status", { ids, status: "approved" });
    expect(res.status).toBe(409);
    expect(await errorCode(res)).toBe("list_full");
  });

  it("一次导入一千条也能一条语句装下（不受 100 个参数限制）", async () => {
    const boss = await owner();
    await setSettings({ maxItemsPerChannel: 8000 });
    const items = Array.from({ length: 1000 }, (_, i) => makeItem(i, { code: `BULK-${i}` }));
    const result = await parse<ImportResultDTO>(await boss.post("/items/import", { channel: "user", items }));
    expect(result).toMatchObject({ inserted: 1000, invalid: 0 });
    const codes = await listCodes("user");
    expect(codes).toHaveLength(1000);
    expect(codes[0]).toBe("BULK-0");
    expect(codes[999]).toBe("BULK-999");
  });

  it("导出：带下载头；可按频道 / 状态筛选；字段完整", async () => {
    const boss = await owner();
    await seedItems(2);
    await boss.post("/items", { channel: "author", ...makeItem(9) });
    const res = await boss.get("/export");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Disposition")).toMatch(/^attachment; filename="javbus-community-\d{4}-\d{2}-\d{2}\.json"$/);
    const body = await parse<{ app: string; version: string; exportedAt: number; items: Record<string, unknown>[] }>(res);
    expect(body).toMatchObject({ app: "javbus-community", version: "1.0.0" });
    expect(body.items).toHaveLength(3);
    expect(body.items[0]).toMatchObject({ channel: "author", code: "ABC-009", status: "approved" });
    expect(Object.keys(body.items[0] ?? {}).sort()).toEqual(["channel", "code", "createdAt", "info", "link", "note", "src", "status"]);

    expect(body).toMatchObject({ truncated: false });
    expect(typeof body.exportedAt).toBe("number");
    const onlyUser = await parse<{ items: unknown[] }>(await boss.get("/export?channel=user"));
    expect(onlyUser.items).toHaveLength(2);
    const hidden = await parse<{ items: unknown[] }>(await boss.get("/export?status=hidden"));
    expect(hidden.items).toHaveLength(0);
  });

  it("导出的文件可以原样导回去（往返）", async () => {
    const boss = await owner();
    await seedItems(3);
    const exported = await parse<{ items: Record<string, unknown>[] }>(await boss.get("/export?channel=user"));
    await env.DB.prepare("DELETE FROM items").run();
    const back = await parse<ImportResultDTO>(await boss.post("/items/import", { channel: "user", items: exported.items }));
    expect(back).toMatchObject({ received: 3, inserted: 3, invalid: 0 });
    expect((await listCodes("user")).sort()).toEqual(["ABC-001", "ABC-002", "ABC-003"]);
  });
});

describe("条目：从远程地址取列表（导入原作者的 GitLab 列表用）", () => {
  const remote = "https://gitlab.example.org/raw/Rec";

  it("下载 → 清洗 → 返回（浏览器再分批导入）", async () => {
    const boss = await owner();
    network.use(
      http.get(remote, () =>
        HttpResponse.json([makeItem(1), makeItem(2, { code: "bad code" }), { code: "ABC-003", link: "https://www.javbus.com/ABC-003" }, "垃圾"]),
      ),
    );
    const res = await boss.post("/items/import/fetch", { url: remote });
    expect(res.status).toBe(200);
    const body = await parse<{ items: { code: string; link: string }[]; invalid: number }>(res);
    // 这里只做最便宜的结构检查（是对象、有字符串的 code 和 link）：在一个请求里把两万条都校验一遍，免费版 10 毫秒 CPU 放不下
    expect(body.invalid).toBe(1);
    expect(body.items.map((i) => i.code)).toEqual(["ABC-001", "bad code", "ABC-003"]);
    // 真正的校验在分批导入时做：番号不合格的被挡下，没有 info 就用番号、没有封面就空
    const imported = await parse<ImportResultDTO>(await boss.post("/items/import", { channel: "user", items: body.items }));
    expect(imported).toMatchObject({ received: 3, inserted: 2, invalid: 1 });
    expect(await env.DB.prepare("SELECT info, src FROM items WHERE code = 'ABC-003'").first()).toEqual({ info: "ABC-003", src: "" });
  });

  it("对方不是 JSON / 不是数组 / 报错 → 422", async () => {
    const boss = await owner();
    network.use(http.get("https://x1.example.org/a", () => HttpResponse.text("not json")));
    network.use(http.get("https://x2.example.org/a", () => HttpResponse.json({ not: "array" })));
    network.use(http.get("https://x3.example.org/a", () => new HttpResponse(null, { status: 500 })));
    for (const host of ["x1", "x2", "x3"]) {
      const res = await boss.post("/items/import/fetch", { url: `https://${host}.example.org/a` });
      expect(res.status, host).toBe(422);
      expect(await errorCode(res)).toBe("fetch_failed");
    }
  });

  it("只接受 https 的公网地址", async () => {
    const boss = await owner();
    for (const url of ["http://example.org/a", "https://localhost/a", "https://192.168.1.1/a", "ftp://example.org/a", "垃圾", ""]) {
      const res = await boss.post("/items/import/fetch", { url });
      expect(res.status, url).toBe(422);
      expect(await errorCode(res)).toBe("invalid_url");
    }
  });
});

describe("举报处理", () => {
  async function reportedItem(devices: string[]): Promise<number> {
    const [id] = await seedItems(1);
    for (const device of devices) await reportFrom(device, "ABC-001", { reason: "dead", detail: "打不开" });
    return id as number;
  }

  it("列出举报（含条目信息）", async () => {
    const boss = await owner();
    const id = await reportedItem(["device-rep-0001", "device-rep-0002"]);
    const page = await parse<Paged<ReportDTO>>(await boss.get("/reports?status=open"));
    expect(page.total).toBe(2);
    expect(page.items[0]).toMatchObject({ itemId: id, code: "ABC-001", channel: "user", itemStatus: "approved", reason: "dead", detail: "打不开", status: "open", resolvedBy: null });
    expect(page.items[0]?.reporter).toMatch(/^[0-9a-f]{16}$/);
    expect(page.items[0]?.ipHash).toMatch(/^[0-9a-f]{16}$/); // 条目的「举报数」就是不同 ipHash 的个数
    expect(new Set(page.items.map((r) => r.ipHash)).size).toBe(2);
    expect((await parse<Paged<ReportDTO>>(await boss.get("/reports?status=resolved"))).total).toBe(0);
    expect((await parse<Paged<ReportDTO>>(await boss.get("/reports"))).total).toBe(2);
  });

  it("隐藏条目：举报一并处理掉，公开列表拿掉", async () => {
    const boss = await owner();
    const id = await reportedItem(["device-rep-0001", "device-rep-0002"]);
    expect((await boss.post("/reports/resolve", { itemId: id, action: "hide" })).status).toBe(200);
    expect(await itemById(id)).toMatchObject({ status: "hidden", hidden_reason: "manual", report_count: 0 });
    expect(await listCodes("user")).toEqual([]);
    const page = await parse<Paged<ReportDTO>>(await boss.get("/reports?status=resolved"));
    expect(page.total).toBe(2);
    expect(page.items[0]).toMatchObject({ resolvedBy: "boss", itemStatus: "hidden" });
  });

  it("驳回举报：条目没问题；如果是被举报自动隐藏的，同时恢复上线", async () => {
    const boss = await owner();
    const id = await reportedItem(["device-rep-0001", "device-rep-0002", "device-rep-0003"]);
    expect(await itemById(id)).toMatchObject({ status: "hidden", hidden_reason: "reports" });
    expect(await listCodes("user")).toEqual([]);

    expect((await boss.post("/reports/resolve", { itemId: id, action: "dismiss" })).status).toBe(200);
    expect(await itemById(id)).toMatchObject({ status: "approved", hidden_reason: "", report_count: 0 });
    expect(await listCodes("user")).toEqual(["ABC-001"]);
    expect((await parse<Paged<ReportDTO>>(await boss.get("/reports?status=dismissed"))).total).toBe(3);
  });

  it("驳回举报：条目本来就在线 → 只处理举报，不动条目", async () => {
    const boss = await owner();
    const id = await reportedItem(["device-rep-0001"]);
    await boss.post("/reports/resolve", { itemId: id, action: "dismiss" });
    expect(await itemById(id)).toMatchObject({ status: "approved", report_count: 0 });
  });

  it("驳回之后，同一个人不能再举报同一个条目（唯一索引），但也不报错", async () => {
    const boss = await owner();
    const id = await reportedItem(["device-rep-0001"]);
    await boss.post("/reports/resolve", { itemId: id, action: "dismiss" });
    const again = await reportFrom("device-rep-0001", "ABC-001");
    expect(await again.text()).toBe("succeed");
    expect(await itemById(id)).toMatchObject({ report_count: 0 });
  });

  it("删除条目：举报随之消失", async () => {
    const boss = await owner();
    const id = await reportedItem(["device-rep-0001"]);
    expect((await boss.post("/reports/resolve", { itemId: id, action: "delete" })).status).toBe(200);
    expect(await itemById(id)).toBeNull();
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM reports").first()).toEqual({ n: 0 });
    expect(await listCodes("user")).toEqual([]);
  });

  it("恢复时列表已满 → 409，条目保持隐藏", async () => {
    const boss = await owner();
    const id = await reportedItem(["device-rep-0001", "device-rep-0002", "device-rep-0003"]);
    await env.DB.prepare("UPDATE snapshots SET count = 3000 WHERE channel = 'user'").run();
    const res = await boss.post("/reports/resolve", { itemId: id, action: "dismiss" });
    expect(res.status).toBe(409);
    expect(await itemById(id)).toMatchObject({ status: "hidden" });
  });

  it("条目已经被举报自动隐藏时，点「隐藏条目」是确认：举报标成已处理、隐藏原因变成手动，之后再点「驳回」也不会把它放回去", async () => {
    const boss = await owner();
    const id = await reportedItem(["device-rep-0001", "device-rep-0002", "device-rep-0003"]);
    expect(await itemById(id)).toMatchObject({ status: "hidden", hidden_reason: "reports", report_count: 3 });

    expect((await boss.post("/reports/resolve", { itemId: id, action: "hide" })).status).toBe(200);
    expect(await itemById(id)).toMatchObject({ status: "hidden", hidden_reason: "manual", report_count: 0 });
    expect((await parse<Paged<ReportDTO>>(await boss.get("/reports?status=resolved"))).total).toBe(3);
    expect((await parse<Paged<ReportDTO>>(await boss.get("/reports?status=open"))).total).toBe(0);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'report.hide'").first()).toEqual({ n: 1 });

    expect((await boss.post("/reports/resolve", { itemId: id, action: "dismiss" })).status).toBe(200);
    expect(await itemById(id)).toMatchObject({ status: "hidden", hidden_reason: "manual" });
    expect(await listCodes("user")).toEqual([]);
  });

  it("条目页对被举报自动隐藏的条目点「隐藏」同样算数（changed = 1），隐藏原因变成手动", async () => {
    const boss = await owner();
    const id = await reportedItem(["device-rep-0001", "device-rep-0002", "device-rep-0003"]);
    expect(await parse(await boss.post("/items/status", { ids: [id], status: "hidden" }))).toEqual({ changed: 1 });
    expect(await itemById(id)).toMatchObject({ status: "hidden", hidden_reason: "manual", report_count: 0 });
    // 已经是手动隐藏了再点：没有变化
    expect(await parse(await boss.post("/items/status", { ids: [id], status: "hidden" }))).toEqual({ changed: 0 });
  });

  it("通过一个被举报自动隐藏的条目：没处理的举报算驳回、举报数清零，之后一个新举报不会马上又把它隐藏", async () => {
    const boss = await owner();
    const id = await reportedItem(["device-rep-0001", "device-rep-0002", "device-rep-0003"]);
    expect((await boss.post("/items/status", { ids: [id], status: "approved" })).status).toBe(200);
    expect(await itemById(id)).toMatchObject({ status: "approved", hidden_reason: "", report_count: 0 });
    expect((await parse<Paged<ReportDTO>>(await boss.get("/reports?status=dismissed"))).total).toBe(3);
    expect(await env.DB.prepare("SELECT resolution FROM reports LIMIT 1").first()).toEqual({ resolution: "条目已被通过" });
    expect(await listCodes("user")).toEqual(["ABC-001"]);

    await reportFrom("device-rep-0009", "ABC-001");
    expect(await itemById(id)).toMatchObject({ status: "approved", report_count: 1 });
    expect(await listCodes("user")).toEqual(["ABC-001"]);
  });

  it("参数不对 → 422；条目不存在 → 404；协管可以处理", async () => {
    const boss = await owner();
    expect((await boss.post("/reports/resolve", { itemId: 1, action: "explode" })).status).toBe(422);
    expect((await boss.post("/reports/resolve", { action: "hide" })).status).toBe(422);
    expect((await boss.post("/reports/resolve", { itemId: 999999, action: "hide" })).status).toBe(404);
    const id = await reportedItem(["device-rep-0001"]);
    const moderator = await seedUser("mod", "moderator");
    expect((await moderator.post("/reports/resolve", { itemId: id, action: "hide" })).status).toBe(200);
  });
});

describe("封禁", () => {
  it("封设备并清理：已上线的 → 隐藏，待审的 → 拒绝；之后该设备提交 = BN；解封后恢复", async () => {
    const boss = await owner();
    const device = "device-spam-0001";
    for (const n of [1, 2, 3]) expect(await submit(n, { device })).toBe("succeed");
    expect(await submit(4, { device: "device-good-0001" })).toBe("succeed");
    await env.DB.prepare("UPDATE items SET status = 'pending' WHERE code = 'ABC-003'").run();
    const hash = await deviceHash(device);

    const res = await boss.post("/bans", { kind: "device", value: hash, reason: "刷屏", purge: true });
    expect(res.status).toBe(201);
    expect(await parse(res)).toEqual({ ok: true, purged: 3 });
    expect(await env.DB.prepare("SELECT code, status, hidden_reason FROM items ORDER BY code").all()).toMatchObject({
      results: [
        { code: "ABC-001", status: "hidden", hidden_reason: "manual" },
        { code: "ABC-002", status: "hidden", hidden_reason: "manual" },
        { code: "ABC-003", status: "rejected" },
        { code: "ABC-004", status: "approved" },
      ],
    });
    expect(await listCodes("user")).toEqual(["ABC-004"]);
    expect(await submit(5, { device })).toBe("BN");

    const list = await parse<BanDTO[]>(await boss.get("/bans"));
    expect(list).toEqual([expect.objectContaining({ kind: "device", value: hash, reason: "刷屏", createdBy: "boss" })]);

    expect((await boss.del(`/bans/device/${hash}`)).status).toBe(200);
    expect(await submit(5, { device })).toBe("succeed");
    expect((await boss.del(`/bans/device/${hash}`)).status).toBe(404);
  });

  it("不勾清理就只封不动已有条目", async () => {
    const boss = await owner();
    const device = "device-spam-0001";
    await submit(1, { device });
    await boss.post("/bans", { kind: "device", value: await deviceHash(device), reason: "" });
    expect(await listCodes("user")).toEqual(["ABC-001"]);
  });

  it("封 IP；封番号（连已有的同番号条目一起清掉，不分频道）", async () => {
    const boss = await owner();
    await submit(1, { ip: "198.51.100.77" });
    await boss.post("/items", { channel: "author", ...makeItem(8) });
    await submit(8);
    expect((await boss.post("/bans", { kind: "ip", value: await ipHash("198.51.100.77"), purge: true })).status).toBe(201);
    expect(await submit(2, { ip: "198.51.100.77" })).toBe("BN");
    expect(await listCodes("user")).toEqual(["ABC-008"]);

    const code = await parse<{ purged: number }>(await boss.post("/bans", { kind: "code", value: "abc-008", purge: true }));
    expect(code.purged).toBe(2);
    expect(await listCodes("user")).toEqual([]);
    expect(await listCodes("author")).toEqual([]);
    expect(await submit(8)).toBe("BN");
  });

  it("重复封禁只更新理由；值格式不对 → 422", async () => {
    const boss = await owner();
    const hash = "0123456789abcdef";
    await boss.post("/bans", { kind: "ip", value: hash, reason: "a" });
    await boss.post("/bans", { kind: "ip", value: hash.toUpperCase(), reason: "b" });
    const list = await parse<BanDTO[]>(await boss.get("/bans"));
    expect(list).toHaveLength(1);
    expect(list[0]?.reason).toBe("b");
    for (const body of [{ kind: "device", value: "short" }, { kind: "ip", value: "zzzzzzzzzzzzzzzz" }, { kind: "code", value: "bad code" }, { kind: "nope", value: hash }]) {
      expect((await boss.post("/bans", body)).status, JSON.stringify(body)).toBe(422);
    }
    expect((await boss.del("/bans/nope/x")).status).toBe(400);
    expect((await boss.del("/bans/code/%25ZZ")).status).toBe(404); // 不是 500：路径参数已经解过一次码，不能再解
  });
});

describe("站点设置", () => {
  it("读：全是已知项，不含内部的盐", async () => {
    const boss = await owner();
    const { settings } = await parse<{ settings: Settings }>(await boss.get("/settings"));
    expect(settings).toMatchObject({ siteName: "JavBus 社区推荐", maintenance: false, autoApproveUser: true, maxItemsPerChannel: 3000, checkBatchSize: 10 });
    expect(Object.keys(settings)).not.toContain("_salt");
  });

  it("改：只改传来的项，其余保持；立刻生效；留日志（新旧值）", async () => {
    const boss = await owner();
    const res = await boss.put("/settings", { maintenance: true, submitPerHourDevice: 9, blockedWords: " a \n\nb\na " });
    expect(res.status).toBe(200);
    const { settings } = await parse<{ settings: Settings }>(res);
    expect(settings).toMatchObject({ maintenance: true, submitPerHourDevice: 9, blockedWords: "a\nb", autoApproveUser: true });
    expect(await submit(1)).toBe("OFF");
    expect((await parse<{ settings: Settings }>(await boss.get("/settings"))).settings.submitPerHourDevice).toBe(9);

    const log = await env.DB.prepare("SELECT actor, detail FROM audit_log WHERE action = 'settings.update'").first<{ actor: string; detail: string }>();
    expect(log?.actor).toBe("boss");
    expect(JSON.parse(log?.detail ?? "{}")).toEqual({ maintenance: [false, true], submitPerHourDevice: [6, 9], blockedWords: ["", "a\nb"] });
  });

  it("没有变化就不写日志", async () => {
    const boss = await owner();
    await boss.put("/settings", { maintenance: false });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'settings.update'").first()).toEqual({ n: 0 });
  });

  it("不合法的一次性全报出来（422 + details.fields）；不认识的项也拒绝；整批都不生效", async () => {
    const boss = await owner();
    const res = await boss.put("/settings", { maintenance: true, maxItemsPerChannel: 99, nope: 1 });
    expect(res.status).toBe(422);
    const body = await parse<ErrorBody>(res);
    expect(body.error.code).toBe("invalid_settings");
    expect(Object.keys(body.error.details?.fields ?? {}).sort()).toEqual(["maxItemsPerChannel", "nope"]);
    expect((await parse<{ settings: Settings }>(await boss.get("/settings"))).settings.maintenance).toBe(false);
  });

  it("设置里网站名单 / 屏蔽词改了，提交马上按新规则走", async () => {
    const boss = await owner();
    await boss.put("/settings", { allowedHosts: "javbus.com" });
    expect(await (await upload("user", { av: makeItem(1, { link: "https://other.example.com/1" }), mode: "upload" })).text()).toBe("FE");
    await boss.put("/settings", { allowedHosts: "" });
    expect(await (await upload("user", { av: makeItem(1, { link: "https://other.example.com/1" }), mode: "upload" })).text()).toBe("succeed");
  });
});

describe("统计与日志", () => {
  it("概览：各频道各状态的数量、检查结果、未处理举报、30 天趋势、维护者数", async () => {
    const boss = await owner();
    await seedUser("mod", "moderator");
    const ids = await seedItems(3);
    await boss.post("/items", { channel: "author", ...makeItem(9) });
    await boss.post("/items/status", { ids: [ids[2]], status: "hidden" });
    await env.DB.prepare("UPDATE items SET check_status = 'dead' WHERE id = ?").bind(ids[0]).run();
    await env.DB.prepare("UPDATE items SET check_status = 'ok' WHERE id = ?").bind(ids[1]).run();
    await reportFrom("device-rep-0001", "ABC-001");
    await reportFrom("device-rep-0002", "ABC-001");
    await reportFrom("device-rep-0001", "ABC-002");

    const stats = await parse<StatsDTO>(await boss.get("/stats"));
    expect(stats.channels.user).toEqual({ pending: 0, approved: 2, rejected: 0, hidden: 1 });
    expect(stats.channels.author).toEqual({ pending: 0, approved: 1, rejected: 0, hidden: 0 });
    expect(stats.checks).toEqual({ unchecked: 1, ok: 1, warn: 0, dead: 1 }); // 只统计已上线的
    expect(stats.openReports).toBe(2); // 按条目算，不是按举报条数
    expect(stats.maintainers).toBe(2);
    expect(stats.lastCheck).toBeNull();
    expect(stats.submissionsByDay).toHaveLength(30);
    expect(stats.submissionsByDay.at(-1)?.count).toBe(4);
    expect(stats.submissionsByDay.slice(0, 29).every((d) => d.count === 0)).toBe(true);
    expect(stats.submissionsByDay.at(-1)?.day).toBe(new Date().toISOString().slice(0, 10));
  });

  it("操作日志翻页的总数封顶 10000（没有筛选条件时 COUNT(*) 要扫全表，日志多了每翻一页都读几十万行）", async () => {
    const boss = await owner();
    await env.DB.prepare(
      "INSERT INTO audit_log (at, actor, action) SELECT 1000 + x, 'bulk', 'bulk.test' FROM (WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 10050) SELECT x FROM c)",
    ).run();
    const page = await parse<Paged<AuditDTO>>(await boss.get("/audit?pageSize=5"));
    expect(page.total).toBe(10000);
    expect(page.items).toHaveLength(5);
  });

  it("操作日志：最新在前，能按动作 / 操作人筛，能分页；协管也能看", async () => {
    const boss = await owner();
    const moderator = await seedUser("mod", "moderator");
    await boss.post("/items", { channel: "author", ...makeItem(1) });
    await boss.put("/settings", { maintenance: true });
    await moderator.post("/items", { channel: "author", ...makeItem(2) });

    const all = await parse<Paged<AuditDTO>>(await moderator.get("/audit"));
    expect(all.total).toBe(3);
    expect(all.items.map((a) => a.action)).toEqual(["item.create", "settings.update", "item.create"]);
    expect(all.items[0]).toMatchObject({ actor: "mod", targetType: "item", targetId: "ABC-002", detail: { channel: "author", status: "approved" } });

    expect((await parse<Paged<AuditDTO>>(await boss.get("/audit?action=settings.update"))).total).toBe(1);
    expect((await parse<Paged<AuditDTO>>(await boss.get("/audit?actor=BOSS"))).total).toBe(2); // 操作人不分大小写
    const page2 = await parse<Paged<AuditDTO>>(await boss.get("/audit?pageSize=2&page=2"));
    expect(page2.items).toHaveLength(1);
    expect(page2).toMatchObject({ total: 3, page: 2, pageSize: 2 });
  });
});
