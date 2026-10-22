// 封禁页的纯逻辑：从 URL 预填表单（条目的「封禁提交者」跳过来）、提交前预检填的值对不对。

export type BanKind = "device" | "ip" | "code";
export const BAN_KINDS: readonly BanKind[] = ["device", "ip", "code"];

/** 条目里看到的设备 / IP 哈希是 16 位十六进制。 */
const HASH = /^[0-9a-f]{16}$/i;
/** 番号：字母数字开头，后面可以有 . _ -（和服务端的规则一致）。 */
const CODE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;

/** 值不合格返回原因，合格返回 null。服务端才是最终裁判，这里只是少跑一趟。 */
export function validateBanValue(kind: BanKind, value: string): string | null {
  const text = value.trim();
  if (!text) return kind === "code" ? "请填要封禁的番号" : "请填条目里看到的 16 位哈希";
  if (kind === "code") return CODE.test(text) ? null : "番号格式不对（字母数字开头，可以带 . _ -）";
  return HASH.test(text) ? null : "设备 / IP 要填条目里看到的 16 位哈希（0-9、a-f）";
}

export interface BanPrefill {
  kind: BanKind;
  value: string;
  /** 条目带的 IP 哈希（有设备哈希时顺带给的，页面上提示「也可以改封 IP」）。 */
  ip: string;
}

/** `#/bans?kind=device&value=…&ip=…` → 表单初值。不认识的 kind 退回 device，不合格式的 ip 丢掉。 */
export function parseBanPrefill(query: Record<string, string>): BanPrefill {
  const kind = BAN_KINDS.find((k) => k === query.kind) ?? "device";
  const ip = query.ip && HASH.test(query.ip) ? query.ip.toLowerCase() : "";
  return { kind, value: (query.value ?? "").trim(), ip };
}
