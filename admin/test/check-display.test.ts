import { describe, expect, it } from "vitest";

import type { CheckStatus } from "../../shared/types";
import { checkName, isCheckNote, isUnverifiable } from "../src/lib/check-display";
import { EXPORT_LIMIT, exportCount, willBeTruncated } from "../src/lib/export-range";

const AGE_GATE = "链接 站点先跳到年龄验证页，看不到真实页面";

function item(checkStatus: CheckStatus, checkDetail = "") {
  return { checkStatus, checkDetail };
}

describe("检查结果怎么显示：没查过 / 没查成 / 正常（带说明）要分得开", () => {
  it("从没查过：unchecked 且没有说明 → 「没查过」，不是说明", () => {
    expect(checkName(item("unchecked"))).toBe("没查过");
    expect(isUnverifiable(item("unchecked"))).toBe(false);
    expect(isCheckNote(item("unchecked"))).toBe(false);
  });

  it("没查成：unchecked 但带说明（一项都没法判断）→ 「没查成」，说明是中性的告知", () => {
    expect(checkName(item("unchecked", AGE_GATE))).toBe("没查成");
    expect(isUnverifiable(item("unchecked", AGE_GATE))).toBe(true);
    expect(isCheckNote(item("unchecked", AGE_GATE))).toBe(true);
  });

  it("说明只有空白不算说明", () => {
    expect(checkName(item("unchecked", "   "))).toBe("没查过");
    expect(isCheckNote(item("ok", "  "))).toBe(false);
  });

  it("正常：没有说明不显示任何东西；带说明（年龄验证页）只是告知，徽章照旧是「正常」", () => {
    expect(checkName(item("ok"))).toBe("正常");
    expect(isCheckNote(item("ok"))).toBe(false);
    expect(checkName(item("ok", AGE_GATE))).toBe("正常");
    expect(isCheckNote(item("ok", AGE_GATE))).toBe(true);
    expect(isUnverifiable(item("ok", AGE_GATE))).toBe(false);
  });

  it("存疑 / 失效的说明是具体的问题，不当成中性说明", () => {
    expect(checkName(item("warn", "封面 超时"))).toBe("存疑");
    expect(checkName(item("dead", "链接 HTTP 404"))).toBe("失效");
    expect(isCheckNote(item("warn", "封面 超时"))).toBe(false);
    expect(isCheckNote(item("dead", "链接 HTTP 404"))).toBe(false);
  });
});

describe("导出页：按范围算条数、提前提醒会不会被截断", () => {
  const channels = {
    user: { pending: 5, approved: 4000, rejected: 10, hidden: 100 },
    author: { pending: 1, approved: 2500, rejected: 0, hidden: 4 },
  };

  it("不选 = 全部；选了频道 / 状态就只数那一部分", () => {
    expect(exportCount(channels)).toBe(5 + 4000 + 10 + 100 + 1 + 2500 + 0 + 4);
    expect(exportCount(channels, "user")).toBe(4115);
    expect(exportCount(channels, undefined, "approved")).toBe(6500);
    expect(exportCount(channels, "author", "approved")).toBe(2500);
    expect(exportCount(channels, "author", "rejected")).toBe(0);
  });

  it("超过单次上限 6000 才提醒（等于不提醒）", () => {
    expect(EXPORT_LIMIT).toBe(6000);
    expect(willBeTruncated(6000)).toBe(false);
    expect(willBeTruncated(6001)).toBe(true);
    expect(willBeTruncated(exportCount(channels, undefined, "approved"))).toBe(true);
    expect(willBeTruncated(exportCount(channels, "user"))).toBe(false);
  });
});
