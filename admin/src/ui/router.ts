// hash 路由的运行时部分：监听 hashchange、跳转、改查询参数（筛选条件同步到 URL）。纯解析逻辑在 lib/route.ts。

import type { QueryValue } from "../lib/format";
import { buildHash, mergeQuery, parseHash, type Route } from "../lib/route";
import { createStore, useStore } from "./store";

const routeStore = createStore<Route>(parseHash(typeof location === "undefined" ? "" : location.hash));

if (typeof window !== "undefined") {
  window.addEventListener("hashchange", () => routeStore.set(parseHash(location.hash)));
}

export function useRoute(): Route {
  return useStore(routeStore);
}

export function currentRoute(): Route {
  return routeStore.get();
}

/** 生成可以放进 <a href> 的地址：`linkTo("/items", { check: "dead" })` → `#/items?check=dead`。 */
export function linkTo(path: string, query: Record<string, QueryValue> = {}): string {
  return buildHash(path, query);
}

export interface NavigateOptions {
  /** 替换当前历史记录而不是新增一条（筛选条件变化用，免得后退键要按很多次）。 */
  replace?: boolean;
}

export function navigate(path: string, query: Record<string, QueryValue> = {}, options: NavigateOptions = {}): void {
  const hash = buildHash(path, query);
  if (options.replace) {
    // replaceState 不会触发 hashchange，手动通知
    history.replaceState(null, "", hash);
    routeStore.set(parseHash(hash));
  } else if (location.hash !== hash) {
    location.hash = hash; // 会触发 hashchange
  }
}

/** 在当前页面上合并改动查询参数（值为空 = 删除这个参数）。筛选条件一变，调用方一般要顺手 page: undefined 回到第一页。 */
export function setQuery(patch: Record<string, QueryValue>, options: NavigateOptions = { replace: true }): void {
  const route = routeStore.get();
  navigate(route.path, mergeQuery(route.query, patch), options);
}
