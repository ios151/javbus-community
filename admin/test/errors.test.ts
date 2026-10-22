import { describe, expect, it } from "vitest";

import { ApiError, errorMessage, networkError, parseErrorBody } from "../src/lib/errors";

describe("parseErrorBody：把后端的错误体归一成 ApiError", () => {
  it("标准的 { error: { code, message } }", () => {
    const error = parseErrorBody(422, JSON.stringify({ error: { code: "invalid_item", message: "封面地址：不是合法的地址" } }));
    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(422);
    expect(error.code).toBe("invalid_item");
    expect(error.message).toBe("封面地址：不是合法的地址");
    expect(error.details).toBeUndefined();
  });

  it("带 details 原样保留", () => {
    const details = { fields: { maxItemsPerChannel: "应该是 100 到 8000 之间的整数" } };
    const error = parseErrorBody(422, JSON.stringify({ error: { code: "invalid_settings", message: "这些设置不合法", details } }));
    expect(error.details).toEqual(details);
  });

  it("error 里没有 code → 用 http_状态码", () => {
    expect(parseErrorBody(500, JSON.stringify({ error: { message: "出错了" } })).code).toBe("http_500");
  });

  it("非 JSON（比如反向代理的 502 页面）→ 按状态码给一句人话", () => {
    const error = parseErrorBody(502, "<html><body>Bad Gateway</body></html>");
    expect(error.code).toBe("http_502");
    expect(error.message).toContain("502");
    expect(parseErrorBody(401, "").message).toBe("请先登录");
    expect(parseErrorBody(403, "nope").message).toContain("权限");
    expect(parseErrorBody(404, "").message).toContain("没有找到");
    expect(parseErrorBody(429, "").message).toContain("频繁");
    expect(parseErrorBody(418, "").message).toBe("请求失败（HTTP 418）");
  });

  it("JSON 但结构不对（没有 error.message）→ 也走兜底", () => {
    expect(parseErrorBody(500, JSON.stringify({ ok: false })).code).toBe("http_500");
    expect(parseErrorBody(400, JSON.stringify({ error: "字符串" })).code).toBe("http_400");
    expect(parseErrorBody(400, JSON.stringify({ error: { code: "x", message: "" } })).code).toBe("http_400");
  });
});

describe("ApiError", () => {
  it("isSessionLost 只认 401 + unauthorized：验证码 / 密钥填错的 401 不算掉线", () => {
    expect(new ApiError(401, "unauthorized", "请先登录").isSessionLost).toBe(true);
    expect(new ApiError(401, "totp_invalid", "验证码不对").isSessionLost).toBe(false);
    expect(new ApiError(401, "invalid_key", "访问密钥不对").isSessionLost).toBe(false);
    expect(new ApiError(403, "unauthorized", "x").isSessionLost).toBe(false);
  });

  it("fieldErrors 取出 details.fields，忽略非字符串的值；别的错误返回空对象", () => {
    expect(new ApiError(422, "invalid_settings", "x", { fields: { a: "太大", b: 1, c: "太小" } }).fieldErrors).toEqual({ a: "太大", c: "太小" });
    expect(new ApiError(422, "invalid_item", "x").fieldErrors).toEqual({});
    expect(new ApiError(422, "x", "x", { fields: "不是对象" }).fieldErrors).toEqual({});
    expect(new ApiError(422, "x", "x", null).fieldErrors).toEqual({});
  });
});

describe("networkError / errorMessage", () => {
  it("断网是 status 0 的 ApiError", () => {
    const error = networkError();
    expect(error.status).toBe(0);
    expect(error.code).toBe("network");
  });

  it("errorMessage：ApiError / Error / 字符串 / 其它", () => {
    expect(errorMessage(new ApiError(409, "exists", "这个番号已经在这份列表里了"))).toBe("这个番号已经在这份列表里了");
    expect(errorMessage(new Error("boom"))).toBe("boom");
    expect(errorMessage("文字")).toBe("文字");
    expect(errorMessage(undefined)).toBe("出了点意外，请重试");
    expect(errorMessage({})).toBe("出了点意外，请重试");
  });
});
