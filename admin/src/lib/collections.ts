// 数组 / 集合的小工具。

/** 把数组切成不超过 size 个一段（接口有单次条数上限：检查 25、状态变更 100、导入 500）。 */
export function chunk<T>(list: readonly T[], size: number): T[][] {
  const step = Math.max(1, Math.floor(size));
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += step) out.push(list.slice(i, i + step));
  return out;
}

/** 切换一个 id 在集合里的有无，返回新集合（不改原集合，方便放进 state）。 */
export function toggled<T>(set: ReadonlySet<T>, value: T, on: boolean): Set<T> {
  const next = new Set(set);
  if (on) next.add(value);
  else next.delete(value);
  return next;
}
