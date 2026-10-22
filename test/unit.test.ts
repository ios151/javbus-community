import { describe, expect, it } from "vitest";

import { DEFAULT_SETTINGS, SETTING_FIELDS, allPermissions, can } from "../shared/types";
import { classify, isAgeGateUrl, judge } from "../src/lib/checks";
import { hashId, randomToken, sha256Hex, timingSafeEqual } from "../src/lib/crypto";
import { normalizeIp } from "../src/lib/http";
import { normalizeLines, parseSettingsPatch } from "../src/lib/settings";
import { base32Decode, base32Encode, generateTotpSecret, otpauthUri, totpCode, verifyTotp } from "../src/lib/totp";
import { HttpError, chunk, utcDay } from "../src/lib/util";
import { checkUrl, cleanText, isValidCode, parseHostList, parseWordList, validateItem, validateReport } from "../src/lib/validate";

describe("TOTP（RFC 6238 官方测试向量，SHA-1，取 8 位码的后 6 位）", () => {
  // 密钥是 ASCII 的 "12345678901234567890"
  const secret = base32Encode(new TextEncoder().encode("12345678901234567890"));
  const vectors: [number, string][] = [
    [59, "287082"],
    [1_111_111_109, "081804"],
    [1_111_111_111, "050471"],
    [1_234_567_890, "005924"],
    [2_000_000_000, "279037"],
    [20_000_000_000, "353130"],
  ];

  it("base32 编码", () => {
    expect(secret).toBe("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
  });

  it.each(vectors)("时刻 %i 的验证码是 %s", async (seconds, expected) => {
    expect(await totpCode(secret, seconds * 1000)).toBe(expected);
  });

  it("base32 往返；非法字符报错；容许空格 / 小写 / 连字符", () => {
    const bytes = new Uint8Array([0, 1, 2, 253, 254, 255, 7, 8, 9]);
    expect(base32Decode(base32Encode(bytes))).toEqual(bytes);
    expect(() => base32Decode("AB1C")).toThrow();
    expect(base32Decode("gezd gnbv-gy3t qojq gezd gnbv gy3t qojq")).toEqual(new TextEncoder().encode("12345678901234567890"));
  });

  it("验证：前后各容许一档，再远就不行；格式不对直接 false", async () => {
    const at = 1_234_567_890_000;
    const code = await totpCode(secret, at);
    expect(await verifyTotp(secret, code, at)).toBe(true);
    expect(await verifyTotp(secret, code, at + 30_000)).toBe(true);
    expect(await verifyTotp(secret, code, at - 30_000)).toBe(true);
    expect(await verifyTotp(secret, code, at + 90_000)).toBe(false);
    expect(await verifyTotp(secret, "12345", at)).toBe(false);
    expect(await verifyTotp(secret, "abcdef", at)).toBe(false);
    expect(await verifyTotp(secret, ` ${code.slice(0, 3)} ${code.slice(3)} `, at)).toBe(true);
  });

  it("新密钥是 32 位 base32；otpauth 地址带齐参数", () => {
    const fresh = generateTotpSecret();
    expect(fresh).toMatch(/^[A-Z2-7]{32}$/);
    const uri = otpauthUri("小明", fresh, "JavBus 社区推荐");
    expect(uri).toContain(`secret=${fresh}`);
    expect(uri).toContain("digits=6");
    expect(uri).toContain("period=30");
    expect(uri.startsWith("otpauth://totp/")).toBe(true);
  });
});

describe("加密小工具", () => {
  it("SHA-256 已知值", async () => {
    expect(await sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("令牌带前缀、够长、不重复", () => {
    const a = randomToken("jck");
    const b = randomToken("jck");
    expect(a).toMatch(/^jck_[A-Za-z0-9_-]{43}$/);
    expect(a).not.toBe(b);
  });

  it("常数时间比较：只有完全相等才为真", () => {
    expect(timingSafeEqual("abcd", "abcd")).toBe(true);
    expect(timingSafeEqual("abcd", "abce")).toBe(false);
    expect(timingSafeEqual("abcd", "abc")).toBe(false);
  });

  it("设备 / IP 哈希：同盐同值稳定，换盐或换值就变，长度可控", async () => {
    const a = await hashId("salt", "device-1");
    expect(a).toHaveLength(16);
    expect(a).toBe(await hashId("salt", "device-1"));
    expect(a).not.toBe(await hashId("salt2", "device-1"));
    expect(a).not.toBe(await hashId("salt", "device-2"));
    expect(await hashId("salt", "x", 8)).toHaveLength(8);
  });
});

describe("客户端 IP 归并", () => {
  it("IPv4 和不是地址的原样返回", () => {
    expect(normalizeIp("203.0.113.7")).toBe("203.0.113.7");
    expect(normalizeIp("unknown")).toBe("unknown");
    expect(normalizeIp("")).toBe("");
    expect(normalizeIp("999.1.1.1")).toBe("999.1.1.1"); // 不按 IPv4 校验，原样
  });

  it("IPv6 按 /64 归并：同一段里不管怎么写、怎么换后 64 位，都是同一个桶；换一段就是另一个桶", () => {
    const bucket = normalizeIp("2001:db8:abcd:12::1");
    expect(bucket).toBe("2001:db8:abcd:12::/64");
    for (const same of ["2001:DB8:ABCD:0012::ffff", "2001:db8:abcd:12:1:2:3:4", "2001:0db8:abcd:0012:0000:0000:0000:0001", "2001:db8:abcd:12::"]) {
      expect(normalizeIp(same), same).toBe(bucket);
    }
    for (const other of ["2001:db8:abcd:13::1", "2001:db8:abce:12::1", "2001:db9:abcd:12::1"]) {
      expect(normalizeIp(other), other).not.toBe(bucket);
    }
  });

  it("IPv6 的各种缩写：:: 在开头 / 中间 / 结尾，带 zone id", () => {
    expect(normalizeIp("::1")).toBe("0:0:0:0::/64");
    expect(normalizeIp("fe80::1%eth0")).toBe("fe80:0:0:0::/64");
    expect(normalizeIp("1:2:3:4:5:6:7:8")).toBe("1:2:3:4::/64");
    expect(normalizeIp("1::")).toBe("1:0:0:0::/64");
  });

  it("IPv4 映射的 IPv6（::ffff:a.b.c.d / ::ffff:0102:0304）按它里面的 IPv4 算", () => {
    expect(normalizeIp("::ffff:1.2.3.4")).toBe("1.2.3.4");
    expect(normalizeIp("::ffff:0102:0304")).toBe("1.2.3.4");
  });

  it("写坏了的 IPv6 原样返回（不抛错）", () => {
    for (const bad of ["1::2::3", "gggg::1", "1:2:3:4:5:6:7", "1:2:3:4:5:6:7:8:9", ":::"]) expect(normalizeIp(bad), bad).toBe(bad);
  });
});

describe("util", () => {
  it("chunk 分段", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([], 3)).toEqual([]);
  });

  it("utcDay 按 UTC 日期", () => {
    expect(utcDay(Date.UTC(2026, 9, 22, 23, 59))).toBe("2026-10-22");
    expect(utcDay(Date.UTC(2026, 9, 23, 0, 0))).toBe("2026-10-23");
  });

  it("HttpError 带状态码、错误码和附加信息", () => {
    const error = new HttpError(422, "invalid", "不合法", { fields: { a: "x" } });
    expect(error.status).toBe(422);
    expect(error.code).toBe("invalid");
    expect(error.details).toEqual({ fields: { a: "x" } });
  });
});

describe("番号与地址校验", () => {
  it.each(["ABC-123", "FC2-PPV-1234567", "010120_001", "HEYZO-1234", "n1234", "a.b_c-d"])("合法番号 %s", (code) => {
    expect(isValidCode(code)).toBe(true);
  });

  it.each(["", "-ABC", "A B", "ABC/123", "ABC?x=1", "a".repeat(41), "番号-1"])("非法番号 %j", (code) => {
    expect(isValidCode(code)).toBe(false);
  });

  it("合法地址", () => {
    expect(checkUrl("https://www.javbus.com/ABC-123")).toBeNull();
    expect(checkUrl("http://example.com/a?b=1#c")).toBeNull();
  });

  it.each([
    ["http://localhost/x", "不是公网网站的地址"],
    ["https://192.168.1.1/", "不是公网网站的地址"],
    ["https://[::1]/", "不是公网网站的地址"],
    ["http://2130706433/", "不是公网网站的地址"], // 十进制写法的 127.0.0.1，URL 解析器会规整成点分形式
    ["https://intranet/", "不是公网网站的地址"],
    ["https://printer.local/", "不是公网网站的地址"],
    ["https://user:pw@example.com/", "地址里不能带账号密码"],
    ["ftp://example.com/", "只支持 http(s) 地址"],
    ["javascript:alert(1)", "只支持 http(s) 地址"],
    ["不是地址", "不是合法的地址"],
    [`https://example.com/${"a".repeat(300)}`, "地址太长"],
  ])("拒绝 %s", (url, reason) => {
    expect(checkUrl(url)).toBe(reason);
  });

  it("允许名单按域名后缀匹配（子域名可以，名字相近的不行）", () => {
    const hosts = ["javbus.com"];
    expect(checkUrl("https://javbus.com/x", hosts)).toBeNull();
    expect(checkUrl("https://www.javbus.com/x", hosts)).toBeNull();
    expect(checkUrl("https://notjavbus.com/x", hosts)).toBe("这个网站不在允许名单里");
    expect(checkUrl("https://evil.com/?javbus.com", hosts)).toBe("这个网站不在允许名单里");
  });

  it("词表 / 域名表解析", () => {
    expect(parseWordList(" Foo \n\nBAR\r\nbaz ")).toEqual(["foo", "bar", "baz"]);
    expect(parseHostList("*.JavBus.com\n.example.com\nplain.org")).toEqual(["javbus.com", "example.com", "plain.org"]);
    expect(normalizeLines("a\n\n b \na\r\nc")).toBe("a\nb\nc");
  });
});

describe("validateItem", () => {
  const base = { code: "ABC-123", info: "ABC-123 | 2026-10-22", src: "https://a.example.com/c.jpg", link: "https://a.example.com/ABC-123" };

  it("合格的原样通过，首尾空白去掉", () => {
    expect(validateItem({ ...base, code: "  ABC-123 " })).toEqual({ ok: true, item: base });
  });

  it("info 缺了就用番号；src 可以为空", () => {
    expect(validateItem({ ...base, info: undefined, src: "" })).toEqual({ ok: true, item: { ...base, info: "ABC-123", src: "" } });
  });

  it("控制字符和方向控制符被清掉", () => {
    const dirty = ["标", String.fromCharCode(0), "题", String.fromCharCode(0x202e), "反", String.fromCharCode(0x200b), "向"].join("");
    const result = validateItem({ ...base, info: dirty });
    expect(result).toMatchObject({ ok: true, item: { info: "标题反向" } });
  });

  it.each([
    [null, "不是对象"],
    [[], "不是对象"],
    ["x", "不是对象"],
    [{ ...base, code: "bad code" }, "番号格式不对"],
    [{ ...base, link: "" }, "缺少详情页地址"],
    [{ ...base, link: "http://localhost/a" }, "详情页地址：不是公网网站的地址"],
    [{ ...base, src: "ftp://x.com/a" }, "封面地址：只支持 http(s) 地址"],
    [{ ...base, info: "x".repeat(161) }, "info 超过 160 个字"],
  ])("拒绝 %j", (input, reason) => {
    expect(validateItem(input)).toEqual({ ok: false, reason });
  });

  it("看不见的字符整类清掉（软连字符、词连接符、韩文填充符、行分隔符……），不只是零宽空格和方向控制符", () => {
    const at = (code: number) => String.fromCharCode(code);
    const dirty = `a${at(0xad)}b${at(0x2060)}c${at(0x3164)}d${at(0x2028)}e${at(0x85)}f${at(0xfe0f)}g`;
    expect(cleanText(dirty)).toBe("abcdefg");
    expect(cleanText(`  ${at(0x3164)}${at(0x3164)}  `)).toBe(""); // 看起来是空白的标题清完就是空的
  });

  it("屏蔽词不分大小写，也拦全角字母和夹了看不见字符的写法（先 NFKC、去隐形字符、转小写再比）", () => {
    const at = (code: number) => String.fromCharCode(code);
    const blocked = { blockedWords: ["spam"] };
    for (const info of ["ＳＰＡＭ here", "sp" + at(0xad) + "am", "s" + at(0x200b) + "p" + at(0x2060) + "am", "SpAm", "ｓｐａｍ"]) {
      expect(validateItem({ ...base, info }, blocked), JSON.stringify(info)).toEqual({ ok: false, reason: "含有屏蔽词" });
    }
    // 屏蔽词本身写成全角、带隐形字符也一样
    expect(validateItem({ ...base, info: "spam" }, { blockedWords: ["ｓｐａｍ"] }).ok).toBe(false);
    expect(validateItem({ ...base, info: "fine" }, blocked).ok).toBe(true);
  });

  it("屏蔽词不分大小写", () => {
    expect(validateItem({ ...base, info: "Hello SPAM here" }, { blockedWords: ["spam"] })).toEqual({ ok: false, reason: "含有屏蔽词" });
    expect(validateItem({ ...base, info: "fine" }, { blockedWords: ["spam"] }).ok).toBe(true);
  });

  it("宽松模式：info 截断，不查屏蔽词和允许名单", () => {
    const result = validateItem({ ...base, info: "x".repeat(200) }, { lenient: true, blockedWords: ["x"], allowedHosts: ["other.com"] });
    expect(result).toMatchObject({ ok: true });
    if (result.ok) expect(result.item.info).toHaveLength(160);
  });
});

describe("validateReport / cleanText", () => {
  it("合法举报；原因不认识就当 other；详情截断", () => {
    expect(validateReport({ channel: "user", code: "ABC-123", reason: "dead", detail: " 打不开 " })).toEqual({
      channel: "user",
      code: "ABC-123",
      reason: "dead",
      detail: "打不开",
    });
    expect(validateReport({ channel: "user", code: "ABC-123", reason: "???" })?.reason).toBe("other");
    expect(validateReport({ channel: "user", code: "ABC-123", detail: "x".repeat(500) })?.detail).toHaveLength(300);
  });

  it("不合格返回 null", () => {
    expect(validateReport(null)).toBeNull();
    expect(validateReport({ channel: "nope", code: "ABC-123" })).toBeNull();
    expect(validateReport({ channel: "user", code: "bad code" })).toBeNull();
  });

  it("cleanText 对非字符串返回空串", () => {
    expect(cleanText(42)).toBe("");
    expect(cleanText(undefined)).toBe("");
  });
});

describe("设置校验", () => {
  it("可以只改几项；文本规整", () => {
    expect(parseSettingsPatch({ maintenance: true, submitPerHourDevice: 10, blockedWords: " a \n\nb\na " })).toEqual({
      maintenance: true,
      submitPerHourDevice: 10,
      blockedWords: "a\nb",
    });
  });

  it("不合法的一次性全报出来", () => {
    try {
      parseSettingsPatch({ maintenance: "yes", submitPerHourDevice: 0, nope: 1, siteName: "" });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(HttpError);
      const { status, code, details } = error as HttpError;
      expect(status).toBe(422);
      expect(code).toBe("invalid_settings");
      expect(Object.keys((details as { fields: Record<string, string> }).fields).sort()).toEqual(["maintenance", "nope", "siteName", "submitPerHourDevice"]);
    }
  });

  it("整数必须是整数且在范围内", () => {
    expect(() => parseSettingsPatch({ maxItemsPerChannel: 99 })).toThrow(HttpError);
    expect(() => parseSettingsPatch({ maxItemsPerChannel: 8001 })).toThrow(HttpError);
    expect(() => parseSettingsPatch({ maxItemsPerChannel: 100.5 })).toThrow(HttpError);
    expect(parseSettingsPatch({ maxItemsPerChannel: 100 })).toEqual({ maxItemsPerChannel: 100 });
  });

  it("请求体不是对象就拒绝", () => {
    expect(() => parseSettingsPatch([])).toThrow(HttpError);
    expect(() => parseSettingsPatch(null)).toThrow(HttpError);
  });

  it("每个设置项都有默认值，且默认值自己能通过校验", () => {
    for (const field of SETTING_FIELDS) expect(DEFAULT_SETTINGS).toHaveProperty(field.key);
    expect(() => parseSettingsPatch({ ...DEFAULT_SETTINGS })).not.toThrow();
  });
});

describe("权限矩阵", () => {
  it("协管只能审核 / 处理举报 / 手动检查 / 看日志", () => {
    expect(allPermissions("moderator").sort()).toEqual(["audit.read", "checks.run", "items.moderate", "reports.resolve"]);
  });

  it("管理员 = 协管 + 设置 / 封禁 / 导入导出 / 全部检查 / 邀请协管 / 看账号", () => {
    for (const p of ["settings.write", "bans.manage", "transfer", "checks.runAll", "users.inviteModerator", "users.read"] as const) {
      expect(can("admin", p)).toBe(true);
      expect(can("moderator", p)).toBe(false);
    }
    expect(can("admin", "users.manage")).toBe(false);
  });

  it("站长什么都能做", () => {
    expect(allPermissions("owner")).toHaveLength(allPermissions("admin").length + 1);
    expect(can("owner", "users.manage")).toBe(true);
  });
});

describe("检查判定", () => {
  const headers = (type?: string) => new Headers(type ? { "content-type": type } : {});

  it("404 / 410 = 确认没了；2xx = 正常；其余 = 说不准", () => {
    expect(classify({ status: 404, headers: headers() }, "page")).toEqual({ state: "gone", detail: "HTTP 404" });
    expect(classify({ status: 410, headers: headers() }, "image")).toEqual({ state: "gone", detail: "HTTP 410" });
    expect(classify({ status: 200, headers: headers("text/html") }, "page")).toEqual({ state: "ok", detail: "" });
    expect(classify({ status: 206, headers: headers("image/jpeg") }, "image")).toEqual({ state: "ok", detail: "" });
    expect(classify({ status: 403, headers: headers() }, "page")).toEqual({ state: "unknown", detail: "HTTP 403" });
    expect(classify({ status: 503, headers: headers() }, "image")).toEqual({ state: "unknown", detail: "HTTP 503" });
  });

  it("详情页被年龄验证页挡住 = 没法检查（skipped）：不是正常也不是失效；只对详情页，封面不适用；站点出故障（5xx）仍是存疑", () => {
    const gate = "https://www.javbus.com/doc/driver-verify?referer=https%3A%2F%2Fwww.javbus.com%2FMIDA-459";
    expect(classify({ status: 200, headers: headers("text/html"), url: gate }, "page")).toEqual({ state: "skipped", detail: "站点先跳到年龄验证页，看不到真实页面" });
    expect(classify({ status: 503, headers: headers(), url: gate }, "page")).toEqual({ state: "unknown", detail: "HTTP 503" });
    expect(classify({ status: 200, headers: headers("text/html"), url: "https://www.javbus.com/MIDA-459" }, "page").state).toBe("ok");
    expect(classify({ status: 200, headers: headers("text/html"), url: gate }, "image").state).toBe("unknown");
    expect(isAgeGateUrl(gate)).toBe(true);
    expect(isAgeGateUrl("https://www.javbus.org/doc/driver-verify")).toBe(true);
    expect(isAgeGateUrl("https://www.javbus.com/doc/other")).toBe(false);
    expect(isAgeGateUrl("not a url")).toBe(false);
    // 跳到了别的域名上的同名路径：不是这个站自己的验证页
    expect(isAgeGateUrl(gate, "https://www.javbus.com/MIDA-459")).toBe(true);
    expect(isAgeGateUrl(gate, "https://other.example.com/MIDA-459")).toBe(false);
    expect(classify({ status: 200, headers: headers("text/html"), url: gate }, "page", "https://other.example.com/x").state).toBe("ok");
    expect(isAgeGateUrl(undefined)).toBe(false);
  });

  it("封面返回了网页（防盗链页之类）= 说不准，不是失效", () => {
    expect(classify({ status: 200, headers: headers("text/html; charset=utf-8") }, "image")).toEqual({ state: "unknown", detail: "不是图片（text/html）" });
    expect(classify({ status: 200, headers: headers() }, "image")).toEqual({ state: "unknown", detail: "不是图片（没有类型）" });
  });

  it("有一项 gone → dead；没有 gone 有 unknown → warn；都正常 → ok", () => {
    const ok = { state: "ok", detail: "" } as const;
    const gone = { state: "gone", detail: "HTTP 404" } as const;
    const unknown = { state: "unknown", detail: "超时" } as const;
    expect(judge([{ name: "封面", verdict: ok }, { name: "链接", verdict: gone }])).toEqual({ status: "dead", detail: "链接 HTTP 404" });
    expect(judge([{ name: "封面", verdict: gone }, { name: "链接", verdict: unknown }])).toEqual({ status: "dead", detail: "封面 HTTP 404" });
    expect(judge([{ name: "封面", verdict: unknown }, { name: "链接", verdict: ok }])).toEqual({ status: "warn", detail: "封面 超时" });
    expect(judge([{ name: "封面", verdict: ok }, { name: "链接", verdict: ok }])).toEqual({ status: "ok", detail: "" });
    // 没有任何可检查的地址：没查成，不能当「正常」
    expect(judge([])).toEqual({ status: "unchecked", detail: "没有可检查的地址（封面是空的，或者封面 / 链接的检查都关了）" });
  });

  it("没法检查（skipped）的不参与判定：另一项正常 → 正常；另一项失效 / 存疑 → 照那一项；一项都没法判断 → 没查成（unchecked）并写明原因", () => {
    const ok = { state: "ok", detail: "" } as const;
    const gone = { state: "gone", detail: "HTTP 404" } as const;
    const unknown = { state: "unknown", detail: "HTTP 403" } as const;
    const skipped = { state: "skipped", detail: "站点先跳到年龄验证页，看不到真实页面" } as const;
    expect(judge([{ name: "封面", verdict: ok }, { name: "链接", verdict: skipped }])).toEqual({ status: "ok", detail: "" });
    expect(judge([{ name: "封面", verdict: gone }, { name: "链接", verdict: skipped }])).toEqual({ status: "dead", detail: "封面 HTTP 404" });
    expect(judge([{ name: "封面", verdict: unknown }, { name: "链接", verdict: skipped }])).toEqual({ status: "warn", detail: "封面 HTTP 403" });
    expect(judge([{ name: "链接", verdict: skipped }])).toEqual({ status: "unchecked", detail: "链接 站点先跳到年龄验证页，看不到真实页面" });
  });
});
