// API 客户端：请求头、请求体、错误归一化、「会话没了」的判断。用假的 fetch，不碰网络。

import { describe, expect, it, vi } from "vitest";

import { createApi } from "../src/api";
import { ApiError } from "../src/lib/errors";

interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
  credentials: RequestCredentials | undefined;
}

/** 造一个假 fetch：记下每次请求，按顺序返回给定的响应。 */
function fakeFetch(...responses: (Response | Error)[]) {
  const calls: Recorded[] = [];
  const impl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers: { ...(init?.headers as Record<string, string> | undefined) },
      body: typeof init?.body === "string" ? init.body : undefined,
      credentials: init?.credentials,
    });
    const next = responses.shift() ?? json({});
    if (next instanceof Error) throw next;
    return next;
  });
  return { calls, fetch: impl as unknown as typeof fetch };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function failure(status: number, code: string, message: string, details?: unknown): Response {
  return json({ error: { code, message, ...(details === undefined ? {} : { details }) } }, status);
}

describe("请求的基本形状", () => {
  it("GET：带 X-JC-Admin 头、同源 cookie、不带请求体；查询参数去掉空值", async () => {
    const { calls, fetch } = fakeFetch(json({ items: [], total: 0, page: 1, pageSize: 50 }));
    const api = createApi({ fetch });
    await api.items({ status: "pending", q: "", page: 2, check: undefined });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ url: "/api/admin/items?status=pending&page=2", method: "GET", body: undefined, credentials: "same-origin" });
    expect(calls[0]?.headers["X-JC-Admin"]).toBe("1");
    expect(calls[0]?.headers.Accept).toBe("application/json");
    expect(calls[0]?.headers["Content-Type"]).toBeUndefined();
  });

  it("POST：JSON 请求体 + Content-Type；没有参数的 POST 也带 {}（/checks/run 的空体会被当成非法 JSON）", async () => {
    const { calls, fetch } = fakeFetch(json({ changed: 2 }), json({ run: null, remaining: 0 }), json({ ok: true }));
    const api = createApi({ fetch });
    await api.setItemsStatus([1, 2], "hidden");
    await api.runChecks();
    await api.logout();
    expect(calls[0]).toMatchObject({ url: "/api/admin/items/status", method: "POST", body: JSON.stringify({ ids: [1, 2], status: "hidden" }) });
    expect(calls[0]?.headers["Content-Type"]).toBe("application/json");
    expect(calls[1]).toMatchObject({ url: "/api/admin/checks/run", method: "POST", body: "{}" });
    expect(calls[2]?.body).toBe("{}");
    for (const call of calls) expect(call.headers["X-JC-Admin"]).toBe("1");
  });

  it("检查：指定条目只带 itemIds（有几个查几个），全部检查带 olderThan，limit 是可选的", async () => {
    const { calls, fetch } = fakeFetch(json({ run: null, remaining: 0 }), json({ run: null, remaining: 0 }), json({ run: null, remaining: 0 }));
    const api = createApi({ fetch });
    await api.runChecks({ itemIds: [3, 4] });
    await api.runChecks({ olderThan: 1_790_000_000_000 });
    await api.runChecks({ limit: 5 });
    expect(JSON.parse(calls[0]?.body ?? "")).toEqual({ itemIds: [3, 4] });
    expect(JSON.parse(calls[1]?.body ?? "")).toEqual({ olderThan: 1_790_000_000_000 });
    expect(JSON.parse(calls[2]?.body ?? "")).toEqual({ limit: 5 });
  });

  it("下载远程列表：只传 url，返回服务端原样的条目和 invalid 计数", async () => {
    const { calls, fetch } = fakeFetch(json({ items: [{ code: "A-1", link: "https://example.com/1", extra: 1 }], invalid: 2 }));
    const result = await createApi({ fetch }).fetchRemote("https://gitlab.com/x/raw/master/Rec");
    expect(JSON.parse(calls[0]?.body ?? "")).toEqual({ url: "https://gitlab.com/x/raw/master/Rec" });
    expect(calls[0]?.url).toBe("/api/admin/items/import/fetch");
    expect(result).toEqual({ items: [{ code: "A-1", link: "https://example.com/1", extra: 1 }], invalid: 2 });
  });

  it("PATCH / PUT / DELETE 的方法和路径", async () => {
    const { calls, fetch } = fakeFetch(json({}), json({ settings: {} }), json({ ok: true }), json({ ok: true }));
    const api = createApi({ fetch });
    await api.patchItem(7, { note: "x" });
    await api.saveSettings({ maintenance: true });
    await api.revokeAppKey(3);
    await api.revokeInvite("0123456789ab");
    expect(calls.map((c) => [c.method, c.url])).toEqual([
      ["PATCH", "/api/admin/items/7"],
      ["PUT", "/api/admin/settings"],
      ["DELETE", "/api/admin/me/app-keys/3"],
      ["DELETE", "/api/admin/invites/0123456789ab"],
    ]);
    expect(calls[1]?.body).toBe(JSON.stringify({ maintenance: true }));
    expect(calls[2]?.body).toBeUndefined();
  });

  it("解封：值要 encodeURIComponent（番号里可能有特殊字符）", async () => {
    const { calls, fetch } = fakeFetch(json({ ok: true }));
    await createApi({ fetch }).removeBan("code", "FC2-PPV/1 2");
    expect(calls[0]?.url).toBe("/api/admin/bans/code/FC2-PPV%2F1%202");
  });

  it("导入：order 原样带上", async () => {
    const { calls, fetch } = fakeFetch(json({ received: 1, inserted: 1, skipped: 0, invalid: 0, samples: [] }));
    await createApi({ fetch }).importItems({ channel: "user", status: "approved", items: [{ code: "A-1" }], order: { base: 123, offset: 500 } });
    expect(JSON.parse(calls[0]?.body ?? "")).toEqual({ channel: "user", status: "approved", items: [{ code: "A-1" }], order: { base: 123, offset: 500 } });
  });

  it("导出是下载链接：拼好地址，不发请求", () => {
    const { calls, fetch } = fakeFetch();
    const api = createApi({ fetch });
    expect(api.exportUrl({})).toBe("/api/admin/export");
    expect(api.exportUrl({ channel: "author", status: "approved" })).toBe("/api/admin/export?channel=author&status=approved");
    expect(calls).toHaveLength(0);
  });

  it("可以改 base（反向代理挂在子路径时）", async () => {
    const { calls, fetch } = fakeFetch(json({}));
    await createApi({ fetch, base: "/x/api/admin" }).stats();
    expect(calls[0]?.url).toBe("/x/api/admin/stats");
  });
});

describe("出错：统一成 ApiError", () => {
  it("后端的 { error } 变成 ApiError，message 原样（后端已经是中文）", async () => {
    const { fetch } = fakeFetch(failure(409, "exists", "这个番号已经在这份列表里了"));
    const error = await createApi({ fetch }).createItem({ channel: "user", code: "A-1", link: "https://example.com/1" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 409, code: "exists", message: "这个番号已经在这份列表里了" });
  });

  it("422 invalid_settings 的 details.fields 取得出来", async () => {
    const { fetch } = fakeFetch(failure(422, "invalid_settings", "这些设置不合法：maxItemsPerChannel", { fields: { maxItemsPerChannel: "应该是 100 到 8000 之间的整数" } }));
    const error = (await createApi({ fetch }).saveSettings({ maxItemsPerChannel: 1 }).catch((e: unknown) => e)) as ApiError;
    expect(error.fieldErrors).toEqual({ maxItemsPerChannel: "应该是 100 到 8000 之间的整数" });
  });

  it("响应不是 JSON（代理的 502 页面）→ 按状态码的兜底文案", async () => {
    const { fetch } = fakeFetch(new Response("<html>Bad Gateway</html>", { status: 502 }));
    const error = (await createApi({ fetch }).stats().catch((e: unknown) => e)) as ApiError;
    expect(error).toMatchObject({ status: 502, code: "http_502" });
    expect(error.message).toContain("502");
  });

  it("断网 / 服务没起：status 0 的 network 错误", async () => {
    const { fetch } = fakeFetch(new TypeError("Failed to fetch"));
    const error = (await createApi({ fetch }).stats().catch((e: unknown) => e)) as ApiError;
    expect(error).toMatchObject({ status: 0, code: "network" });
  });

  it("成功响应但不是合法 JSON → bad_response", async () => {
    const { fetch } = fakeFetch(new Response("不是 json", { status: 200 }));
    const error = (await createApi({ fetch }).stats().catch((e: unknown) => e)) as ApiError;
    expect(error).toMatchObject({ code: "bad_response" });
  });
});

describe("会话没了：401 unauthorized 才通知外面清登录态", () => {
  it("普通接口收到 401 unauthorized → 触发 onSessionLost，同时仍然抛错", async () => {
    const onSessionLost = vi.fn();
    const { fetch } = fakeFetch(failure(401, "unauthorized", "登录已过期，请重新登录"));
    await expect(createApi({ fetch, onSessionLost }).items({})).rejects.toBeInstanceOf(ApiError);
    expect(onSessionLost).toHaveBeenCalledTimes(1);
    expect(onSessionLost.mock.calls[0]?.[0]).toMatchObject({ code: "unauthorized" });
  });

  it("二次验证码填错也是 401（totp_invalid），但不是掉线，不能把人踢回登录页", async () => {
    const onSessionLost = vi.fn();
    const { fetch } = fakeFetch(failure(401, "totp_invalid", "验证码不对"), failure(401, "totp_invalid", "验证码不对"));
    const api = createApi({ fetch, onSessionLost });
    await expect(api.totpEnable("000000")).rejects.toMatchObject({ code: "totp_invalid" });
    await expect(api.totpDisable("000000")).rejects.toMatchObject({ code: "totp_invalid" });
    expect(onSessionLost).not.toHaveBeenCalled();
  });

  it("登录前就会调的接口（探测登录态、登录、安装、加入、邀请预览）不触发", async () => {
    const onSessionLost = vi.fn();
    const { fetch } = fakeFetch(
      failure(401, "unauthorized", "请先登录"),
      failure(401, "unauthorized", "x"),
      failure(401, "unauthorized", "x"),
      failure(401, "unauthorized", "x"),
      failure(401, "unauthorized", "x"),
    );
    const api = createApi({ fetch, onSessionLost });
    await api.me().catch(() => undefined);
    await api.login({ key: "k" }).catch(() => undefined);
    await api.setup({ token: "t", name: "boss" }).catch(() => undefined);
    await api.join({ token: "t", name: "boss" }).catch(() => undefined);
    await api.invite("t").catch(() => undefined);
    expect(onSessionLost).not.toHaveBeenCalled();
  });

  it("登录时的 401（密钥不对 / 要验证码）原样抛给登录页，由它自己显示", async () => {
    const { fetch } = fakeFetch(failure(401, "totp_required", "请输入验证器里的 6 位验证码"));
    await expect(createApi({ fetch }).login({ key: "jck_x" })).rejects.toMatchObject({ status: 401, code: "totp_required" });
  });
});

describe("登录前的接口", () => {
  it("邀请预览把令牌放在查询参数里；登录带 totp", async () => {
    const { calls, fetch } = fakeFetch(json({ valid: true, siteName: "x" }), json({ me: {} }));
    const api = createApi({ fetch });
    await api.invite("jci_a-b_c");
    await api.login({ key: "jck_k", totp: "123456" });
    expect(calls[0]?.url).toBe("/api/admin/invite?token=jci_a-b_c");
    expect(JSON.parse(calls[1]?.body ?? "")).toEqual({ key: "jck_k", totp: "123456" });
  });
});
