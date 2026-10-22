// 时间显示：本地时区的绝对时间（Intl.DateTimeFormat("zh-CN")）+ 相对时间（「3 小时前」）。
// 绝对时间用 formatToParts 自己拼，不依赖不同环境下 ICU 的分隔符写法，输出稳定、测试好写。

export interface DateTimeOptions {
  /** 带上秒（操作日志用）。 */
  seconds?: boolean;
  /** 指定时区；不传 = 浏览器本地时区。测试里传固定值。 */
  timeZone?: string;
}

const MISSING = "—";

/** `2026-10-22 18:30`（本地时区）。 */
export function formatDateTime(ms: number | null | undefined, options: DateTimeOptions = {}): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return MISSING;
  const parts = new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: options.seconds ? "2-digit" : undefined,
    hourCycle: "h23",
    timeZone: options.timeZone,
  }).formatToParts(new Date(ms));
  const pick = (type: Intl.DateTimeFormatPartTypes): string => parts.find((p) => p.type === type)?.value ?? "";
  const time = `${pick("hour")}:${pick("minute")}${options.seconds ? `:${pick("second")}` : ""}`;
  return `${pick("year")}-${pick("month")}-${pick("day")} ${time}`;
}

/**
 * 相对时间：「刚刚 / 3 分钟前 / 2 小时后 / 5 天前 / 3 个月前 / 2 年前」。
 * `now` 由调用方传入（不在函数里取），这样同一屏的时间基准一致，测试也不用造假时钟。
 */
export function formatRelative(ms: number | null | undefined, now: number): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return MISSING;
  const diff = now - ms;
  const abs = Math.abs(diff);
  const suffix = diff >= 0 ? "前" : "后";
  const seconds = Math.floor(abs / 1000);
  if (seconds < 10) return "刚刚";
  if (seconds < 60) return `${seconds} 秒${suffix}`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟${suffix}`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时${suffix}`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天${suffix}`;
  if (days < 365) return `${Math.floor(days / 30)} 个月${suffix}`;
  return `${Math.floor(days / 365)} 年${suffix}`;
}

/** 毫秒数 → 「12 秒」「1 分 5 秒」。 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return MISSING;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest === 0 ? `${minutes} 分` : `${minutes} 分 ${rest} 秒`;
}

/** `2026-10-22` → `10-22`（柱状图的横轴标签）。不是这个格式就原样返回。 */
export function shortDay(day: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day.slice(5) : day;
}
