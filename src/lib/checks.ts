// 自动检查：定期（或维护者手动触发）去看条目的封面和详情页还在不在。
//
// 每个地址的结论有四种：
//   ok       正常（2xx；封面还要 Content-Type 是图片）
//   gone     确认没了（404 / 410）
//   unknown  说不准（403 / 429 / 5xx、超时、网络错误、封面返回了网页……）
//   skipped  没法检查：详情页被站点的年龄验证页挡住了（JavBus 一类站点，没有验证 cookie 时所有详情页——不管番号存不存在——都会跳到
//            /doc/driver-verify 并返回 200，看不到真实页面，判成「正常」是假信号）。不参与判定，只看另一项（封面）。
//            我们不替检查器去带年龄验证的 cookie 绕过它：脚本那边也是「先问用户、同意才提交」，不静默绕过。
// 条目的结论：有 gone → dead（失效）；没有 gone 但有 unknown → warn（存疑）；至少有一项 ok → ok；
// 一项都没法判断（只剩 skipped，或根本没有可查的地址）→ unchecked（没查成，不动失效计数、也不会触发自动恢复）。
//
// 自动隐藏要谨慎，因为误判的代价是整站条目被下架，所以有三道保险：
//   1. 只有「连续 N 次 dead」才隐藏，存疑只做标记（站点有 Cloudflare 验证页之类，机器访问被拒是常事，不能当成失效）；
//   2. 「连续」要隔得开：两次失效之间至少隔半个复查间隔才都算数（手动连点几次「检查一批」不会几分钟内凑够 N 次）；
//   3. 一批里几乎全判成失效（≥ 5 条且 ≥ 80%），多半是站点在拦我们 / 网络出了问题，不是真有这么多条同时没了：整批改判存疑。
//
// 免费版一次调用最多 50 个子请求，所以一批最多查 25 个条目（每个最多 2 个请求）；设置里的 checkBatchSize 默认 10。
// 多次调用靠定时任务（每 30 分钟一批）或后台「继续检查」接力。

import { CHANNELS, type CheckRunDTO, type CheckStatus, type Settings } from "../../shared/types";
import { auditStatement } from "./audit";
import { rebuildSnapshots } from "./snapshot";
import { DAY } from "./util";

export const MOBILE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const PROBE_TIMEOUT_MS = 8000;
/** 同时查几个条目（每个条目 2 个请求并行）：Workers 同一时刻最多 6 个外连，超了会排队。 */
const CONCURRENCY = 3;
/** 一批最多几个条目：免费版一次调用最多 50 个子请求，每个条目最多 2 个。 */
export const ABSOLUTE_MAX_BATCH = 25;
/** 整批异常的判定：至少这么多条、其中失效占这么大比例。 */
const MASS_FAILURE_MIN_BATCH = 5;
const MASS_FAILURE_RATIO = 0.8;

export type UrlState = "ok" | "gone" | "unknown" | "skipped";
export interface Verdict {
  state: UrlState;
  detail: string;
  /** 这个请求根本没发出去（子请求额度用完了）：不是站点的问题，这个条目这次不算查过。 */
  unprobed?: boolean;
}

/**
 * 重定向之后落在了站点的年龄验证页上？（JavBus 及其镜像站共用同一套，路径是 /doc/driver-verify）
 * 给了请求的地址的话，还要求落点和请求在同一个域名上：跳到别的域名上同名路径的，不是这个站自己的验证页。
 */
export function isAgeGateUrl(finalUrl: string | undefined, requestedUrl?: string): boolean {
  if (!finalUrl) return false;
  try {
    const final = new URL(finalUrl);
    if (!final.pathname.startsWith("/doc/driver-verify")) return false;
    return !requestedUrl || new URL(requestedUrl).hostname === final.hostname;
  } catch {
    return false;
  }
}

export function classify(response: Pick<Response, "status" | "headers"> & { url?: string }, kind: "image" | "page", requestedUrl?: string): Verdict {
  const { status } = response;
  if (status === 404 || status === 410) return { state: "gone", detail: `HTTP ${status}` };
  if (status >= 200 && status < 300) {
    if (kind === "page" && isAgeGateUrl(response.url, requestedUrl)) return { state: "skipped", detail: "站点先跳到年龄验证页，看不到真实页面" };
    if (kind === "image") {
      const type = (response.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
      if (!type.startsWith("image/")) return { state: "unknown", detail: `不是图片（${type || "没有类型"}）` };
    }
    return { state: "ok", detail: "" };
  }
  return { state: "unknown", detail: `HTTP ${status}` };
}

/** 地址所在站点的根（`https://host/`），拿来当 Referer；不是合法地址返回空串。 */
export function originOf(url: string): string {
  try {
    return `${new URL(url).origin}/`;
  } catch {
    return "";
  }
}

/** 只要状态码和响应头，正文不读、立刻放弃（不占外连名额，也不下载整张图）。 */
export async function probeUrl(
  url: string,
  kind: "image" | "page",
  referer: string,
  fetcher: typeof fetch = fetch,
): Promise<Verdict> {
  try {
    const headers: Record<string, string> = {
      "User-Agent": MOBILE_UA,
      Accept: kind === "image" ? "image/*,*/*;q=0.8" : "text/html,*/*;q=0.8",
    };
    if (kind === "image") {
      headers.Range = "bytes=0-0";
      if (referer) headers.Referer = referer;
    }
    const response = await fetcher(url, { method: "GET", redirect: "follow", headers, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    void response.body?.cancel().catch(() => undefined);
    return classify(response, kind, url);
  } catch (error) {
    if (error instanceof Error && /too many subrequests/i.test(error.message)) {
      // 平台的子请求额度（免费版 50 个）用完了：请求没发出去，和站点无关，别记成「网络错误」把这个条目的检查时间推进了
      return { state: "unknown", detail: "子请求额度用完了", unprobed: true };
    }
    return { state: "unknown", detail: error instanceof Error && error.name === "TimeoutError" ? "超时" : "网络错误" };
  }
}

export function judge(parts: readonly { name: string; verdict: Verdict }[]): { status: CheckStatus; detail: string } {
  const describe = (state: UrlState) =>
    parts
      .filter((p) => p.verdict.state === state)
      .map((p) => `${p.name} ${p.verdict.detail}`)
      .join("；");
  if (parts.some((p) => p.verdict.state === "gone")) return { status: "dead", detail: describe("gone") };
  if (parts.some((p) => p.verdict.state === "unknown")) return { status: "warn", detail: describe("unknown") };
  if (parts.some((p) => p.verdict.state === "ok")) return { status: "ok", detail: "" };
  // 一项都没法判断：不能算「查过没问题」（会清零失效计数、还会把因失效隐藏的条目放回公开列表）
  return { status: "unchecked", detail: parts.length > 0 ? describe("skipped") : "没有可检查的地址（封面是空的，或者封面 / 链接的检查都关了）" };
}

export interface Candidate {
  id: number;
  code: string;
  src: string;
  link: string;
}

interface Outcome {
  id: number;
  status: CheckStatus;
  detail: string;
  /** 请求没发出去（见 Verdict.unprobed）：这个条目这次不记结果。 */
  unprobed?: boolean;
}

async function checkCandidate(item: Candidate, settings: Settings, fetcher: typeof fetch): Promise<Outcome> {
  const referer = originOf(item.link);
  const [cover, link] = await Promise.all([
    settings.checkCover && item.src ? probeUrl(item.src, "image", referer, fetcher) : null,
    settings.checkLink ? probeUrl(item.link, "page", referer, fetcher) : null,
  ]);
  const parts = [
    ...(cover ? [{ name: "封面", verdict: cover }] : []),
    ...(link ? [{ name: "链接", verdict: link }] : []),
  ];
  if (parts.some((p) => p.verdict.unprobed)) return { id: item.id, status: "unchecked", detail: "", unprobed: true };
  return { id: item.id, ...judge(parts) };
}

/**
 * 一批里几乎全判成失效：改判存疑。返回改了几条。
 * 站点对数据中心的 IP 回 404 / 410（或者一整个镜像域名下线），在我们这边看起来就是「整批失效」，但这不等于每个条目真的没了——
 * 让维护者人工看，比让它自动把整站条目下架稳妥。
 */
function dampenMassFailure(outcomes: Outcome[]): number {
  const dead = outcomes.filter((o) => o.status === "dead");
  if (outcomes.length < MASS_FAILURE_MIN_BATCH || dead.length / outcomes.length < MASS_FAILURE_RATIO) return 0;
  for (const outcome of dead) {
    outcome.detail = `整批几乎都失效，先当存疑（站点拦截或网络问题的可能更大）：${outcome.detail}`;
    outcome.status = "warn";
  }
  return dead.length;
}

async function mapPool<T, R>(list: readonly T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next++;
      const item = list[index];
      if (index >= list.length || item === undefined) return;
      out[index] = await fn(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(size, list.length) }, worker));
  return out;
}

/** 哪些条目在检查范围内：已上线的，加上因检查失效被自动隐藏的（它们恢复了要能自动放回来）。 */
const IN_SCOPE = "(status = 'approved' OR (status = 'hidden' AND hidden_reason = 'check'))";

export interface RunOptions {
  trigger: "cron" | "manual";
  userId?: number | null;
  actor: string;
  /** 指定条目（后台的「检查这几条」）；不指定就挑最该查的一批。 */
  itemIds?: readonly number[];
  /** 只查「这个时刻之后还没查过」的：定时任务传 now - 复查间隔；后台「全部检查」传整轮开始的时刻，查完一轮自然结束。 */
  notCheckedSince: number;
  limit?: number;
}

export interface RunResult {
  run: CheckRunDTO | null;
  /** 按同样的条件还剩多少个没查（后台据此显示进度、决定要不要接着查）。 */
  remaining: number;
}

export async function countRemaining(db: D1Database, notCheckedSince: number): Promise<number> {
  const row = await db
    .prepare(`SELECT COUNT(*) AS n FROM items WHERE ${IN_SCOPE} AND (checked_at IS NULL OR checked_at < ?)`)
    .bind(notCheckedSince)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

async function selectCandidates(db: D1Database, options: RunOptions, limit: number): Promise<Candidate[]> {
  if (options.itemIds && options.itemIds.length > 0) {
    const { results } = await db
      .prepare("SELECT id, code, src, link FROM items WHERE id IN (SELECT value FROM json_each(?1)) ORDER BY id LIMIT ?2")
      .bind(JSON.stringify(options.itemIds), limit)
      .all<Candidate>();
    return results;
  }
  const { results } = await db
    .prepare(
      `SELECT id, code, src, link FROM items
       WHERE ${IN_SCOPE} AND (checked_at IS NULL OR checked_at < ?1)
       ORDER BY checked_at IS NOT NULL, checked_at ASC, id ASC
       LIMIT ?2`,
    )
    .bind(options.notCheckedSince, limit)
    .all<Candidate>();
  return results;
}

// 失效计数（check_fail）：失效 +1（但离上一次检查不到 ?3 的不算，见文件头第 2 条）、正常清零、存疑 / 没查成不动
const SAVE_RESULTS = `
  UPDATE items SET
    check_status = r.status, check_detail = r.detail, checked_at = ?2,
    check_fail = CASE r.status
      WHEN 'dead' THEN items.check_fail + CASE WHEN items.checked_at IS NULL OR items.checked_at <= ?3 THEN 1 ELSE 0 END
      WHEN 'ok' THEN 0
      ELSE items.check_fail
    END
  FROM (
    SELECT json_extract(value, '$.id') AS id, json_extract(value, '$.status') AS status, json_extract(value, '$.detail') AS detail
    FROM json_each(?1)
  ) AS r
  WHERE items.id = r.id`;

const AUTO_HIDE = `
  UPDATE items SET status = 'hidden', hidden_reason = 'check', updated_at = ?2
  WHERE status = 'approved' AND check_status = 'dead' AND check_fail >= ?3
    AND id IN (SELECT value FROM json_each(?1))`;

const AUTO_RESTORE = `
  UPDATE items SET status = 'approved', hidden_reason = '', updated_at = ?2
  WHERE status = 'hidden' AND hidden_reason = 'check' AND check_status = 'ok'
    AND id IN (SELECT value FROM json_each(?1))`;

/**
 * 查一批。没有可查的（或封面 / 链接两项检查都关了）返回 run = null。
 * fetcher 可以换（测试里用），默认就是全局 fetch。
 */
export async function runCheckBatch(
  db: D1Database,
  settings: Settings,
  options: RunOptions,
  now: number,
  fetcher: typeof fetch = fetch,
): Promise<RunResult> {
  // 指定了条目（后台「检查这几条」）就查指定的那些，不被「每次检查几个条目」的设置截断
  const wanted = options.itemIds && options.itemIds.length > 0 ? options.itemIds.length : (options.limit ?? settings.checkBatchSize);
  const limit = Math.max(1, Math.min(wanted, ABSOLUTE_MAX_BATCH));
  const noop = async (): Promise<RunResult> => ({ run: null, remaining: await countRemaining(db, options.notCheckedSince) });
  if (!settings.checkCover && !settings.checkLink) return noop();
  const candidates = await selectCandidates(db, options, limit);
  if (candidates.length === 0) return noop();

  const started = await db
    .prepare("INSERT INTO check_runs (started_at, trigger, user_id, examined) VALUES (?, ?, ?, ?) RETURNING id")
    .bind(now, options.trigger, options.userId ?? null, candidates.length)
    .first<{ id: number }>();
  if (!started) throw new Error("检查记录写入失败");

  const outcomes = await mapPool(candidates, CONCURRENCY, (item) => checkCandidate(item, settings, fetcher));
  const probed = outcomes.filter((o) => !o.unprobed);
  const unprobed = outcomes.length - probed.length;
  // 手动指定几条时不做「整批异常」判断：维护者就是想看这几条到底怎么样
  const dampened = options.itemIds && options.itemIds.length > 0 ? 0 : dampenMassFailure(probed);
  const checkedAt = Date.now();
  const hidden = await (async () => {
    if (probed.length === 0) return { hidden: 0, restored: 0 };
    const ids = JSON.stringify(probed.map((o) => o.id));
    const separation = checkedAt - (settings.checkIntervalDays * DAY) / 2;
    const saved = await db.batch([
      db.prepare(SAVE_RESULTS).bind(JSON.stringify(probed), checkedAt, separation),
      ...(settings.checkAutoHide
        ? [
            db.prepare(AUTO_HIDE).bind(ids, checkedAt, settings.checkFailThreshold),
            db.prepare(AUTO_RESTORE).bind(ids, checkedAt),
          ]
        : []),
    ]);
    return { hidden: saved[1]?.meta.changes ?? 0, restored: saved[2]?.meta.changes ?? 0 };
  })();

  const counts = { ok: 0, warn: 0, dead: 0 };
  for (const outcome of probed) if (outcome.status !== "unchecked") counts[outcome.status]++;
  const note = [
    hidden.hidden > 0 ? `自动隐藏 ${hidden.hidden} 条` : "",
    hidden.restored > 0 ? `自动恢复 ${hidden.restored} 条` : "",
    dampened > 0 ? `整批几乎都失效，${dampened} 条先当存疑（疑似站点拦截或网络问题）` : "",
    unprobed > 0 ? `${unprobed} 个没来得及查（子请求额度用完了）` : "",
  ]
    .filter(Boolean)
    .join("，");

  const finishedAt = Date.now();
  await db.batch([
    db
      .prepare("UPDATE check_runs SET finished_at = ?2, examined = ?3, ok = ?4, warn = ?5, dead = ?6, hidden = ?7, note = ?8 WHERE id = ?1")
      .bind(started.id, finishedAt, probed.length, counts.ok, counts.warn, counts.dead, hidden.hidden, note),
    ...(hidden.hidden + hidden.restored > 0
      ? [
          auditStatement(
            db,
            { actor: "system", action: "check.visibility", targetType: "check_run", targetId: started.id, detail: { hidden: hidden.hidden, restored: hidden.restored } },
            finishedAt,
          ),
        ]
      : []),
  ]);
  if (hidden.hidden + hidden.restored > 0) await rebuildSnapshots(db, CHANNELS, finishedAt);

  const run: CheckRunDTO = {
    id: started.id,
    startedAt: now,
    finishedAt,
    trigger: options.trigger,
    by: options.trigger === "manual" ? options.actor : null,
    examined: probed.length,
    ...counts,
    hidden: hidden.hidden,
    note,
  };
  return { run, remaining: await countRemaining(db, options.notCheckedSince) };
}

/** 定时任务那一批：按设置里的复查间隔、批量大小挑最该查的。 */
export function cronRunOptions(settings: Settings, now: number): RunOptions {
  return { trigger: "cron", actor: "system", notCheckedSince: now - settings.checkIntervalDays * DAY };
}

interface RunRow {
  id: number;
  started_at: number;
  finished_at: number | null;
  trigger: "cron" | "manual";
  by_name: string | null;
  examined: number;
  ok: number;
  warn: number;
  dead: number;
  hidden: number;
  note: string;
}

export async function listRuns(db: D1Database, limit: number): Promise<CheckRunDTO[]> {
  const { results } = await db
    .prepare(
      `SELECT r.id, r.started_at, r.finished_at, r.trigger, u.name AS by_name, r.examined, r.ok, r.warn, r.dead, r.hidden, r.note
       FROM check_runs r LEFT JOIN users u ON u.id = r.user_id
       ORDER BY r.id DESC LIMIT ?`,
    )
    .bind(limit)
    .all<RunRow>();
  return results.map(
    (row): CheckRunDTO => ({
      id: row.id,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      trigger: row.trigger,
      by: row.by_name,
      examined: row.examined,
      ok: row.ok,
      warn: row.warn,
      dead: row.dead,
      hidden: row.hidden,
      note: row.note,
    }),
  );
}
