// 一些展示用的小函数：数字、短哈希、网址的域名、能不能当链接点开。

/** 1234567 → 1,234,567。 */
export function formatCount(n: number): string {
  return Number.isFinite(n) ? n.toLocaleString("zh-CN") : "—";
}

/** 哈希只显示前几位（完整的放在 title / 复制里）；空串表示「维护者建的 / 导入的」，没有提交者。 */
export function shortHash(hash: string, length = 8): string {
  return hash ? hash.slice(0, length) : "";
}

/** 网址 → 域名（小写，去掉 www.）。不是合法网址返回空串。 */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

/**
 * 只有 http(s) 地址才允许渲染成链接：条目地址服务端已经校验过，这里再兜一层，
 * 免得哪天库里混进 javascript: 之类的地址被点开。返回规范化后的地址，不合格返回 null。
 */
export function safeHttpUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.href : null;
  } catch {
    return null;
  }
}

/** 超过长度就截断并加省略号。 */
export function truncate(text: string, max: number): string {
  const chars = [...text];
  return chars.length <= max ? text : `${chars.slice(0, max).join("")}…`;
}

/** 百分比，保留整数；total 为 0 返回 0。 */
export function percent(part: number, total: number): number {
  return total > 0 ? Math.min(100, Math.round((part / total) * 100)) : 0;
}

/** 把 `a=1&b=2` 风格的查询对象清理掉空值（undefined / null / 空串 / false），数字和 true 转成字符串。 */
export type QueryValue = string | number | boolean | undefined | null;

export function cleanQuery(query: Record<string, QueryValue>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === false || value === "") continue;
    out[key] = value === true ? "1" : String(value);
  }
  return out;
}
