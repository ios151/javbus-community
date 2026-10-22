// TOTP（RFC 6238，SHA-1、6 位、30 秒一档）：Google Authenticator / 1Password / Authy 这些都认。
// 给想要二次验证的维护者用，可选。

import { randomBytes } from "./util";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const STEP_SECONDS = 30;
const DIGITS = 6;

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Uint8Array {
  const clean = text.toUpperCase().replace(/[\s=-]/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const index = ALPHABET.indexOf(ch);
    if (index < 0) throw new Error("不是合法的 base32");
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Uint8Array.from(out);
}

/** 新的密钥：20 字节随机数（RFC 4226 建议的长度），base32 文本。 */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

async function hotp(secret: Uint8Array, counter: number): Promise<string> {
  const message = new ArrayBuffer(8);
  const view = new DataView(message);
  view.setUint32(0, Math.floor(counter / 0x1_0000_0000));
  view.setUint32(4, counter >>> 0);
  const key = await crypto.subtle.importKey("raw", secret, { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const hmac = new Uint8Array(await crypto.subtle.sign("HMAC", key, message));
  const offset = (hmac[hmac.length - 1] ?? 0) & 15;
  const binary =
    (((hmac[offset] ?? 0) & 0x7f) << 24) |
    ((hmac[offset + 1] ?? 0) << 16) |
    ((hmac[offset + 2] ?? 0) << 8) |
    (hmac[offset + 3] ?? 0);
  return String(binary % 10 ** DIGITS).padStart(DIGITS, "0");
}

/** 某个时刻的验证码。 */
export async function totpCode(secretBase32: string, timeMs: number): Promise<string> {
  return hotp(base32Decode(secretBase32), Math.floor(timeMs / 1000 / STEP_SECONDS));
}

/** 验证：容许前后各一档（手机和服务器的时钟差几秒很常见）。 */
export async function verifyTotp(secretBase32: string, code: string, timeMs: number): Promise<boolean> {
  const clean = code.replace(/\s/g, "");
  if (!/^\d{6}$/.test(clean)) return false;
  const secret = base32Decode(secretBase32);
  const counter = Math.floor(timeMs / 1000 / STEP_SECONDS);
  for (const drift of [0, -1, 1]) {
    if ((await hotp(secret, counter + drift)) === clean) return true;
  }
  return false;
}

/** 给验证器 App 扫的二维码里的地址（后台把它画成二维码，也直接显示密钥让人手输）。 */
export function otpauthUri(account: string, secretBase32: string, issuer: string): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  return `otpauth://totp/${label}?secret=${secretBase32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${DIGITS}&period=${STEP_SECONDS}`;
}
