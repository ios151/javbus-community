// 公开接口 /api/v1：App 读列表、提交 / 撤销推荐、举报、测试连接。
//
// 提交和撤销接口兼容原作者的 Apps Script：请求体 { av, mode: "upload" | "del", pw? }，响应是纯文本返回码。
//   succeed 成功 · FE 格式错误 · RE 已在列表里 · NA 没有权限（口令不对 / 不是你提交的）
// 在此基础上多了几个码（HTTP 状态码也随之变化，App 只读响应正文）：
//   PD 已收下、等维护者审核 · RL 太频繁 · BN 被封禁 · OFF 暂停收稿 · NF 没有这条 · FULL 列表满了

import type { Context } from "hono";
import { Hono } from "hono";
import { cors } from "hono/cors";

import { APP_VERSION, CHANNELS, type Channel, type MetaDTO, type Role } from "../../shared/types";
import type { AppEnv } from "../context";
import { isBanned } from "../lib/bans";
import { hashId, sha256Hex } from "../lib/crypto";
import { clientIp, defer, deviceIdOf, readJson } from "../lib/http";
import { createItem, deleteItems, findByCode, hasRoom } from "../lib/items";
import { hitRateLimits, type RateRule } from "../lib/ratelimit";
import { createReport } from "../lib/reports";
import { loadConfig, type Config } from "../lib/settings";
import { readSnapshot } from "../lib/snapshot";
import { DAY, HOUR, HttpError } from "../lib/util";
import { cleanText, isValidCode, parseHostList, parseWordList, validateItem, validateReport } from "../lib/validate";

const RESULTS = { succeed: 200, PD: 202, FE: 400, RE: 409, NA: 401, RL: 429, BN: 403, OFF: 503, NF: 404, FULL: 507 } as const;
type ResultCode = keyof typeof RESULTS;

function result(c: Context, code: ResultCode): Response {
  return c.text(code, RESULTS[code]);
}

export const publicApp = new Hono<AppEnv>();

// 公开的读接口允许任意网页读（比如拿去做个预览页）；写接口只给 App 用，不开跨域
publicApp.use("/rec/*", cors({ origin: "*", allowMethods: ["GET"] }));
publicApp.use("/meta", cors({ origin: "*", allowMethods: ["GET"] }));
publicApp.use("/health", cors({ origin: "*", allowMethods: ["GET"] }));

function parseChannel(value: string | undefined): Channel | null {
  return CHANNELS.find((c) => c === value) ?? null;
}

publicApp.get("/health", async (c) => {
  await c.env.DB.prepare("SELECT 1").first();
  return c.json({ ok: true, time: Date.now() });
});

publicApp.get("/meta", async (c) => {
  const { settings } = await loadConfig(c.env.DB);
  const { results } = await c.env.DB.prepare("SELECT channel, count FROM snapshots").all<{ channel: Channel; count: number }>();
  const counts = new Map(results.map((row) => [row.channel, row.count]));
  const meta: MetaDTO = {
    name: settings.siteName,
    version: APP_VERSION,
    maintenance: settings.maintenance,
    autoApprove: settings.autoApproveUser,
    channels: { user: counts.get("user") ?? 0, author: counts.get("author") ?? 0 },
  };
  return c.json(meta);
});

/** If-None-Match 里有没有这个 ETag（可能是逗号分隔的多个，可能带 W/ 前缀）。 */
function matchesEtag(header: string | undefined, etag: string): boolean {
  if (!header) return false;
  const strip = (value: string) => value.trim().replace(/^W\//, "");
  return header.split(",").some((candidate) => strip(candidate) === "*" || strip(candidate) === strip(etag));
}

publicApp.get("/rec/:channel", async (c) => {
  const channel = parseChannel(c.req.param("channel"));
  if (!channel) throw new HttpError(404, "not_found", "没有这份列表");
  const snapshot = await readSnapshot(c.env.DB, channel);
  const etag = `W/"${channel}-${snapshot?.version ?? 0}"`;
  // no-cache = 每次都向我确认，没变就只回 304（不带正文）；这样 App 刷新能马上看到新条目
  const headers = { ETag: etag, "Cache-Control": "no-cache" };
  if (matchesEtag(c.req.header("If-None-Match"), etag)) return new Response(null, { status: 304, headers });
  return new Response(snapshot?.body ?? "[]", {
    headers: { ...headers, "Content-Type": "application/json; charset=utf-8", "X-Total-Count": String(snapshot?.count ?? 0) },
  });
});

// ———— 维护者口令（App 里「作者通道」填的密码）————

interface AppKeyOwner {
  keyId: number;
  userId: number;
  name: string;
  role: Role;
}

async function findAppKey(c: Context<AppEnv>, password: string, now: number): Promise<AppKeyOwner | null> {
  if (!password.startsWith("jca_")) return null;
  const hash = await sha256Hex(password);
  const row = await c.env.DB.prepare(
    `SELECT k.id AS key_id, u.id AS user_id, u.name, u.role
     FROM app_keys k JOIN users u ON u.id = k.user_id
     WHERE k.key_hash = ? AND k.revoked = 0 AND u.disabled = 0`,
  )
    .bind(hash)
    .first<{ key_id: number; user_id: number; name: string; role: Role }>();
  if (!row) return null;
  defer(c, c.env.DB.prepare("UPDATE app_keys SET last_used_at = ? WHERE id = ?").bind(now, row.key_id).run());
  return { keyId: row.key_id, userId: row.user_id, name: row.name, role: row.role };
}

interface Who {
  ipHash: string;
  deviceHash: string;
}

async function identify(c: Context<AppEnv>, salt: string): Promise<Who> {
  const device = deviceIdOf(c);
  return { ipHash: await hashId(salt, clientIp(c)), deviceHash: device ? await hashId(salt, device) : "" };
}

function submitRules(who: Who, config: Config): RateRule[] {
  const { settings } = config;
  return [
    { name: `sub:h:ip:${who.ipHash}`, limit: settings.submitPerHourIp, windowMs: HOUR },
    { name: `sub:d:ip:${who.ipHash}`, limit: settings.submitPerDayIp, windowMs: DAY },
    ...(who.deviceHash
      ? [
          { name: `sub:h:dev:${who.deviceHash}`, limit: settings.submitPerHourDevice, windowMs: HOUR },
          { name: `sub:d:dev:${who.deviceHash}`, limit: settings.submitPerDayDevice, windowMs: DAY },
        ]
      : []),
  ];
}

// ———— 提交 / 撤销 ————

const MAX_UPLOAD_BODY = 8 * 1024;

publicApp.post("/upload/:channel", async (c) => {
  const channel = parseChannel(c.req.param("channel"));
  if (!channel) return result(c, "FE");

  let body: Record<string, unknown>;
  try {
    const parsed = await readJson(c.req.raw, MAX_UPLOAD_BODY);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return result(c, "FE");
    body = Object.fromEntries(Object.entries(parsed));
  } catch (error) {
    if (error instanceof HttpError) return result(c, "FE");
    throw error;
  }
  const mode = body.mode;
  if (mode !== "upload" && mode !== "del") return result(c, "FE");

  const db = c.env.DB;
  const now = Date.now();
  const config = await loadConfig(db, now);
  const { settings, salt } = config;
  const who = await identify(c, salt);

  // 口令：给了就必须是有效的维护者口令（App 口令），不然 NA；连续试错会被限速
  const password = typeof body.pw === "string" ? body.pw.trim() : "";
  const maintainer = password ? await findAppKey(c, password, now) : null;
  if (password && !maintainer) {
    const limited = await hitRateLimits(db, [{ name: `badpw:${who.ipHash}`, limit: 20, windowMs: HOUR }], now);
    return result(c, limited ? "RL" : "NA");
  }

  if (mode === "del") {
    const code = cleanText(body.av);
    if (!isValidCode(code)) return result(c, "FE");
    const existing = await findByCode(db, channel, code);
    if (!maintainer) {
      // 没有口令：只有网友推荐、且是你自己（同一个设备）不久前提交的，才能撤销
      if (channel !== "user" || settings.ownDeleteDays <= 0 || !who.deviceHash) return result(c, "NA");
      if (await isBanned(db, { device: who.deviceHash, ip: who.ipHash })) return result(c, "BN");
      const mine =
        existing !== null &&
        existing.submitter === who.deviceHash &&
        (existing.status === "approved" || existing.status === "pending") &&
        now - existing.createdAt <= settings.ownDeleteDays * DAY;
      if (!mine) return result(c, existing ? "NA" : "NF");
    }
    if (!existing) return result(c, "NF");
    await deleteItems(db, [existing.id], now, {
      actor: maintainer?.name ?? "app",
      userId: maintainer?.userId ?? null,
      action: maintainer ? "item.delete" : "item.self_delete",
      targetType: "item",
      ipHash: who.ipHash,
    });
    return result(c, "succeed");
  }

  // ——— 上传 ———
  if (!maintainer) {
    if (channel === "author") return result(c, "NA");
    if (settings.maintenance) return result(c, "OFF");
  }
  const checked = validateItem(
    body.av,
    maintainer ? {} : { allowedHosts: parseHostList(settings.allowedHosts), blockedWords: parseWordList(settings.blockedWords) },
  );
  if (!checked.ok) return result(c, "FE");
  const { item } = checked;

  if (!maintainer) {
    if (await isBanned(db, { device: who.deviceHash, ip: who.ipHash, code: item.code })) return result(c, "BN");
    if (await hitRateLimits(db, submitRules(who, config), now)) return result(c, "RL");
  }

  const status = maintainer || settings.autoApproveUser ? "approved" : "pending";
  if (status === "approved" && !(await hasRoom(db, channel, settings.maxItemsPerChannel))) return result(c, "FULL");

  if (!maintainer) {
    // 已经有了的先说「已在列表」，不占总闸的名额
    const existing = await findByCode(db, channel, item.code);
    if (existing && existing.status !== "rejected") return result(c, "RE");
    // 总闸：所有人加起来每天最多收多少条。每条新提交上线都要重读整份列表来重建快照，免费版 D1 的读额度经不起被人刷；
    // 只数走到这里的（已经过了封禁、按设备 / IP 限频、校验、查重、容量）——被前面拦下的请求不占名额，不然一个人狂发请求就能把当天的名额耗光
    const gate: RateRule = { name: "sub:d:all", limit: settings.submitPerDayGlobal, windowMs: DAY };
    if (await hitRateLimits(db, [gate], now)) return result(c, "RL");
  }

  const id = await createItem(
    db,
    {
      ...item,
      channel,
      status,
      submitter: maintainer ? "" : who.deviceHash,
      ipHash: maintainer ? "" : who.ipHash,
      createdBy: maintainer?.userId ?? null,
    },
    now,
    maintainer
      ? {
          actor: maintainer.name,
          userId: maintainer.userId,
          action: "item.create",
          targetType: "item",
          targetId: item.code,
          detail: { channel, status },
          ipHash: who.ipHash,
        }
      : undefined,
  );
  if (id === null) return result(c, "RE");
  return result(c, status === "approved" ? "succeed" : "PD");
});

// ———— 举报 ————

publicApp.post("/report", async (c) => {
  let raw: unknown;
  try {
    raw = await readJson(c.req.raw, MAX_UPLOAD_BODY);
  } catch (error) {
    if (error instanceof HttpError) return result(c, "FE");
    throw error;
  }
  const report = validateReport(raw);
  if (!report) return result(c, "FE");

  const db = c.env.DB;
  const now = Date.now();
  const config = await loadConfig(db, now);
  const { settings, salt } = config;
  const who = await identify(c, salt);
  if (await isBanned(db, { device: who.deviceHash, ip: who.ipHash })) return result(c, "BN");

  // 同一个出口 IP 后面可能有很多人，IP 的上限比设备宽三倍
  const reporter = who.deviceHash || who.ipHash;
  const limited = await hitRateLimits(
    db,
    [
      { name: `rep:d:${reporter}`, limit: settings.reportPerDayDevice, windowMs: DAY },
      { name: `rep:d:ip:${who.ipHash}`, limit: settings.reportPerDayDevice * 3, windowMs: DAY },
    ],
    now,
  );
  if (limited) return result(c, "RL");

  const item = await findByCode(db, report.channel, report.code);
  if (!item || item.status !== "approved") return result(c, "NF");
  // 同一个人重复举报同一个条目：当成功（不暴露「你举报过了」，也不重复计数）
  await createReport(
    db,
    { itemId: item.id, channel: report.channel, code: report.code, reason: report.reason, detail: report.detail, reporter, ipHash: who.ipHash },
    settings,
    now,
  );
  return result(c, "succeed");
});
