// 输入校验：条目、地址、举报。纯函数，不碰数据库。
//
// 两种宽严：
// - 严格（App 提交 / 维护者手填）：字段不合格就拒；
// - 宽松（导入旧数据）：info 太长就截断，其余不合格的跳过并说明原因。

import { CHANNELS, REPORT_REASONS, type Channel, type ReportReason } from "../../shared/types";

export const LIMITS = { code: 40, info: 160, url: 300, note: 300, detail: 300 } as const;

/** 番号：字母数字开头，后面可以有 . _ -（FC2-PPV-1234567、010120_001、HEYZO-1234 都过）。 */
const CODE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;

// 控制字符，和各种「看不见」的字符：零宽字符、方向控制符、软连字符、词连接符、韩文填充符、异体选择符……（Unicode 的
// Default_Ignorable_Code_Point 一整类），外加行 / 段分隔符。有人拿它们伪装文字、绕过屏蔽词，也有人用它们造出显示成空白的标题。
const INVISIBLE = /[\p{Cc}\p{Default_Ignorable_Code_Point}\p{Zl}\p{Zp}]/gu;

export function cleanText(value: unknown): string {
  return typeof value === "string" ? value.replace(INVISIBLE, "").trim() : "";
}

/** 比屏蔽词前先把文字「折」一下：NFKC（全角 → 半角、带圈 → 普通写法）、去掉看不见的字符、转小写——「ｓｐａｍ」「sp\u00ADam」都该和「spam」一样被拦。 */
export function foldForMatch(text: string): string {
  return text.normalize("NFKC").replace(INVISIBLE, "").toLowerCase();
}

export function isValidCode(code: string): boolean {
  return CODE_RE.test(code);
}

/** 「每行一个」的文本 → 小写词表。域名额外去掉开头的 `*.` / `.`。 */
export function parseWordList(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim().toLowerCase())
    .filter(Boolean);
}

export function parseHostList(text: string): string[] {
  return parseWordList(text).map((host) => host.replace(/^(\*\.|\.)+/, ""));
}

const PRIVATE_SUFFIXES = [".local", ".localhost", ".internal", ".lan", ".intranet", ".home.arpa"];
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

/** 只接受公网网站的域名：IP 字面量、localhost、内网后缀、单段主机名都不要（不让它们进到定时检查里被 Worker 去访问）。 */
function isPublicHostname(rawHost: string): boolean {
  const host = rawHost.replace(/\.$/, "");
  if (!host.includes(".")) return false;
  if (host.includes(":") || IPV4.test(host)) return false;
  return !PRIVATE_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

/** 地址不合格就返回原因，合格返回 null。 */
export function checkUrl(value: string, allowedHosts: readonly string[] = []): string | null {
  if (value.length > LIMITS.url) return "地址太长";
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "不是合法的地址";
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return "只支持 http(s) 地址";
  if (url.username || url.password) return "地址里不能带账号密码";
  const host = url.hostname.toLowerCase();
  if (!isPublicHostname(host)) return "不是公网网站的地址";
  if (allowedHosts.length > 0 && !allowedHosts.some((h) => host === h || host.endsWith(`.${h}`))) {
    return "这个网站不在允许名单里";
  }
  return null;
}

export interface ItemFields {
  code: string;
  info: string;
  src: string;
  link: string;
}

export interface ValidateOptions {
  allowedHosts?: readonly string[];
  blockedWords?: readonly string[];
  /** 宽松模式：info 太长截断，不查屏蔽词和允许名单（导入旧数据用）。 */
  lenient?: boolean;
}

export type ItemCheck = { ok: true; item: ItemFields } | { ok: false; reason: string };

export function validateItem(raw: unknown, options: ValidateOptions = {}): ItemCheck {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, reason: "不是对象" };
  const o = Object.fromEntries(Object.entries(raw));
  const lenient = options.lenient === true;

  const code = cleanText(o.code);
  if (!isValidCode(code)) return { ok: false, reason: "番号格式不对" };

  let info = cleanText(o.info) || code;
  if (info.length > LIMITS.info) {
    if (!lenient) return { ok: false, reason: `info 超过 ${LIMITS.info} 个字` };
    info = info.slice(0, LIMITS.info);
  }

  const hosts = lenient ? [] : (options.allowedHosts ?? []);
  const src = cleanText(o.src);
  if (src) {
    const problem = checkUrl(src, hosts);
    if (problem) return { ok: false, reason: `封面地址：${problem}` };
  }
  const link = cleanText(o.link);
  if (!link) return { ok: false, reason: "缺少详情页地址" };
  const linkProblem = checkUrl(link, hosts);
  if (linkProblem) return { ok: false, reason: `详情页地址：${linkProblem}` };

  if (!lenient && options.blockedWords?.length) {
    const folded = foldForMatch(info);
    if (options.blockedWords.some((word) => folded.includes(foldForMatch(word)))) return { ok: false, reason: "含有屏蔽词" };
  }
  return { ok: true, item: { code, info, src, link } };
}

export interface ReportInput {
  channel: Channel;
  code: string;
  reason: ReportReason;
  detail: string;
}

export function validateReport(raw: unknown): ReportInput | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = Object.fromEntries(Object.entries(raw));
  const channel = CHANNELS.find((c) => c === o.channel);
  const code = cleanText(o.code);
  if (!channel || !isValidCode(code)) return null;
  const reason = REPORT_REASONS.find((r) => r === o.reason) ?? "other";
  return { channel, code, reason, detail: cleanText(o.detail).slice(0, LIMITS.detail) };
}
