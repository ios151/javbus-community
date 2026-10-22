import { describe, expect, it } from "vitest";

import { DEFAULT_SETTINGS, SETTING_FIELDS, type Settings } from "../../shared/types";
import { checkSettingValue, diffSettings, formatDefault, groupFields, isChanged, normalizeLines } from "../src/lib/settings-diff";

const base: Settings = { ...DEFAULT_SETTINGS, blockedWords: "a\nb" };

function field(key: keyof Settings) {
  const found = SETTING_FIELDS.find((f) => f.key === key);
  if (!found) throw new Error(`没有设置项 ${key}`);
  return found;
}

describe("normalizeLines", () => {
  it("去空行、去首尾空白、去重，保持首次出现的顺序", () => {
    expect(normalizeLines(" a \n\n b\r\na\n")).toBe("a\nb");
    expect(normalizeLines("")).toBe("");
  });
});

describe("diffSettings：只含改过的项", () => {
  it("没改 = 空对象", () => {
    expect(diffSettings(base, { ...base })).toEqual({});
  });

  it("各类型的改动", () => {
    const draft: Settings = { ...base, siteName: "新名字", maintenance: true, maxItemsPerChannel: 5000, blockedWords: "a\nb\nc" };
    expect(diffSettings(base, draft)).toEqual({ siteName: "新名字", maintenance: true, maxItemsPerChannel: 5000, blockedWords: "a\nb\nc" });
  });

  it("文本 / 多行文本只差空白和空行不算改过（服务端存的是规整后的）", () => {
    expect(diffSettings(base, { ...base, siteName: `  ${base.siteName}  `, blockedWords: "a\n\n b \n" })).toEqual({});
    expect(diffSettings(base, { ...base, blockedWords: "b\na" })).toEqual({ blockedWords: "b\na" }); // 顺序变了算改过
  });

  it("填了一半的数字（NaN）算改过，保存前会被预检拦住", () => {
    const draft = { ...base, checkBatchSize: Number.NaN };
    expect(diffSettings(base, draft)).toHaveProperty("checkBatchSize");
    expect(checkSettingValue(field("checkBatchSize"), Number.NaN)).not.toBeNull();
  });

  it("isChanged 单项判断", () => {
    expect(isChanged(field("maintenance"), base, { ...base, maintenance: true })).toBe(true);
    expect(isChanged(field("maintenance"), base, base)).toBe(false);
  });
});

describe("checkSettingValue：提交前预检", () => {
  it("整数：范围、必须是整数", () => {
    const f = field("maxItemsPerChannel"); // 100–8000
    expect(checkSettingValue(f, 100)).toBeNull();
    expect(checkSettingValue(f, 8000)).toBeNull();
    expect(checkSettingValue(f, 99)).toBe("应该是 100 到 8000 之间的整数");
    expect(checkSettingValue(f, 8001)).not.toBeNull();
    expect(checkSettingValue(f, 1.5)).not.toBeNull();
    expect(checkSettingValue(f, "100")).not.toBeNull();
  });

  it("0 是合法值的项（0 = 不处理）", () => {
    expect(checkSettingValue(field("pendingExpireDays"), 0)).toBeNull();
    expect(checkSettingValue(field("reportAutoHide"), 0)).toBeNull();
  });

  it("文本：1–60 个字", () => {
    const f = field("siteName");
    expect(checkSettingValue(f, "站点")).toBeNull();
    expect(checkSettingValue(f, "   ")).not.toBeNull();
    expect(checkSettingValue(f, "x".repeat(61))).toBe("应该是 1 到 60 个字");
  });

  it("多行文本：行数和总长度上限", () => {
    const f = field("blockedWords");
    expect(checkSettingValue(f, "")).toBeNull();
    expect(checkSettingValue(f, Array.from({ length: 300 }, (_, i) => `w${i}`).join("\n"))).toBeNull();
    expect(checkSettingValue(f, Array.from({ length: 301 }, (_, i) => `w${i}`).join("\n"))).toBe("最多 300 行");
    expect(checkSettingValue(f, "x".repeat(8001))).toBe("文本太长");
  });

  it("开关：必须是布尔", () => {
    expect(checkSettingValue(field("maintenance"), true)).toBeNull();
    expect(checkSettingValue(field("maintenance"), "true")).not.toBeNull();
  });

  it("默认设置全部合规（预检和 SETTING_FIELDS 对得上）", () => {
    for (const f of SETTING_FIELDS) expect(checkSettingValue(f, DEFAULT_SETTINGS[f.key]), f.key).toBeNull();
  });
});

describe("展示用", () => {
  it("formatDefault：开关 → 开 / 关；多行 → 行数 / （空）；其它原样", () => {
    expect(formatDefault(field("autoApproveUser"))).toBe("开");
    expect(formatDefault(field("maintenance"))).toBe("关");
    expect(formatDefault(field("blockedWords"))).toBe("（空）");
    expect(formatDefault(field("checkBatchSize"))).toBe("10");
    expect(formatDefault(field("siteName"))).toBe("JavBus 社区推荐");
  });

  it("groupFields：按 group 分节，节序 = 第一次出现的顺序，所有字段都在", () => {
    const groups = groupFields();
    expect(groups.map((g) => g.group)).toEqual(["站点", "审核", "频率限制", "自动检查", "其它"]);
    expect(groups.flatMap((g) => g.fields)).toHaveLength(SETTING_FIELDS.length);
    expect(groups[0]?.fields[0]?.key).toBe("siteName");
  });
});
