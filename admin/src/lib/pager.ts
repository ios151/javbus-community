// 分页的纯逻辑：总页数、页码按钮（带省略号）。

export function pageCount(total: number, pageSize: number): number {
  return Math.max(1, Math.ceil(total / Math.max(1, pageSize)));
}

/**
 * 页码按钮：永远显示首页、末页、当前页和它前后各一页，中间断开的地方放一个省略（"gap"）。
 * 只隔一页的缺口直接补上那个数字（比「1 … 3」自然）。
 */
export function pageRange(current: number, count: number): (number | "gap")[] {
  if (count <= 7) return Array.from({ length: count }, (_, i) => i + 1);
  const wanted = new Set<number>([1, count, current - 1, current, current + 1]);
  const pages = [...wanted].filter((p) => p >= 1 && p <= count).sort((a, b) => a - b);
  const out: (number | "gap")[] = [];
  let previous = 0;
  for (const page of pages) {
    if (page - previous === 2) out.push(previous + 1);
    else if (page - previous > 2) out.push("gap");
    out.push(page);
    previous = page;
  }
  return out;
}

/** 把页码限制在 [1, 总页数]。 */
export function clampPage(page: number, total: number, pageSize: number): number {
  return Math.min(Math.max(1, page), pageCount(total, pageSize));
}
