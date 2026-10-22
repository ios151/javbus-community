// 条目列表的筛选条件：URL 查询串 ⇄ 结构化的筛选对象 ⇄ 接口参数。
// 不认识的值（`?status=foo`、`?page=-3`）一律当没写，保证手改链接也不会把页面搞坏。

import { CHANNELS, CHECK_STATUSES, ITEM_STATUSES, type Channel, type CheckStatus, type ItemStatus } from "../../../shared/types";

export type ItemSort = "new" | "old" | "updated" | "checked" | "reports";
export const ITEM_SORTS: readonly ItemSort[] = ["new", "old", "updated", "checked", "reports"];
export const ITEM_SORT_NAMES: Record<ItemSort, string> = {
  new: "最新添加",
  old: "最早添加",
  updated: "最近更新",
  checked: "最久没检查",
  reports: "举报最多",
};

export const PAGE_SIZES: readonly number[] = [20, 50, 100];
export const MAX_PAGE_SIZE = 100;

export interface ItemsFilter {
  channel?: Channel;
  status?: ItemStatus;
  check?: CheckStatus;
  reported: boolean;
  q: string;
  sort: ItemSort;
  page: number;
  pageSize: number;
}

/** 不同页面的默认值不一样（条目管理按最新排；审核队列先进先出，按最早排）。 */
export interface FilterDefaults {
  sort: ItemSort;
  pageSize: number;
}

export const ITEMS_DEFAULTS: FilterDefaults = { sort: "new", pageSize: 50 };

function pickOne<T extends string>(list: readonly T[], value: string | undefined): T | undefined {
  return list.find((item) => item === value);
}

function positiveInt(value: string | undefined, fallback: number, max = 100_000): number {
  if (value === undefined || !/^\d+$/.test(value)) return fallback;
  const n = Number(value);
  return n >= 1 ? Math.min(n, max) : fallback;
}

export function parseItemsFilter(query: Record<string, string>, defaults: FilterDefaults = ITEMS_DEFAULTS): ItemsFilter {
  return {
    channel: pickOne(CHANNELS, query.channel),
    status: pickOne(ITEM_STATUSES, query.status),
    check: pickOne(CHECK_STATUSES, query.check),
    reported: query.reported === "1",
    q: (query.q ?? "").trim().slice(0, 60),
    sort: pickOne(ITEM_SORTS, query.sort) ?? defaults.sort,
    page: positiveInt(query.page, 1),
    pageSize: positiveInt(query.pageSize, defaults.pageSize, MAX_PAGE_SIZE),
  };
}

/** 筛选对象 → URL 查询串（和默认值一样的不写，链接更短）。 */
export function itemsFilterToQuery(filter: ItemsFilter, defaults: FilterDefaults = ITEMS_DEFAULTS): Record<string, string> {
  const query: Record<string, string> = {};
  if (filter.channel) query.channel = filter.channel;
  if (filter.status) query.status = filter.status;
  if (filter.check) query.check = filter.check;
  if (filter.reported) query.reported = "1";
  if (filter.q) query.q = filter.q;
  if (filter.sort !== defaults.sort) query.sort = filter.sort;
  if (filter.page > 1) query.page = String(filter.page);
  if (filter.pageSize !== defaults.pageSize) query.pageSize = String(filter.pageSize);
  return query;
}

/** 筛选对象 → GET /items 的参数（该带的都带上，不依赖服务端默认值）。 */
export function itemsApiQuery(filter: ItemsFilter): Record<string, string | number> {
  const query: Record<string, string | number> = { sort: filter.sort, page: filter.page, pageSize: filter.pageSize };
  if (filter.channel) query.channel = filter.channel;
  if (filter.status) query.status = filter.status;
  if (filter.check) query.check = filter.check;
  if (filter.reported) query.reported = "1";
  if (filter.q) query.q = filter.q;
  return query;
}

/** 有没有设置过筛选（决定要不要显示「清除筛选」）。排序、分页不算。 */
export function hasActiveFilters(filter: ItemsFilter): boolean {
  return Boolean(filter.channel || filter.status || filter.check || filter.reported || filter.q);
}
