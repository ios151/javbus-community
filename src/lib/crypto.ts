// 哈希、随机令牌、常数时间比较。全部用 Web Crypto。
//
// 访问密钥 / 会话 / 邀请都是 256 位随机数，存的是 SHA-256：高熵令牌不需要慢哈希，
// 而且免费版 Worker 每次请求只有 10 毫秒 CPU，PBKDF2 这类慢哈希根本放不进去——这就是后台不用密码的原因。

import { bytesToBase64Url, bytesToHex, randomBytes } from "./util";

const encoder = new TextEncoder();

export async function sha256Hex(text: string): Promise<string> {
  return bytesToHex(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(text))));
}

/** 带前缀的随机令牌：`jck_` 访问密钥、`jca_` App 口令、`jci_` 邀请、`jcs_` 会话。前缀只是给人认的，方便在日志 / 聊天记录里认出来。 */
export function randomToken(prefix: string, bytes = 32): string {
  return `${prefix}_${bytesToBase64Url(randomBytes(bytes))}`;
}

/** 两个等长十六进制串的常数时间比较（不等长直接 false）。 */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** 给「设备号 / IP」加盐哈希，截成 length 位十六进制：够查重和限频，还原不出原文。 */
export async function hashId(salt: string, value: string, length = 16): Promise<string> {
  return (await sha256Hex(`${salt}:${value}`)).slice(0, length);
}
