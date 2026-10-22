// 二次验证输入框的小工具：验证码规整、密钥分组显示。

/** 去掉空格 / 横杠（人从验证器里抄 6 位码时常带空格：「123 456」）。 */
export function normalizeTotpCode(input: string): string {
  return input.replace(/[\s-]/g, "");
}

export function isTotpCode(input: string): boolean {
  return /^\d{6}$/.test(normalizeTotpCode(input));
}

/** `ABCDEFGHIJKLMNOP` → `ABCD EFGH IJKL MNOP`（手输密钥时好对照）。 */
export function groupSecret(secret: string): string {
  return secret.replace(/(.{4})(?=.)/g, "$1 ");
}
