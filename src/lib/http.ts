// 请求相关的小工具：限长读请求体、客户端标识、统一的 JSON 响应。

import type { Context } from "hono";

import { HttpError } from "./util";

const decoder = new TextDecoder();

/**
 * 读请求体，超过上限立刻放弃。流式读：对方不管声明多大、分块发多少，都不会把整个包吞进内存
 * （Worker 的内存只有 128 MB）。
 */
export async function readBodyText(
  source: { headers: Headers; body: ReadableStream<Uint8Array> | null },
  maxBytes: number,
): Promise<string> {
  const declared = Number(source.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw new HttpError(413, "too_large", "请求体太大");
  if (!source.body) return "";
  const reader = source.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new HttpError(413, "too_large", "请求体太大");
    }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    all.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return decoder.decode(all);
}

export async function readJson(request: Request, maxBytes: number): Promise<unknown> {
  const text = await readBodyText(request, maxBytes);
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, "bad_json", "请求体不是合法的 JSON");
  }
}

/** 请求体必须是 JSON 对象（不是数组 / 字符串 / null）。 */
export function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "bad_body", "请求体应该是一个 JSON 对象");
  }
  return Object.fromEntries(Object.entries(value));
}

export function intParam(value: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number(value);
  return value !== undefined && value !== "" && Number.isInteger(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

export function pageParams(c: Context, maxSize = 100): { page: number; pageSize: number } {
  return { page: intParam(c.req.query("page"), 1, 1, 100_000), pageSize: intParam(c.req.query("pageSize"), 50, 1, maxSize) };
}

/** 路径里的数字 id。 */
export function idParam(c: Context, name = "id"): number {
  const n = Number(c.req.param(name));
  if (!Number.isInteger(n) || n < 1) throw new HttpError(400, "bad_id", "id 不对");
  return n;
}

/** 请求体里的一批 id：正整数数组，去重，1 到 max 个。 */
export function idList(value: unknown, max = 100): number[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > max || !value.every((v) => Number.isInteger(v) && v > 0)) {
    throw new HttpError(422, "invalid_ids", `ids 应该是 1 到 ${max} 个正整数`);
  }
  return [...new Set<number>(value)];
}

/** IPv6 文本展开成 8 组数字；写坏了返回 null。支持 ::、zone id（fe80::1%eth0）和结尾的点分 IPv4（::ffff:1.2.3.4）。 */
function parseIpv6(text: string): number[] | null {
  let body = (text.split("%")[0] ?? "").toLowerCase();
  const dotted = /^(.*:)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(body);
  if (dotted) {
    const octets = dotted.slice(2).map(Number);
    if (octets.some((n) => n > 255)) return null;
    body = `${dotted[1] ?? ""}${(((octets[0] ?? 0) << 8) | (octets[1] ?? 0)).toString(16)}:${(((octets[2] ?? 0) << 8) | (octets[3] ?? 0)).toString(16)}`;
  }
  const halves = body.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  let groups = head;
  if (halves.length === 2) {
    const tail = halves[1] ? halves[1].split(":") : [];
    const gap = 8 - head.length - tail.length; // :: 至少代表一组
    if (gap < 1) return null;
    groups = [...head, ...Array<string>(gap).fill("0"), ...tail];
  }
  if (groups.length !== 8) return null;
  const numbers = groups.map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : Number.NaN));
  return numbers.some(Number.isNaN) ? null : numbers;
}

/**
 * 限频和封禁用的「IP」：IPv6 按 /64 归并。家庭 / 机构拿到的是整段 /64，里面的后 64 位想换多少个就换多少个，
 * 按完整地址算的话限频和封禁都形同虚设。IPv4 映射的 IPv6（::ffff:a.b.c.d）按它里面的 IPv4 算；不是地址（unknown）或写坏了的原样返回。
 */
export function normalizeIp(raw: string): string {
  if (!raw.includes(":")) return raw;
  const groups = parseIpv6(raw);
  if (!groups) return raw;
  const at = (i: number): number => groups[i] ?? 0;
  if ([0, 1, 2, 3, 4].every((i) => at(i) === 0) && at(5) === 0xffff) {
    return `${at(6) >> 8}.${at(6) & 255}.${at(7) >> 8}.${at(7) & 255}`;
  }
  return `${[0, 1, 2, 3].map((i) => at(i).toString(16)).join(":")}::/64`;
}

/** 客户端 IP（已按 normalizeIp 归并）。只信 Cloudflare 边缘写的 CF-Connecting-IP（客户端伪造不了）；本地开发没有就是 unknown。 */
export function clientIp(c: Context): string {
  return normalizeIp(c.req.header("CF-Connecting-IP")?.trim() || "unknown");
}

const DEVICE_ID = /^[A-Za-z0-9_-]{8,64}$/;

/** App 带来的设备号（脚本里随机生成存本地的）。不合格式的当没带。 */
export function deviceIdOf(c: Context): string {
  const value = c.req.header("X-Device-Id")?.trim() ?? "";
  return DEVICE_ID.test(value) ? value : "";
}

/** 响应发出去以后再做的事（写访问时间之类）。拿不到 executionCtx（单元测试直接 app.request）就让它自己跑，出错只打日志。 */
export function defer(c: Context, work: Promise<unknown>): void {
  const guarded = work.catch((error: unknown) => {
    console.error(JSON.stringify({ event: "deferred_failed", message: String(error) }));
  });
  try {
    c.executionCtx.waitUntil(guarded);
  } catch {
    void guarded;
  }
}
