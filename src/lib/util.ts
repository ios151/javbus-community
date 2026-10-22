// 一些小工具：时间、字节 ↔ 文本、统一的 HTTP 错误。

export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

export const now = (): number => Date.now();

export function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value));
}

export function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

export function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function randomBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length));
}

/** 把数组切成不超过 size 的几段（D1 一条语句最多绑 100 个参数，批量写要分段）。 */
export function chunk<T>(list: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/** 毫秒时间戳 → UTC 日期 `2026-10-22`。 */
export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * 业务上的错误：路由里 throw 它，app.onError 统一翻成 `{ error: { code, message } }`。
 * message 是给维护者看的中文，code 是给前端判断的英文标识。
 */
export class HttpError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 413 | 422 | 429 | 500 | 502 | 503,
    readonly code: string,
    message: string,
    /** 额外信息（比如哪几个设置项不合法），原样放进响应的 error.details。 */
    readonly details?: unknown,
  ) {
    super(message);
  }
}
