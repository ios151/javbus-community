// hash 路由的纯逻辑：`#/items?check=dead&page=2` ⇄ { path, query }。
// 筛选条件都放在 hash 的查询串里，这样 `#/items?check=dead` 这种链接能直接发给别人 / 存书签。

import { cleanQuery, type QueryValue } from "./format";

export interface Route {
  /** 以 / 开头、不带结尾斜杠的路径，根是 `/`。 */
  path: string;
  query: Record<string, string>;
}

function safeDecode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text; // 手抄链接时 % 没写对：当原文用，别让整个页面崩
  }
}

/** `location.hash` → 路由。空 hash、`#`、`#/`、`#items`、`#/items/` 都能认。 */
export function parseHash(hash: string): Route {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  const questionMark = raw.indexOf("?");
  const pathPart = questionMark < 0 ? raw : raw.slice(0, questionMark);
  const queryPart = questionMark < 0 ? "" : raw.slice(questionMark + 1);

  let path = safeDecode(pathPart).trim();
  if (!path.startsWith("/")) path = `/${path}`;
  path = path.replace(/\/{2,}/g, "/");
  if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);

  // 同名参数以最后一个为准
  const query: Record<string, string> = {};
  for (const [key, value] of new URLSearchParams(queryPart)) query[key] = value;
  return { path, query };
}

/** 路由 → `#/items?check=dead`。空值（undefined / null / "" / false）不写进去，true 写成 1。 */
export function buildHash(path: string, query: Record<string, QueryValue> = {}): string {
  const clean = cleanQuery(query);
  const qs = new URLSearchParams(clean).toString();
  const normalized = path.startsWith("/") ? path : `/${path}`;
  return `#${normalized}${qs ? `?${qs}` : ""}`;
}

/** 在当前查询上合并改动（值为空 = 删掉这个参数）。筛选条件变了通常要回到第一页，由调用方一并传 page: undefined。 */
export function mergeQuery(
  current: Record<string, string>,
  patch: Record<string, QueryValue>,
): Record<string, string> {
  const merged: Record<string, QueryValue> = { ...current, ...patch };
  return cleanQuery(merged);
}
