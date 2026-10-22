import { describe, expect, it } from "vitest";

import { buildHash, mergeQuery, parseHash } from "../src/lib/route";

describe("parseHash：hash → 路由", () => {
  it("带查询参数", () => {
    expect(parseHash("#/items?check=dead&page=2")).toEqual({ path: "/items", query: { check: "dead", page: "2" } });
  });

  it("空 hash、#、#/ 都是根", () => {
    expect(parseHash("")).toEqual({ path: "/", query: {} });
    expect(parseHash("#")).toEqual({ path: "/", query: {} });
    expect(parseHash("#/")).toEqual({ path: "/", query: {} });
  });

  it("没写开头的斜杠、有结尾斜杠、多余斜杠都能认", () => {
    expect(parseHash("#items").path).toBe("/items");
    expect(parseHash("#/items/").path).toBe("/items");
    expect(parseHash("#//items").path).toBe("/items");
  });

  it("百分号编码的中文和特殊字符能还原", () => {
    expect(parseHash(`#/items?q=${encodeURIComponent("三上 悠亚&1")}`).query.q).toBe("三上 悠亚&1");
  });

  it("邀请链接：#/join?token=…", () => {
    expect(parseHash("#/join?token=jci_AbC-123_x")).toEqual({ path: "/join", query: { token: "jci_AbC-123_x" } });
  });

  it("同名参数以最后一个为准；没有值的参数是空串", () => {
    expect(parseHash("#/x?a=1&a=2").query.a).toBe("2");
    expect(parseHash("#/x?flag").query.flag).toBe("");
  });

  it("手抄坏了的百分号编码不会抛错", () => {
    expect(() => parseHash("#/it%ems?q=%E0%A4%A")).not.toThrow();
  });
});

describe("buildHash：路由 → hash", () => {
  it("拼查询串，空值（undefined / null / 空串 / false）不写", () => {
    expect(buildHash("/items", { check: "dead", q: "", page: undefined, reported: false })).toBe("#/items?check=dead");
    expect(buildHash("/items", { reported: true, page: 3 })).toBe("#/items?reported=1&page=3");
    expect(buildHash("/")).toBe("#/");
  });

  it("路径缺开头斜杠会补上", () => {
    expect(buildHash("bans", { kind: "device" })).toBe("#/bans?kind=device");
  });

  it("build 再 parse 能还原（含中文和 &）", () => {
    const query = { q: "三上 & 悠亚", status: "approved" };
    expect(parseHash(buildHash("/items", query))).toEqual({ path: "/items", query });
  });
});

describe("mergeQuery：在当前查询上合并改动", () => {
  it("覆盖、新增、用空值删除", () => {
    expect(mergeQuery({ status: "approved", page: "3" }, { status: "hidden", q: "ABC", page: undefined })).toEqual({ status: "hidden", q: "ABC" });
    expect(mergeQuery({}, { reported: true })).toEqual({ reported: "1" });
    expect(mergeQuery({ a: "1" }, { a: "" })).toEqual({});
  });
});
