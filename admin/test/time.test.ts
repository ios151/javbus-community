import { describe, expect, it } from "vitest";

import { formatDateTime, formatDuration, formatRelative, shortDay } from "../src/lib/time";

// 2026-10-22 10:30:45 UTC = 北京时间 18:30:45
const T = Date.UTC(2026, 9, 22, 10, 30, 45);

describe("formatDateTime：本地时区的绝对时间", () => {
  it("按指定时区显示（UTC / 北京）", () => {
    expect(formatDateTime(T, { timeZone: "UTC" })).toBe("2026-10-22 10:30");
    expect(formatDateTime(T, { timeZone: "Asia/Shanghai" })).toBe("2026-10-22 18:30");
  });

  it("可以带秒", () => {
    expect(formatDateTime(T, { timeZone: "UTC", seconds: true })).toBe("2026-10-22 10:30:45");
  });

  it("午夜显示 00 而不是 24", () => {
    expect(formatDateTime(Date.UTC(2026, 0, 1, 0, 5), { timeZone: "UTC" })).toBe("2026-01-01 00:05");
  });

  it("空值 / 非法值显示破折号，不抛错", () => {
    expect(formatDateTime(null)).toBe("—");
    expect(formatDateTime(undefined)).toBe("—");
    expect(formatDateTime(Number.NaN)).toBe("—");
  });
});

describe("formatRelative：「3 小时前」", () => {
  const now = T;
  const SEC = 1000;
  const MIN = 60 * SEC;
  const HOUR = 60 * MIN;
  const DAY = 24 * HOUR;

  it("过去", () => {
    expect(formatRelative(now - 3 * SEC, now)).toBe("刚刚");
    expect(formatRelative(now - 45 * SEC, now)).toBe("45 秒前");
    expect(formatRelative(now - 5 * MIN, now)).toBe("5 分钟前");
    expect(formatRelative(now - 3 * HOUR - 20 * MIN, now)).toBe("3 小时前");
    expect(formatRelative(now - 5 * DAY, now)).toBe("5 天前");
    expect(formatRelative(now - 65 * DAY, now)).toBe("2 个月前");
    expect(formatRelative(now - 800 * DAY, now)).toBe("2 年前");
  });

  it("将来（邀请的有效期）", () => {
    expect(formatRelative(now + 2 * HOUR, now)).toBe("2 小时后");
    expect(formatRelative(now + 6 * DAY + HOUR, now)).toBe("6 天后");
    expect(formatRelative(now + 2 * SEC, now)).toBe("刚刚");
  });

  it("边界：59 分 → 分钟，60 分 → 1 小时；23 小时 → 小时，24 小时 → 1 天；29 天 → 天，30 天 → 1 个月", () => {
    expect(formatRelative(now - 59 * MIN, now)).toBe("59 分钟前");
    expect(formatRelative(now - 60 * MIN, now)).toBe("1 小时前");
    expect(formatRelative(now - 23 * HOUR, now)).toBe("23 小时前");
    expect(formatRelative(now - 24 * HOUR, now)).toBe("1 天前");
    expect(formatRelative(now - 29 * DAY, now)).toBe("29 天前");
    expect(formatRelative(now - 30 * DAY, now)).toBe("1 个月前");
    expect(formatRelative(now - 364 * DAY, now)).toBe("12 个月前");
    expect(formatRelative(now - 365 * DAY, now)).toBe("1 年前");
  });

  it("空值显示破折号", () => {
    expect(formatRelative(null, now)).toBe("—");
    expect(formatRelative(Number.NaN, now)).toBe("—");
  });
});

describe("formatDuration / shortDay", () => {
  it("时长", () => {
    expect(formatDuration(12_000)).toBe("12 秒");
    expect(formatDuration(60_000)).toBe("1 分");
    expect(formatDuration(65_400)).toBe("1 分 5 秒");
    expect(formatDuration(-1)).toBe("—");
  });

  it("柱状图横轴的日期标签", () => {
    expect(shortDay("2026-10-22")).toBe("10-22");
    expect(shortDay("乱写的")).toBe("乱写的");
  });
});
