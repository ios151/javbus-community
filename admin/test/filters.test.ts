import { describe, expect, it } from "vitest";

import { ITEMS_DEFAULTS, hasActiveFilters, itemsApiQuery, itemsFilterToQuery, parseItemsFilter, type FilterDefaults } from "../src/lib/filters";
import { clampPage, pageCount, pageRange } from "../src/lib/pager";

describe("parseItemsFilter：URL 查询串 → 筛选条件", () => {
  it("什么都没写 = 默认值", () => {
    expect(parseItemsFilter({})).toEqual({ channel: undefined, status: undefined, check: undefined, reported: false, q: "", sort: "new", page: 1, pageSize: 50 });
  });

  it("概览页的链接 #/items?check=dead", () => {
    const filter = parseItemsFilter({ check: "dead" });
    expect(filter.check).toBe("dead");
    expect(hasActiveFilters(filter)).toBe(true);
  });

  it("各个条件都能认", () => {
    const filter = parseItemsFilter({ channel: "author", status: "hidden", check: "warn", reported: "1", q: " ABC-1 ", sort: "reports", page: "3", pageSize: "20" });
    expect(filter).toEqual({ channel: "author", status: "hidden", check: "warn", reported: true, q: "ABC-1", sort: "reports", page: 3, pageSize: 20 });
  });

  it("不认识的值当没写：手改链接也不会把页面搞坏", () => {
    const filter = parseItemsFilter({ channel: "x", status: "foo", check: "bar", sort: "random", page: "-3", pageSize: "abc", reported: "yes" });
    expect(filter).toMatchObject({ channel: undefined, status: undefined, check: undefined, reported: false, sort: "new", page: 1, pageSize: 50 });
    expect(parseItemsFilter({ page: "0" }).page).toBe(1);
    expect(parseItemsFilter({ page: "2.5" }).page).toBe(1);
  });

  it("每页条数不能超过接口上限 100；搜索词最长 60 个字", () => {
    expect(parseItemsFilter({ pageSize: "500" }).pageSize).toBe(100);
    expect(parseItemsFilter({ q: "x".repeat(100) }).q).toHaveLength(60);
  });

  it("不同页面有不同的默认排序（审核队列先进先出）", () => {
    const review: FilterDefaults = { sort: "old", pageSize: 50 };
    expect(parseItemsFilter({}, review).sort).toBe("old");
    expect(parseItemsFilter({ sort: "new" }, review).sort).toBe("new");
  });
});

describe("itemsFilterToQuery / itemsApiQuery", () => {
  it("和默认值一样的不写进 URL；改过的写", () => {
    expect(itemsFilterToQuery(parseItemsFilter({}))).toEqual({});
    expect(itemsFilterToQuery(parseItemsFilter({ status: "approved", sort: "old", page: "2", pageSize: "20", q: "a", reported: "1" }))).toEqual({
      status: "approved",
      sort: "old",
      page: "2",
      pageSize: "20",
      q: "a",
      reported: "1",
    });
  });

  it("URL 往返：parse(toQuery(f)) 还原 f", () => {
    const filter = parseItemsFilter({ channel: "user", check: "dead", reported: "1", q: "三上", sort: "checked", page: "4", pageSize: "100" });
    expect(parseItemsFilter(itemsFilterToQuery(filter))).toEqual(filter);
    const review: FilterDefaults = { sort: "old", pageSize: 50 };
    const f2 = parseItemsFilter({ sort: "new" }, review);
    expect(parseItemsFilter(itemsFilterToQuery(f2, review), review)).toEqual(f2);
  });

  it("接口参数：排序和分页总是带上，筛选只带设置过的", () => {
    expect(itemsApiQuery(parseItemsFilter({ check: "dead", page: "2" }))).toEqual({ sort: "new", page: 2, pageSize: 50, check: "dead" });
    expect(itemsApiQuery(parseItemsFilter({ reported: "1", q: "x", channel: "user", status: "pending" }))).toEqual({
      sort: ITEMS_DEFAULTS.sort,
      page: 1,
      pageSize: 50,
      reported: "1",
      q: "x",
      channel: "user",
      status: "pending",
    });
  });

  it("hasActiveFilters 不把排序和分页算进去", () => {
    expect(hasActiveFilters(parseItemsFilter({ sort: "old", page: "3", pageSize: "20" }))).toBe(false);
    expect(hasActiveFilters(parseItemsFilter({ q: "a" }))).toBe(true);
  });
});

describe("分页", () => {
  it("pageCount：至少 1 页", () => {
    expect(pageCount(0, 50)).toBe(1);
    expect(pageCount(50, 50)).toBe(1);
    expect(pageCount(51, 50)).toBe(2);
    expect(pageCount(1000, 100)).toBe(10);
  });

  it("clampPage", () => {
    expect(clampPage(0, 100, 50)).toBe(1);
    expect(clampPage(9, 100, 50)).toBe(2);
    expect(clampPage(2, 100, 50)).toBe(2);
  });

  it("页数少时全部列出", () => {
    expect(pageRange(1, 1)).toEqual([1]);
    expect(pageRange(3, 7)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it("页数多时：首页 / 末页 / 当前页前后各一页，断开处用 gap", () => {
    expect(pageRange(1, 20)).toEqual([1, 2, "gap", 20]);
    expect(pageRange(10, 20)).toEqual([1, "gap", 9, 10, 11, "gap", 20]);
    expect(pageRange(20, 20)).toEqual([1, "gap", 19, 20]);
  });

  it("只隔一页的缺口直接补上数字，不用省略号", () => {
    expect(pageRange(4, 20)).toEqual([1, 2, 3, 4, 5, "gap", 20]);
    expect(pageRange(17, 20)).toEqual([1, "gap", 16, 17, 18, 19, 20]);
  });
});
