// 频率限制：固定窗口计数，存在 D1 的 rate_limits 表里。
//
// 为什么不用 Workers 自带的 Rate Limiting 绑定 / Cache API：前者要付费计划或单独开通，后者在 workers.dev 域名上不生效；
// D1 计数一次请求只多一条语句，免费版绰绰有余。过期的行每天凌晨清一次（housekeeping）。

export interface RateRule {
  /** 计数器名字，比如 `submit:h:dev:ab12…`；同一个名字 + 同一个窗口共用一个计数。 */
  name: string;
  limit: number;
  windowMs: number;
}

function slot(rule: RateRule, now: number): { key: string; expiresAt: number } {
  const bucket = Math.floor(now / rule.windowMs);
  return { key: `${rule.name}#${bucket}`, expiresAt: (bucket + 1) * rule.windowMs };
}

/**
 * 给每条规则的计数 +1（一条语句搞定），返回第一条超限的规则；都没超返回 null。
 * 被拒绝的请求也计数——一直在撞的客户端会一直被拒，正好。
 */
export async function hitRateLimits(db: D1Database, rules: readonly RateRule[], now: number): Promise<RateRule | null> {
  if (rules.length === 0) return null;
  const slots = rules.map((rule) => slot(rule, now));
  const placeholders = slots.map(() => "(?, 1, ?)").join(", ");
  const params = slots.flatMap((s) => [s.key, s.expiresAt]);
  const { results } = await db
    .prepare(
      `INSERT INTO rate_limits (key, count, expires_at) VALUES ${placeholders}
       ON CONFLICT (key) DO UPDATE SET count = count + 1
       RETURNING key, count`,
    )
    .bind(...params)
    .all<{ key: string; count: number }>();
  const counts = new Map(results.map((row) => [row.key, row.count]));
  for (let i = 0; i < rules.length; i++) {
    const rule = rules[i];
    const s = slots[i];
    if (rule && s && (counts.get(s.key) ?? 0) > rule.limit) return rule;
  }
  return null;
}

/** 清零这条规则当前窗口里的计数（比如验证码输对了，前面的试错作废）。 */
export async function clearRateLimit(db: D1Database, rule: RateRule, now: number): Promise<void> {
  await db.prepare("DELETE FROM rate_limits WHERE key = ?").bind(slot(rule, now).key).run();
}
