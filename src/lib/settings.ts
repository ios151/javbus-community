// 站点设置：D1 里一项一行（key → JSON），读出来叠在默认值上；取值范围以 shared/types.ts 的 SETTING_FIELDS 为准。
// 同一张表里还存着一个 `_salt`：给设备号 / IP 做哈希用的盐，第一次需要时随机生成，之后不变。

import { DEFAULT_SETTINGS, SETTING_FIELDS, type SettingField, type Settings } from "../../shared/types";
import { HttpError, bytesToHex, randomBytes } from "./util";

export interface Config {
  settings: Settings;
  salt: string;
}

type Coerced = { ok: true; value: string | number | boolean } | { ok: false; reason: string };

const MAX_TEXT = 60;
const MAX_LINES = 300;
const MAX_LINES_CHARS = 8000;

/** 「每行一个」的文本规整：去空行、去首尾空白、去重。 */
export function normalizeLines(text: string): string {
  return [...new Set(text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean))].join("\n");
}

function coerce(field: SettingField, raw: unknown): Coerced {
  switch (field.type) {
    case "bool":
      return typeof raw === "boolean" ? { ok: true, value: raw } : { ok: false, reason: "应该是 true / false" };
    case "int": {
      const min = field.min ?? Number.MIN_SAFE_INTEGER;
      const max = field.max ?? Number.MAX_SAFE_INTEGER;
      if (typeof raw !== "number" || !Number.isInteger(raw) || raw < min || raw > max) {
        return { ok: false, reason: `应该是 ${min} 到 ${max} 之间的整数` };
      }
      return { ok: true, value: raw };
    }
    case "text": {
      const text = typeof raw === "string" ? raw.trim() : "";
      if (!text || text.length > MAX_TEXT) return { ok: false, reason: `应该是 1 到 ${MAX_TEXT} 个字` };
      return { ok: true, value: text };
    }
    case "lines": {
      if (typeof raw !== "string" || raw.length > MAX_LINES_CHARS) return { ok: false, reason: "文本太长" };
      const text = normalizeLines(raw);
      if (text.split("\n").filter(Boolean).length > MAX_LINES) return { ok: false, reason: `最多 ${MAX_LINES} 行` };
      return { ok: true, value: text };
    }
  }
}

async function ensureSalt(db: D1Database, now: number): Promise<string> {
  await db
    .prepare("INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES ('_salt', ?, ?)")
    .bind(JSON.stringify(bytesToHex(randomBytes(16))), now)
    .run();
  const row = await db.prepare("SELECT value FROM settings WHERE key = '_salt'").first<{ value: string }>();
  return typeof row?.value === "string" ? String(JSON.parse(row.value)) : "";
}

export async function loadConfig(db: D1Database, now: number = Date.now()): Promise<Config> {
  const { results } = await db.prepare("SELECT key, value FROM settings").all<{ key: string; value: string }>();
  const stored = new Map(results.map((row) => [row.key, row.value]));
  const settings: Settings = { ...DEFAULT_SETTINGS };
  for (const field of SETTING_FIELDS) {
    const text = stored.get(field.key);
    if (text === undefined) continue;
    try {
      const parsed = coerce(field, JSON.parse(text));
      if (parsed.ok) Object.assign(settings, { [field.key]: parsed.value });
    } catch {
      // 库里的值坏了（手动改过表）：当没设过，用默认值
    }
  }
  const saltText = stored.get("_salt");
  const salt = saltText ? String(JSON.parse(saltText)) : await ensureSalt(db, now);
  return { settings, salt };
}

/** 校验管理员提交的设置（可以只带要改的几项）。不合法的一次性全部报出来。 */
export function parseSettingsPatch(input: unknown): Partial<Settings> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new HttpError(400, "bad_body", "请求体应该是一个 JSON 对象");
  }
  const fields = new Map<string, SettingField>(SETTING_FIELDS.map((f) => [f.key, f]));
  const patch: Partial<Settings> = {};
  const problems: Record<string, string> = {};
  for (const [key, raw] of Object.entries(input)) {
    const field = fields.get(key);
    if (!field) {
      problems[key] = "没有这个设置项";
      continue;
    }
    const parsed = coerce(field, raw);
    if (parsed.ok) Object.assign(patch, { [key]: parsed.value });
    else problems[key] = parsed.reason;
  }
  if (Object.keys(problems).length > 0) {
    const names = Object.keys(problems).join("、");
    throw new HttpError(422, "invalid_settings", `这些设置不合法：${names}`, { fields: problems });
  }
  return patch;
}

export interface SaveResult {
  settings: Settings;
  /** 真正变了的项：key → [旧值, 新值]（审计日志用）。 */
  changes: Record<string, [unknown, unknown]>;
}

export async function saveSettings(db: D1Database, patch: Partial<Settings>, now: number): Promise<SaveResult> {
  const { settings: before } = await loadConfig(db, now);
  const after: Settings = { ...before, ...patch };
  const changes: Record<string, [unknown, unknown]> = {};
  const statements: D1PreparedStatement[] = [];
  for (const field of SETTING_FIELDS) {
    const oldValue = before[field.key];
    const newValue = after[field.key];
    if (oldValue === newValue) continue;
    changes[field.key] = [oldValue, newValue];
    statements.push(
      db
        .prepare(
          "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        )
        .bind(field.key, JSON.stringify(newValue), now),
    );
  }
  if (statements.length > 0) await db.batch(statements);
  return { settings: after, changes };
}
