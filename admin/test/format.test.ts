import { describe, expect, it } from "vitest";

import { cleanQuery, formatCount, hostOf, percent, safeHttpUrl, shortHash, truncate } from "../src/lib/format";

describe("hostOf：详情页地址 → 域名", () => {
  it("取域名并小写、去掉 www.", () => {
    expect(hostOf("https://www.JavBus.com/ABC-123")).toBe("javbus.com");
    expect(hostOf("http://img.example.org:8080/a.jpg")).toBe("img.example.org");
  });

  it("不是合法网址返回空串", () => {
    expect(hostOf("")).toBe("");
    expect(hostOf("乱写的")).toBe("");
  });
});

describe("safeHttpUrl：只有 http(s) 才能做成链接", () => {
  it("http / https 返回规范化后的地址", () => {
    expect(safeHttpUrl("https://example.com/a b")).toBe("https://example.com/a%20b");
    expect(safeHttpUrl("http://example.com")).toBe("http://example.com/");
  });

  it("javascript: / data: / ftp: / 乱写的一律 null", () => {
    expect(safeHttpUrl("javascript:alert(1)")).toBeNull();
    expect(safeHttpUrl("data:text/html,<script>1</script>")).toBeNull();
    expect(safeHttpUrl("ftp://example.com/a")).toBeNull();
    expect(safeHttpUrl("//example.com/a")).toBeNull();
    expect(safeHttpUrl("")).toBeNull();
  });
});

describe("小工具", () => {
  it("shortHash：只显示前几位，空串表示没有提交者", () => {
    expect(shortHash("3fa9c2d41b7e08a5")).toBe("3fa9c2d4");
    expect(shortHash("3fa9c2d41b7e08a5", 4)).toBe("3fa9");
    expect(shortHash("")).toBe("");
  });

  it("truncate：按字符（不是字节）截断，中文不会被劈开", () => {
    expect(truncate("你好世界", 10)).toBe("你好世界");
    expect(truncate("你好世界你好世界", 4)).toBe("你好世界…");
    expect(truncate("😀😀😀😀", 2)).toBe("😀😀…");
  });

  it("percent：整数百分比，total 为 0 不除零，不超过 100", () => {
    expect(percent(1, 3)).toBe(33);
    expect(percent(0, 0)).toBe(0);
    expect(percent(7, 5)).toBe(100);
  });

  it("formatCount：千分位；非数字显示破折号", () => {
    expect(formatCount(1234567)).toBe("1,234,567");
    expect(formatCount(Number.NaN)).toBe("—");
  });

  it("cleanQuery：去掉空值，true → 1，数字转字符串", () => {
    expect(cleanQuery({ a: "x", b: "", c: undefined, d: null, e: false, f: true, g: 3, h: 0 })).toEqual({ a: "x", f: "1", g: "3", h: "0" });
  });
});
