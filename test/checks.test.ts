import { createExecutionContext, createScheduledController, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it } from "vitest";

import type { CheckRunDTO, CheckRunResultDTO, ItemDTO, Paged } from "../shared/types";
import { CHECK_CRON, DAILY_CRON } from "../src/cron";
import { runCheckBatch } from "../src/lib/checks";
import { loadConfig } from "../src/lib/settings";
import worker from "../src/index";
import { api, listCodes, makeItem, parse, resetDb, seedUser, setSettings, submit, type Admin } from "./helpers";
import { network } from "./network";

beforeEach(resetDb);

const DAY = 86_400_000;

interface Rule {
  status?: number;
  type?: string;
  /** 模拟网络错误（连不上 / 被重置）。 */
  error?: boolean;
}

const OK_IMAGE: Rule = { status: 206, type: "image/jpeg" };
const OK_PAGE: Rule = { status: 200, type: "text/html" };
const coverPath = (n: number) => `/pics/thumb/abc${n}.jpg`;
const linkPath = (n: number) => `/ABC-${String(n).padStart(3, "0")}`;
const healthy = (n: number): Record<string, Rule> => ({ [coverPath(n)]: OK_IMAGE, [linkPath(n)]: OK_PAGE });

interface Seen {
  path: string;
  referer: string | null;
  range: string | null;
  userAgent: string | null;
}

/** 按路径给 www.javbus.com 配响应；没配的路径一律 404。返回收到的请求记录。 */
function mockSite(rules: Record<string, Rule>): Seen[] {
  const seen: Seen[] = [];
  network.use(
    http.get("https://www.javbus.com/*", ({ request }) => {
      const { pathname } = new URL(request.url);
      seen.push({ path: pathname, referer: request.headers.get("referer"), range: request.headers.get("range"), userAgent: request.headers.get("user-agent") });
      const rule = rules[pathname] ?? { status: 404 };
      if (rule.error) return HttpResponse.error();
      return new HttpResponse("x", { status: rule.status ?? 200, headers: rule.type ? { "content-type": rule.type } : {} });
    }),
  );
  return seen;
}

async function moderator(): Promise<Admin> {
  return seedUser("mod", "moderator");
}

/** 返回的 Response 带 url：有 redirect 的模拟「fetch 跟随了重定向、最终落在那个地址上」（msw 的模拟响应不会被跟随，所以不用它）。 */
function redirectingFetcher(rules: Record<string, Rule & { redirect?: string }>): typeof fetch {
  return async (input) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const rule = rules[url.pathname] ?? { status: 404 };
    const finalUrl = rule.redirect ? new URL(rule.redirect, url).href : url.href;
    const status = rule.redirect ? 200 : (rule.status ?? 200);
    const headers = rule.redirect ? { "content-type": "text/html" } : rule.type ? { "content-type": rule.type } : undefined;
    return Object.defineProperty(new Response("x", { status, headers }), "url", { value: finalUrl });
  };
}

/** 直接调 runCheckBatch，用自定义的 fetcher。 */
async function runWithFetcher(admin: Admin, fetcher: typeof fetch): Promise<CheckRunDTO | null> {
  const { settings } = await loadConfig(env.DB);
  const now = Date.now();
  const { run } = await runCheckBatch(env.DB, settings, { trigger: "manual", actor: admin.name, userId: admin.id, notCheckedSince: now + 60_000 }, now, fetcher);
  return run;
}

async function runChecks(admin: Admin, body: Record<string, unknown> = {}): Promise<CheckRunResultDTO> {
  const res = await admin.post("/checks/run", body);
  expect(res.status).toBe(200);
  return parse<CheckRunResultDTO>(res);
}

async function itemRow(code: string): Promise<{ status: string; hidden_reason: string; check_status: string; check_detail: string; check_fail: number; checked_at: number | null }> {
  const row = await env.DB.prepare("SELECT status, hidden_reason, check_status, check_detail, check_fail, checked_at FROM items WHERE code = ?").bind(code).first<{
    status: string;
    hidden_reason: string;
    check_status: string;
    check_detail: string;
    check_fail: number;
    checked_at: number | null;
  }>();
  if (!row) throw new Error(`没有 ${code}`);
  return row;
}

/** 把所有条目的上次检查时间往前推 n 天：失效要「隔开一阵」才都算数，测试里不能真等。 */
async function resetRates(): Promise<void> {
  await env.DB.prepare("DELETE FROM rate_limits").run();
}

async function ageChecks(days: number): Promise<void> {
  await env.DB.prepare("UPDATE items SET checked_at = checked_at - ? WHERE checked_at IS NOT NULL").bind(days * DAY).run();
}

async function runCron(cron: string, at: number = Date.now()): Promise<void> {
  const controller = createScheduledController({ cron, scheduledTime: new Date(at) });
  const ctx = createExecutionContext();
  await worker.scheduled(controller, env, ctx);
  await waitOnExecutionContext(ctx);
}

describe("单条判定（手动检查一批）", () => {
  it("正常 / 失效 / 存疑 各种情形都落对", async () => {
    const mod = await moderator();
    for (const n of [1, 2, 3, 4, 5, 6]) await submit(n);
    mockSite({
      ...healthy(1), // 全正常
      [coverPath(2)]: OK_IMAGE,
      [linkPath(2)]: { status: 404 }, // 链接没了 → 失效
      [coverPath(3)]: OK_IMAGE,
      [linkPath(3)]: { status: 403 }, // 站点拒绝机器访问 → 存疑
      [coverPath(4)]: { status: 200, type: "text/html" }, // 封面返回了网页（防盗链页）→ 存疑
      [linkPath(4)]: OK_PAGE,
      [coverPath(5)]: { error: true }, // 连不上 → 存疑
      [linkPath(5)]: OK_PAGE,
      [coverPath(6)]: { status: 410 }, // 封面已删除 → 失效
      [linkPath(6)]: { status: 503 }, // 同时链接说不准：失效优先
    });

    const { run } = await runChecks(mod, { limit: 10 });
    expect(run).toMatchObject({ examined: 6, ok: 1, warn: 3, dead: 2, hidden: 0, trigger: "manual", by: "mod" });
    expect(run?.finishedAt).not.toBeNull();

    expect(await itemRow("ABC-001")).toMatchObject({ check_status: "ok", check_detail: "", check_fail: 0 });
    expect(await itemRow("ABC-002")).toMatchObject({ check_status: "dead", check_detail: "链接 HTTP 404", check_fail: 1 });
    expect(await itemRow("ABC-003")).toMatchObject({ check_status: "warn", check_detail: "链接 HTTP 403", check_fail: 0 });
    expect(await itemRow("ABC-004")).toMatchObject({ check_status: "warn", check_detail: "封面 不是图片（text/html）" });
    expect(await itemRow("ABC-005")).toMatchObject({ check_status: "warn", check_detail: "封面 网络错误" });
    expect(await itemRow("ABC-006")).toMatchObject({ check_status: "dead", check_detail: "封面 HTTP 410" });
    expect((await itemRow("ABC-001")).checked_at).not.toBeNull();
  });

  it("详情页先跳到年龄验证页（JavBus 的真实行为，curl 实测）：链接不参与判定，只看封面", async () => {
    const mod = await moderator();
    for (const n of [1, 2, 3]) await submit(n);
    const gate = "/doc/driver-verify?referer=x";
    const run = await runWithFetcher(
      mod,
      redirectingFetcher({
        [coverPath(1)]: OK_IMAGE,
        [linkPath(1)]: { redirect: gate }, // 封面正常 + 链接被挡 → 正常，没有多余的说明
        [coverPath(2)]: { status: 404 },
        [linkPath(2)]: { redirect: gate }, // 封面没了 → 失效
        [coverPath(3)]: { status: 403 },
        [linkPath(3)]: { redirect: gate }, // 封面说不准 → 存疑，说明里只有封面
      }),
    );
    expect(run).toMatchObject({ examined: 3, ok: 1, warn: 1, dead: 1 });
    expect(await itemRow("ABC-001")).toMatchObject({ check_status: "ok", check_detail: "", check_fail: 0 });
    expect(await itemRow("ABC-002")).toMatchObject({ check_status: "dead", check_detail: "封面 HTTP 404", check_fail: 1 });
    expect(await itemRow("ABC-003")).toMatchObject({ check_status: "warn", check_detail: "封面 HTTP 403" });
  });

  it("只检查链接、又被年龄验证页挡住：一项都没法判断 → 没查成（unchecked），说明里写清原因；不会被当成「正常」去清零计数 / 触发自动恢复", async () => {
    const mod = await moderator();
    await submit(1);
    await setSettings({ checkCover: false });
    const run = await runWithFetcher(mod, redirectingFetcher({ [linkPath(1)]: { redirect: "/doc/driver-verify?referer=x" } }));
    expect(run).toMatchObject({ examined: 1, ok: 0, warn: 0, dead: 0 });
    expect(await itemRow("ABC-001")).toMatchObject({ check_status: "unchecked", check_detail: "链接 站点先跳到年龄验证页，看不到真实页面" });
  });

  it("一项都没法判断时也不会把因失效隐藏的条目放回公开列表", async () => {
    const mod = await moderator();
    await submit(1);
    await setSettings({ checkCover: false });
    await env.DB.prepare("UPDATE items SET status = 'hidden', hidden_reason = 'check', check_fail = 3").run();
    await runWithFetcher(mod, redirectingFetcher({ [linkPath(1)]: { redirect: "/doc/driver-verify?referer=x" } }));
    expect(await itemRow("ABC-001")).toMatchObject({ status: "hidden", hidden_reason: "check", check_status: "unchecked", check_fail: 3 });
  });

  it("没有封面的条目、又不查链接：没有可检查的地址 → 没查成，不是正常", async () => {
    const mod = await moderator();
    await submit(1);
    await env.DB.prepare("UPDATE items SET src = ''").run();
    await setSettings({ checkLink: false });
    const run = await runWithFetcher(mod, redirectingFetcher({}));
    expect(run).toMatchObject({ examined: 1, ok: 0 });
    expect(await itemRow("ABC-001")).toMatchObject({ check_status: "unchecked" });
  });

  it("请求带上防盗链需要的 Referer、只取第一个字节的 Range、手机 UA；封面和链接各请求一次", async () => {
    const mod = await moderator();
    await submit(1);
    const seen = mockSite(healthy(1));
    await runChecks(mod);
    expect(seen).toHaveLength(2);
    const cover = seen.find((s) => s.path === coverPath(1));
    const page = seen.find((s) => s.path === linkPath(1));
    expect(cover).toMatchObject({ referer: "https://www.javbus.com/", range: "bytes=0-0" });
    expect(cover?.userAgent).toContain("iPhone");
    expect(page?.range).toBeNull();
  });

  it("设置里关掉封面 / 链接检查就不发对应的请求；没有封面地址的条目不查封面", async () => {
    const mod = await moderator();
    await submit(1);
    await setSettings({ checkCover: false });
    let seen = mockSite(healthy(1));
    await runChecks(mod);
    expect(seen.map((s) => s.path)).toEqual([linkPath(1)]);

    await setSettings({ checkCover: true, checkLink: false });
    seen = mockSite(healthy(1));
    await runChecks(mod);
    expect(seen.map((s) => s.path)).toEqual([coverPath(1)]);

    await env.DB.prepare("UPDATE items SET src = ''").run();
    await setSettings({ checkLink: true });
    seen = mockSite(healthy(1));
    await runChecks(mod);
    expect(seen.map((s) => s.path)).toEqual([linkPath(1)]);
  });

  it("两项检查都关着 → 409，提示去设置里打开", async () => {
    const mod = await moderator();
    await submit(1);
    await setSettings({ checkCover: false, checkLink: false });
    const res = await mod.post("/checks/run", {});
    expect(res.status).toBe(409);
    expect((await parse<{ error: { code: string } }>(res)).error.code).toBe("checks_disabled");
  });

  it("没有可查的条目 → run 为 null", async () => {
    const mod = await moderator();
    expect(await runChecks(mod)).toEqual({ run: null, remaining: 0 });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM check_runs").first()).toEqual({ n: 0 });
  });
});

describe("自动隐藏 / 自动恢复", () => {
  it("连续失效达到阈值才隐藏；之前只是计数", async () => {
    const mod = await moderator();
    await submit(1);
    await setSettings({ checkFailThreshold: 3 });
    mockSite({ [coverPath(1)]: OK_IMAGE, [linkPath(1)]: { status: 404 } });

    for (const fails of [1, 2]) {
      const { run } = await runChecks(mod);
      expect(run?.hidden).toBe(0);
      expect(await itemRow("ABC-001")).toMatchObject({ status: "approved", check_fail: fails });
      await ageChecks(2); // 离上次检查隔开了（默认复查间隔 3 天，要隔半个间隔才算又一次）
    }
    const { run } = await runChecks(mod);
    expect(run).toMatchObject({ dead: 1, hidden: 1, note: "自动隐藏 1 条" });
    expect(await itemRow("ABC-001")).toMatchObject({ status: "hidden", hidden_reason: "check", check_fail: 3 });
    expect(await listCodes("user")).toEqual([]);
    expect(await env.DB.prepare("SELECT actor, detail FROM audit_log WHERE action = 'check.visibility'").first()).toMatchObject({ actor: "system" });
  });

  it("中间只要有一次正常，连续失效的计数就清零；存疑不加不减", async () => {
    const mod = await moderator();
    await submit(1);
    await setSettings({ checkFailThreshold: 3 });
    mockSite({ [coverPath(1)]: OK_IMAGE, [linkPath(1)]: { status: 404 } });
    await runChecks(mod);
    await ageChecks(2);
    await runChecks(mod);
    await ageChecks(2);
    expect((await itemRow("ABC-001")).check_fail).toBe(2);

    mockSite({ [coverPath(1)]: OK_IMAGE, [linkPath(1)]: { status: 403 } });
    await runChecks(mod);
    await ageChecks(2);
    expect(await itemRow("ABC-001")).toMatchObject({ check_status: "warn", check_fail: 2 });

    mockSite(healthy(1));
    await runChecks(mod);
    expect(await itemRow("ABC-001")).toMatchObject({ check_status: "ok", check_fail: 0 });
  });

  it("因失效被隐藏的，恢复正常后自动放回来", async () => {
    const mod = await moderator();
    await submit(1);
    await setSettings({ checkFailThreshold: 1 });
    mockSite({ [coverPath(1)]: OK_IMAGE, [linkPath(1)]: { status: 404 } });
    await runChecks(mod);
    expect(await itemRow("ABC-001")).toMatchObject({ status: "hidden", hidden_reason: "check" });

    mockSite(healthy(1));
    const { run } = await runChecks(mod);
    expect(run).toMatchObject({ ok: 1, hidden: 0, note: "自动恢复 1 条" });
    expect(await itemRow("ABC-001")).toMatchObject({ status: "approved", hidden_reason: "" });
    expect(await listCodes("user")).toEqual(["ABC-001"]);
  });

  it("同一个条目短时间内连着检查几次，失效只算一次（隔不到半个复查间隔的不累计）：手动连点几次不会几分钟内凑够阈值", async () => {
    const mod = await moderator();
    await submit(1);
    await setSettings({ checkFailThreshold: 3 });
    mockSite({ [coverPath(1)]: OK_IMAGE, [linkPath(1)]: { status: 404 } });
    for (let i = 0; i < 5; i++) await runChecks(mod);
    expect(await itemRow("ABC-001")).toMatchObject({ status: "approved", check_status: "dead", check_fail: 1 });
    await ageChecks(2);
    await runChecks(mod);
    expect((await itemRow("ABC-001")).check_fail).toBe(2);
  });

  it("整批几乎都失效（≥ 5 条且 ≥ 80%）：多半是站点在拦我们，整批改判存疑，不累计失效、不自动隐藏", async () => {
    const mod = await moderator();
    await setSettings({ submitPerHourIp: 1000, submitPerDayIp: 5000, checkFailThreshold: 1 });
    const rules: Record<string, Rule> = {};
    for (let n = 1; n <= 6; n++) {
      expect(await submit(n)).toBe("succeed");
      rules[coverPath(n)] = n === 6 ? OK_IMAGE : { status: 404 }; // 6 条里 5 条 404（83%）
      rules[linkPath(n)] = OK_PAGE;
    }
    mockSite(rules);
    const { run } = await runChecks(mod);
    expect(run).toMatchObject({ examined: 6, ok: 1, warn: 5, dead: 0, hidden: 0 });
    expect(run?.note).toContain("整批几乎都失效");
    expect(await itemRow("ABC-001")).toMatchObject({ status: "approved", check_status: "warn", check_fail: 0 });
    expect((await itemRow("ABC-001")).check_detail).toContain("整批几乎都失效");
    expect(await listCodes("user")).toHaveLength(6);
  });

  it("没到「整批异常」的规模（少于 5 条）或比例不够：照常判失效；手动指定几条也照常", async () => {
    const mod = await moderator();
    await setSettings({ submitPerHourIp: 1000, submitPerDayIp: 5000, checkFailThreshold: 1 });
    for (let n = 1; n <= 4; n++) expect(await submit(n)).toBe("succeed");
    mockSite({ ...healthy(1), [coverPath(2)]: { status: 404 }, [linkPath(2)]: OK_PAGE, [coverPath(3)]: { status: 404 }, [linkPath(3)]: OK_PAGE, [coverPath(4)]: { status: 404 }, [linkPath(4)]: OK_PAGE });
    const { run } = await runChecks(mod); // 4 条里 3 条失效：少于 5 条，不算整批异常
    expect(run).toMatchObject({ examined: 4, dead: 3, hidden: 3 });

    // 手动指定：6 条全 404 也照常判失效
    await env.DB.prepare("DELETE FROM items").run();
    await resetRates();
    const ids: number[] = [];
    const rules: Record<string, Rule> = {};
    for (let n = 11; n <= 16; n++) {
      expect(await submit(n)).toBe("succeed");
      rules[coverPath(n)] = { status: 404 };
      rules[linkPath(n)] = OK_PAGE;
    }
    const rows = await env.DB.prepare("SELECT id FROM items").all<{ id: number }>();
    for (const row of rows.results) ids.push(row.id);
    mockSite(rules);
    const picked = await runChecks(mod, { itemIds: ids });
    expect(picked.run).toMatchObject({ examined: 6, dead: 6 });
  });

  it("子请求额度用完（Too many subrequests）：请求没发出去的条目这次不算查过——不记结果、不动检查时间和失效计数，记录里写明", async () => {
    const mod = await moderator();
    await submit(1);
    await submit(2);
    const run = await runWithFetcher(mod, async (input) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      if (url.pathname.includes("002") || url.pathname.includes("abc2")) throw new Error("Too many subrequests by single Worker invocation.");
      return Object.defineProperty(new Response("x", { status: 200, headers: { "content-type": url.pathname.endsWith(".jpg") ? "image/jpeg" : "text/html" } }), "url", { value: url.href });
    });
    expect(run).toMatchObject({ examined: 1, ok: 1 });
    expect(run?.note).toContain("1 个没来得及查");
    expect(await itemRow("ABC-001")).toMatchObject({ check_status: "ok" });
    expect(await itemRow("ABC-002")).toMatchObject({ check_status: "unchecked", checked_at: null, check_fail: 0 });
  });

  it("维护者手动隐藏的不会被自动放回来（不在检查范围内）", async () => {
    const mod = await moderator();
    await submit(1);
    await env.DB.prepare("UPDATE items SET status = 'hidden', hidden_reason = 'manual'").run();
    const seen = mockSite(healthy(1));
    expect(await runChecks(mod)).toEqual({ run: null, remaining: 0 });
    expect(seen).toHaveLength(0);
    expect(await itemRow("ABC-001")).toMatchObject({ status: "hidden", hidden_reason: "manual" });
  });

  it("关掉「失效自动隐藏」：只标记，不隐藏也不恢复", async () => {
    const mod = await moderator();
    await submit(1);
    await setSettings({ checkAutoHide: false, checkFailThreshold: 1 });
    mockSite({ [coverPath(1)]: OK_IMAGE, [linkPath(1)]: { status: 404 } });
    const { run } = await runChecks(mod);
    expect(run).toMatchObject({ dead: 1, hidden: 0 });
    expect(await itemRow("ABC-001")).toMatchObject({ status: "approved", check_status: "dead", check_fail: 1 });

    await env.DB.prepare("UPDATE items SET status = 'hidden', hidden_reason = 'check'").run();
    mockSite(healthy(1));
    await runChecks(mod);
    expect(await itemRow("ABC-001")).toMatchObject({ status: "hidden" }); // 自动恢复也归「自动」开关管
  });

  it("隐藏 / 恢复后公开列表的快照随之更新", async () => {
    const mod = await moderator();
    await submit(1);
    await submit(2);
    await setSettings({ checkFailThreshold: 1 });
    const before = (await api("/api/v1/rec/user")).headers.get("ETag");
    mockSite({ ...healthy(2), [coverPath(1)]: OK_IMAGE, [linkPath(1)]: { status: 404 } });
    await runChecks(mod);
    expect(await listCodes("user")).toEqual(["ABC-002"]);
    expect((await api("/api/v1/rec/user")).headers.get("ETag")).not.toBe(before);
  });

  it("全是正常的批次不动快照（版本号不变）", async () => {
    const mod = await moderator();
    await submit(1);
    const before = (await api("/api/v1/rec/user")).headers.get("ETag");
    mockSite(healthy(1));
    await runChecks(mod);
    expect((await api("/api/v1/rec/user")).headers.get("ETag")).toBe(before);
  });
});

describe("批量与「全部检查」", () => {
  async function seedMany(count: number): Promise<void> {
    await setSettings({ submitPerHourIp: 1000, submitPerDayIp: 5000 }); // 默认每 IP 每小时 20 条，造 25 条会被限频
    for (let i = 1; i <= count; i++) expect(await submit(i)).toBe("succeed");
    const rules: Record<string, Rule> = {};
    for (let i = 1; i <= count; i++) Object.assign(rules, healthy(i));
    mockSite(rules);
  }

  it("一批最多查设置里的数量，最久没查 / 从没查过的优先", async () => {
    const mod = await moderator();
    await seedMany(5);
    await setSettings({ checkBatchSize: 2 });
    expect((await runChecks(mod)).run?.examined).toBe(2);
    const checked = await env.DB.prepare("SELECT code FROM items WHERE checked_at IS NOT NULL ORDER BY code").all<{ code: string }>();
    expect(checked.results.map((r) => r.code)).toEqual(["ABC-001", "ABC-002"]); // 同样没查过的，先建的先查
    expect((await runChecks(mod)).run?.examined).toBe(2);
    const second = await env.DB.prepare("SELECT code FROM items WHERE checked_at IS NOT NULL ORDER BY code").all<{ code: string }>();
    expect(second.results.map((r) => r.code)).toEqual(["ABC-001", "ABC-002", "ABC-003", "ABC-004"]);
  });

  it("一批最多 25 个（免费版一次调用最多 50 个子请求，每个条目 2 个）：limit 填再大也封顶", async () => {
    const mod = await moderator();
    await seedMany(30);
    expect((await runChecks(mod, { limit: 200 })).run?.examined).toBe(25);
  });

  it("指定条目：选了几个就查几个，不被「每次检查几个条目」的设置截断", async () => {
    const mod = await moderator();
    await seedMany(15);
    await setSettings({ checkBatchSize: 10 });
    const rows = await env.DB.prepare("SELECT id FROM items").all<{ id: number }>();
    const { run } = await runChecks(mod, { itemIds: rows.results.map((r) => r.id) });
    expect(run?.examined).toBe(15);
  });

  it("limit 参数可以临时放大 / 缩小；不合法 → 422", async () => {
    const mod = await moderator();
    await seedMany(4);
    expect((await runChecks(mod, { limit: 3 })).run?.examined).toBe(3);
    expect((await mod.post("/checks/run", { limit: 0 })).status).toBe(422);
    expect((await mod.post("/checks/run", { limit: 1.5 })).status).toBe(422);
  });

  it("全部检查：带上整轮开始的时刻反复调，remaining 递减到 0，那个时刻之后查过的不会再查", async () => {
    const admin = await seedUser("adm", "admin");
    await seedMany(25);
    await setSettings({ checkBatchSize: 10 });
    const sweepStart = Date.now();
    const examined: number[] = [];
    const remaining: number[] = [];
    for (;;) {
      const { run, remaining: left } = await runChecks(admin, { olderThan: sweepStart });
      if (!run) break;
      examined.push(run.examined);
      remaining.push(left);
    }
    expect(examined).toEqual([10, 10, 5]);
    expect(remaining).toEqual([15, 5, 0]);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM items WHERE checked_at IS NULL").first()).toEqual({ n: 0 });
  });

  it("olderThan 需要管理员权限；未来太远 / 不是数字 → 422", async () => {
    const mod = await moderator();
    const admin = await seedUser("adm", "admin");
    expect((await mod.post("/checks/run", { olderThan: Date.now() })).status).toBe(403);
    expect((await admin.post("/checks/run", { olderThan: Date.now() + 10 * 60_000 })).status).toBe(422);
    expect((await admin.post("/checks/run", { olderThan: "yesterday" })).status).toBe(422);
    expect((await admin.post("/checks/run", { olderThan: -5 })).status).toBe(422);
  });

  it("指定条目：查指定的那几条（待审的也行），自动隐藏不动待审的", async () => {
    const mod = await moderator();
    await setSettings({ autoApproveUser: false, checkFailThreshold: 1 });
    expect(await submit(1)).toBe("PD");
    mockSite({ [coverPath(1)]: OK_IMAGE, [linkPath(1)]: { status: 404 } });
    const row = await env.DB.prepare("SELECT id FROM items").first<{ id: number }>();
    const { run } = await runChecks(mod, { itemIds: [row?.id] });
    expect(run).toMatchObject({ examined: 1, dead: 1, hidden: 0 });
    expect(await itemRow("ABC-001")).toMatchObject({ status: "pending", check_status: "dead" });
  });

  it("指定条目最多 25 个；id 不合法 → 422", async () => {
    const mod = await moderator();
    expect((await mod.post("/checks/run", { itemIds: Array.from({ length: 26 }, (_, i) => i + 1) })).status).toBe(422);
    expect((await mod.post("/checks/run", { itemIds: [] })).status).toBe(422);
    expect((await mod.post("/checks/run", { itemIds: ["a"] })).status).toBe(422);
  });

  it("检查记录列表：最新在前，带操作人；手动检查留一条操作日志", async () => {
    const mod = await moderator();
    await seedMany(1);
    await runChecks(mod);
    await runChecks(mod);
    const { runs } = await parse<{ runs: CheckRunDTO[]; remaining: number }>(await mod.get("/checks"));
    expect(runs).toHaveLength(2);
    expect(runs[0]?.id).toBeGreaterThan(runs[1]?.id ?? 0);
    expect(runs[0]).toMatchObject({ trigger: "manual", by: "mod", examined: 1, ok: 1 });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'check.run'").first()).toEqual({ n: 2 });
  });
});

describe("定时任务（cron）", () => {
  it("每 30 分钟那次：查一批，记成 cron 运行（没有操作人）", async () => {
    const mod = await moderator();
    await submit(1);
    mockSite(healthy(1));
    await runCron(CHECK_CRON);
    const { runs } = await parse<{ runs: CheckRunDTO[] }>(await mod.get("/checks"));
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ trigger: "cron", by: null, examined: 1, ok: 1 });
    expect(await itemRow("ABC-001")).toMatchObject({ check_status: "ok" });
  });

  it("设置里关掉自动检查就什么都不做", async () => {
    await submit(1);
    await setSettings({ checksEnabled: false });
    const seen = mockSite(healthy(1));
    await runCron(CHECK_CRON);
    expect(seen).toHaveLength(0);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM check_runs").first()).toEqual({ n: 0 });
  });

  it("遵守复查间隔和批量大小：刚查过的不再查，每次只查设置里那么多", async () => {
    await setSettings({ checkBatchSize: 2, checkIntervalDays: 3 });
    for (let i = 1; i <= 5; i++) await submit(i);
    const rules: Record<string, Rule> = {};
    for (let i = 1; i <= 5; i++) Object.assign(rules, healthy(i));
    mockSite(rules);

    const examinedAfter = async () => (await env.DB.prepare("SELECT COUNT(*) AS n FROM items WHERE checked_at IS NOT NULL").first<{ n: number }>())?.n;
    await runCron(CHECK_CRON);
    expect(await examinedAfter()).toBe(2);
    await runCron(CHECK_CRON);
    expect(await examinedAfter()).toBe(4);
    await runCron(CHECK_CRON);
    expect(await examinedAfter()).toBe(5);
    const runsBefore = await env.DB.prepare("SELECT COUNT(*) AS n FROM check_runs").first<{ n: number }>();
    await runCron(CHECK_CRON); // 全都刚查过，没有要查的 → 不留空记录
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM check_runs").first()).toEqual(runsBefore);

    // 过了复查间隔，又该查了（最久没查的先查）
    await env.DB.prepare("UPDATE items SET checked_at = ? WHERE code IN ('ABC-004', 'ABC-005')").bind(Date.now() - 4 * DAY).run();
    await runCron(CHECK_CRON);
    const rechecked = await env.DB.prepare("SELECT code FROM items WHERE checked_at > ? ORDER BY code").bind(Date.now() - DAY).all<{ code: string }>();
    expect(rechecked.results).toHaveLength(5);
    expect((await env.DB.prepare("SELECT examined FROM check_runs ORDER BY id DESC LIMIT 1").first<{ examined: number }>())?.examined).toBe(2);
  });
});

describe("每天凌晨清理（cron）", () => {
  it("清掉过期的频率计数 / 会话 / 旧邀请 / 太旧的日志 / 多余的检查记录 / 处理完的旧举报，没过期的保留", async () => {
    const now = Date.now();
    const owner = await seedUser("boss"); // 带一个没过期的会话
    await submit(1);
    const item = await env.DB.prepare("SELECT id FROM items").first<{ id: number }>();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO rate_limits (key, count, expires_at) VALUES ('old', 1, ?), ('fresh', 1, ?)").bind(now - 1000, now + 100000),
      env.DB.prepare("INSERT INTO sessions (id_hash, user_id, created_at, expires_at, last_seen_at) VALUES ('expired', ?1, 1, ?2, 1)").bind(owner.id, now - 1000),
      env.DB.prepare("INSERT INTO invites (token_hash, role, created_at, expires_at) VALUES ('stale', 'moderator', 1, ?1), ('open', 'moderator', ?2, ?3)").bind(now - 40 * DAY, now, now + DAY),
      env.DB.prepare("INSERT INTO audit_log (at, actor, action) VALUES (?1, 'x', 'old'), (?2, 'x', 'recent')").bind(now - 400 * DAY, now),
      env.DB.prepare("INSERT INTO reports (item_id, reporter, created_at, status) VALUES (?1, 'a', ?2, 'dismissed'), (?1, 'b', ?3, 'dismissed'), (?1, 'c', ?2, 'open')").bind(item?.id, now - 200 * DAY, now),
    ]);
    // 305 条检查记录 → 只保留最新 300 条
    const runs = Array.from({ length: 305 }, () => env.DB.prepare("INSERT INTO check_runs (started_at, finished_at, trigger) VALUES (?, ?, 'cron')").bind(now - 10_000, now - 9_000));
    await env.DB.batch(runs);
    // 一条超过 1 小时还没结束的运行 = 中途中断
    await env.DB.prepare("INSERT INTO check_runs (started_at, trigger) VALUES (?, 'cron')").bind(now - 2 * 3600_000).run();

    await runCron(DAILY_CRON, now);

    const limitKeys = (await env.DB.prepare("SELECT key FROM rate_limits").all<{ key: string }>()).results.map((r) => r.key);
    expect(limitKeys).toContain("fresh");
    expect(limitKeys).not.toContain("old");
    expect((await env.DB.prepare("SELECT id_hash FROM sessions").all<{ id_hash: string }>()).results.map((r) => r.id_hash)).not.toContain("expired");
    expect((await env.DB.prepare("SELECT token_hash FROM invites").all<{ token_hash: string }>()).results.map((r) => r.token_hash)).toEqual(["open"]);
    expect((await env.DB.prepare("SELECT action FROM audit_log").all<{ action: string }>()).results.map((r) => r.action)).not.toContain("old");
    expect((await env.DB.prepare("SELECT action FROM audit_log").all<{ action: string }>()).results.map((r) => r.action)).toContain("recent");
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM check_runs").first()).toEqual({ n: 300 });
    // 处理完且超过半年的举报删掉（a）；刚处理的（b）和没处理的（c）保留
    expect((await env.DB.prepare("SELECT reporter FROM reports ORDER BY reporter").all<{ reporter: string }>()).results.map((r) => r.reporter)).toEqual(["b", "c"]);
    expect(await env.DB.prepare("SELECT note FROM check_runs WHERE note != ''").first()).toEqual({ note: "中途中断" });
  });

  it("待审超过天数自动拒绝（备注留下原因）；天数设成 0 就不处理", async () => {
    await setSettings({ autoApproveUser: false, pendingExpireDays: 14 });
    for (const n of [1, 2]) await submit(n);
    await env.DB.prepare("UPDATE items SET created_at = ? WHERE code = 'ABC-001'").bind(Date.now() - 15 * DAY).run();
    await runCron(DAILY_CRON);
    expect(await itemRow("ABC-001")).toMatchObject({ status: "rejected" });
    expect(await itemRow("ABC-002")).toMatchObject({ status: "pending" });
    expect(await env.DB.prepare("SELECT note FROM items WHERE code = 'ABC-001'").first()).toEqual({ note: "待审超时，自动拒绝" });
    expect(await env.DB.prepare("SELECT actor, detail FROM audit_log WHERE action = 'item.expire_pending'").first()).toMatchObject({ actor: "system" });

    await setSettings({ pendingExpireDays: 0 });
    await env.DB.prepare("UPDATE items SET created_at = ? WHERE code = 'ABC-002'").bind(Date.now() - 100 * DAY).run();
    await runCron(DAILY_CRON);
    expect(await itemRow("ABC-002")).toMatchObject({ status: "pending" });
  });

  it("重建两份快照（补上中断时漏掉的），其中一份和库里不一致时被纠正", async () => {
    await submit(1);
    await env.DB.prepare("UPDATE snapshots SET body = '[]', count = 0 WHERE channel = 'user'").run(); // 模拟漏重建
    expect(await listCodes("user")).toEqual([]);
    await runCron(DAILY_CRON);
    expect(await listCodes("user")).toEqual(["ABC-001"]);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM snapshots").first()).toEqual({ n: 2 });
  });

  it("日志保留天数按设置：留得更短就清得更多", async () => {
    await setSettings({ auditRetentionDays: 7 });
    const now = Date.now();
    await env.DB.prepare("INSERT INTO audit_log (at, actor, action) VALUES (?1, 'x', 'ten-days'), (?2, 'x', 'two-days')").bind(now - 10 * DAY, now - 2 * DAY).run();
    await runCron(DAILY_CRON, now);
    expect((await env.DB.prepare("SELECT action FROM audit_log").all<{ action: string }>()).results.map((r) => r.action)).toEqual(["two-days"]);
  });
});

describe("被检查的地址是怎么进来的（防滥用）", () => {
  it("内网 / 本机地址根本进不了库，也就不会被 Worker 去访问", async () => {
    const res = await api("/api/v1/upload/user", { json: { av: makeItem(1, { link: "http://169.254.169.254/latest/meta-data" }), mode: "upload" } });
    expect(await res.text()).toBe("FE");
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM items").first()).toEqual({ n: 0 });
  });

  it("维护者手动改成内网地址也会被拒绝", async () => {
    const boss = await seedUser("boss");
    await submit(1);
    const { items } = await parse<Paged<ItemDTO>>(await boss.get("/items"));
    const res = await boss.patch(`/items/${items[0]?.id}`, { link: "https://127.0.0.1/x" });
    expect(res.status).toBe(422);
  });
});
