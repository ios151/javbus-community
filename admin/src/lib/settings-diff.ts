// 设置页的纯逻辑：哪些项改过、改的值合不合规、按分组排版。
// 表单照 shared 里的 SETTING_FIELDS 自动生成；取值范围以那里为准，服务端才是最终裁判（这里的预检只是少跑一趟）。

import { DEFAULT_SETTINGS, SETTING_FIELDS, type SettingField, type Settings } from "../../../shared/types";

// 下面三个上限在 SETTING_FIELDS 里没有，和 src/lib/settings.ts 保持一致
export const MAX_TEXT = 60;
export const MAX_LINES = 300;
export const MAX_LINES_CHARS = 8000;

/** 「每行一个」的文本规整：去空行、去首尾空白、去重（和服务端存进去的形式一致，比较时才不会误判成「改过」）。 */
export function normalizeLines(text: string): string {
  return [...new Set(text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean))].join("\n");
}

type Value = Settings[keyof Settings];

function sameValue(field: SettingField, a: Value, b: Value): boolean {
  switch (field.type) {
    case "bool":
      return a === b;
    case "int":
      return typeof a === "number" && typeof b === "number" && a === b; // NaN !== NaN：填了一半的数字算「改过」
    case "text":
      return String(a).trim() === String(b).trim();
    case "lines":
      return normalizeLines(String(a)) === normalizeLines(String(b));
  }
}

/** 这一项和基准值比，改过没有。 */
export function isChanged(field: SettingField, base: Settings, draft: Settings): boolean {
  return !sameValue(field, base[field.key], draft[field.key]);
}

/** 改过的项（只含改过的）。「保存」只发这个。 */
export function diffSettings(base: Settings, draft: Settings): Partial<Settings> {
  const patch: Partial<Settings> = {};
  for (const field of SETTING_FIELDS) {
    if (isChanged(field, base, draft)) Object.assign(patch, { [field.key]: draft[field.key] });
  }
  return patch;
}

/** 提交前的预检：不合规返回原因，合规返回 null。 */
export function checkSettingValue(field: SettingField, value: unknown): string | null {
  switch (field.type) {
    case "bool":
      return typeof value === "boolean" ? null : "应该是开或关";
    case "int": {
      const min = field.min ?? Number.MIN_SAFE_INTEGER;
      const max = field.max ?? Number.MAX_SAFE_INTEGER;
      if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
        return `应该是 ${min} 到 ${max} 之间的整数`;
      }
      return null;
    }
    case "text": {
      const text = typeof value === "string" ? value.trim() : "";
      return text && text.length <= MAX_TEXT ? null : `应该是 1 到 ${MAX_TEXT} 个字`;
    }
    case "lines": {
      if (typeof value !== "string" || value.length > MAX_LINES_CHARS) return "文本太长";
      const lines = normalizeLines(value).split("\n").filter(Boolean).length;
      return lines <= MAX_LINES ? null : `最多 ${MAX_LINES} 行`;
    }
  }
}

/** 默认值的展示文字。 */
export function formatDefault(field: SettingField): string {
  const value = DEFAULT_SETTINGS[field.key];
  if (field.type === "bool") return value ? "开" : "关";
  if (field.type === "lines") {
    const lines = normalizeLines(String(value)).split("\n").filter(Boolean);
    return lines.length === 0 ? "（空）" : `${lines.length} 行`;
  }
  return String(value);
}

export interface FieldGroup {
  group: string;
  fields: SettingField[];
}

/** 按 group 分节，节的顺序和字段在 SETTING_FIELDS 里第一次出现的顺序一致。 */
export function groupFields(fields: readonly SettingField[] = SETTING_FIELDS): FieldGroup[] {
  const groups: FieldGroup[] = [];
  for (const field of fields) {
    let group = groups.find((g) => g.group === field.group);
    if (!group) {
      group = { group: field.group, fields: [] };
      groups.push(group);
    }
    group.fields.push(field);
  }
  return groups;
}
