// 条目管理：列表 / 筛选 / 新增 / 编辑 / 通过·拒绝·隐藏 / 删除 / 导入导出。

import { Hono } from "hono";

import { APP_VERSION, CHANNELS, CHECK_STATUSES, ITEM_STATUSES, type ImportResultDTO } from "../../../shared/types";
import type { AppEnv } from "../../context";
import { requirePermission } from "../../lib/auth";
import { proxyCover } from "../../lib/cover";
import { asRecord, idList, idParam, pageParams, readBodyText, readJson } from "../../lib/http";
import {
  createItem,
  deleteItems,
  getItem,
  hasRoom,
  importItems,
  isItemSort,
  listItems,
  parseItemPatch,
  setStatus,
  updateItem,
  type ImportOrder,
  type ItemFilter,
} from "../../lib/items";
import { loadConfig } from "../../lib/settings";
import { HttpError, utcDay } from "../../lib/util";
import { checkUrl, cleanText, LIMITS, validateItem, type ItemFields } from "../../lib/validate";

export const itemsRoutes = new Hono<AppEnv>();

const moderate = requirePermission("items.moderate");
const transfer = requirePermission("transfer");

itemsRoutes.get("/items", async (c) => {
  const q = c.req.query();
  const sort = q.sort ?? "new";
  const filter: ItemFilter = {
    channel: CHANNELS.find((x) => x === q.channel),
    status: ITEM_STATUSES.find((x) => x === q.status),
    check: CHECK_STATUSES.find((x) => x === q.check),
    q: cleanText(q.q).slice(0, 60) || undefined,
    reported: q.reported === "1",
    sort: isItemSort(sort) ? sort : "new",
    ...pageParams(c),
  };
  return c.json(await listItems(c.env.DB, filter));
});

itemsRoutes.get("/items/:id", async (c) => {
  const item = await getItem(c.env.DB, idParam(c));
  if (!item) throw new HttpError(404, "not_found", "没有这个条目");
  return c.json(item);
});

// 后台页面显示封面走这里：由服务端带上站点的 Referer 去取（防盗链），见 lib/cover.ts。<img> 发的是 GET，不需要 X-JC-Admin 头。
itemsRoutes.get("/items/:id/cover", async (c) => {
  const row = await c.env.DB.prepare("SELECT src, link FROM items WHERE id = ?").bind(idParam(c)).first<{ src: string; link: string }>();
  if (!row) throw new HttpError(404, "not_found", "没有这个条目");
  if (!row.src) throw new HttpError(404, "no_cover", "这个条目没有封面");
  return proxyCover(row.src, row.link);
});

itemsRoutes.post("/items", moderate, async (c) => {
  const body = asRecord(await readJson(c.req.raw, 8 * 1024));
  const { id: userId, name } = c.var.user;
  const channel = CHANNELS.find((x) => x === body.channel);
  if (!channel) throw new HttpError(422, "invalid_item", "channel 只能是 user 或 author");
  const checked = validateItem(body);
  if (!checked.ok) throw new HttpError(422, "invalid_item", checked.reason);
  const status = body.status === "pending" ? "pending" : "approved";
  const now = Date.now();
  const { settings } = await loadConfig(c.env.DB, now);
  if (status === "approved" && !(await hasRoom(c.env.DB, channel, settings.maxItemsPerChannel))) {
    throw new HttpError(409, "list_full", "这份列表已经装满了，先隐藏一些旧的，或者在设置里调大上限");
  }
  const id = await createItem(
    c.env.DB,
    { ...checked.item, channel, status, createdBy: userId, note: cleanText(body.note).slice(0, LIMITS.note) },
    now,
    { actor: name, userId, action: "item.create", targetType: "item", targetId: checked.item.code, detail: { channel, status } },
  );
  if (id === null) throw new HttpError(409, "exists", "这个番号已经在这份列表里了");
  return c.json(await getItem(c.env.DB, id), 201);
});

itemsRoutes.patch("/items/:id", moderate, async (c) => {
  const patch = parseItemPatch(asRecord(await readJson(c.req.raw, 8 * 1024)));
  const { id: userId, name } = c.var.user;
  const now = Date.now();
  const { settings } = await loadConfig(c.env.DB, now);
  return c.json(await updateItem(c.env.DB, idParam(c), patch, now, { actor: name, userId }, settings.maxItemsPerChannel));
});

const STATUS_ACTIONS = { approved: "item.approve", rejected: "item.reject", hidden: "item.hide" } as const;

itemsRoutes.post("/items/status", moderate, async (c) => {
  const body = asRecord(await readJson(c.req.raw, 4 * 1024));
  const ids = idList(body.ids);
  const status = (["approved", "rejected", "hidden"] as const).find((s) => s === body.status);
  if (!status) throw new HttpError(422, "invalid_status", "status 只能是 approved / rejected / hidden");
  const { id: userId, name } = c.var.user;
  const now = Date.now();
  const { settings } = await loadConfig(c.env.DB, now);
  const changed = await setStatus(
    c.env.DB,
    ids,
    { status, hiddenReason: status === "hidden" ? "manual" : "", reviewerId: userId },
    now,
    settings.maxItemsPerChannel,
    { actor: name, userId, action: STATUS_ACTIONS[status], targetType: "item" },
  );
  return c.json({ changed: changed.length });
});

itemsRoutes.post("/items/delete", moderate, async (c) => {
  const body = asRecord(await readJson(c.req.raw, 4 * 1024));
  const { id: userId, name } = c.var.user;
  const deleted = await deleteItems(c.env.DB, idList(body.ids), Date.now(), { actor: name, userId, action: "item.delete", targetType: "item" });
  return c.json({ deleted: deleted.length });
});

// ———— 导入 / 导出 ————

const MAX_IMPORT_ITEMS = 1000;
/** 单次导出最多多少条（D1 返回的字符串上限 2 MB；3000 条约 0.7 MB）。 */
const EXPORT_MAX = 6000;
/** order.base 最多比现在早多久：一次导入不会拖过一天；防止有人拿它把条目的时间改成很久以前。 */
const MAX_IMPORT_BASE_AGE = 24 * 60 * 60 * 1000;
const MAX_IMPORT_OFFSET = 1_000_000;

/** 分批导入的排序参数（可选）。不合法 → 422。 */
function parseImportOrder(raw: unknown, now: number): ImportOrder | undefined {
  if (raw === undefined) return undefined;
  const o = raw && typeof raw === "object" && !Array.isArray(raw) ? Object.fromEntries(Object.entries(raw)) : null;
  const base = o?.base;
  const offset = o?.offset;
  const ok =
    typeof base === "number" && Number.isInteger(base) && base <= now + 60_000 && base >= now - MAX_IMPORT_BASE_AGE &&
    typeof offset === "number" && Number.isInteger(offset) && offset >= 0 && offset <= MAX_IMPORT_OFFSET;
  if (!ok) throw new HttpError(422, "invalid_import", "order 应该是 { base: 开始导入的毫秒时间戳（一天以内）, offset: 这一批前面有多少条 }");
  return { base, offset };
}

itemsRoutes.post("/items/import", transfer, async (c) => {
  const body = asRecord(await readJson(c.req.raw, 1_500_000));
  const channel = CHANNELS.find((x) => x === body.channel);
  if (!channel) throw new HttpError(422, "invalid_import", "channel 只能是 user 或 author");
  const status = body.status === "pending" ? "pending" : "approved";
  const order = parseImportOrder(body.order, Date.now());
  const raw = body.items;
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_IMPORT_ITEMS) {
    throw new HttpError(422, "invalid_import", `items 应该是 1 到 ${MAX_IMPORT_ITEMS} 条（更大的文件请分批导入）`);
  }

  const valid: ItemFields[] = [];
  const seen = new Set<string>();
  const samples: ImportResultDTO["samples"] = [];
  let invalid = 0;
  raw.forEach((entry: unknown, index) => {
    const checked = validateItem(entry, { lenient: true });
    if (!checked.ok) {
      invalid++;
      if (samples.length < 10) samples.push({ index, reason: checked.reason });
      return;
    }
    const key = checked.item.code.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    valid.push(checked.item);
  });

  const { id: userId, name } = c.var.user;
  const now = Date.now();
  const { settings } = await loadConfig(c.env.DB, now);
  const done = await importItems(c.env.DB, channel, valid, status, now, settings.maxItemsPerChannel, { actor: name, userId }, order);
  const result: ImportResultDTO = {
    received: raw.length,
    inserted: done.inserted,
    skipped: raw.length - invalid - done.inserted,
    invalid,
    samples,
  };
  return c.json(result);
});

/** 代为下载一份远程的 JSON 列表（比如原作者在 GitLab 上的两份），清洗后返回；浏览器再分批调 /items/import 导入。 */
itemsRoutes.post("/items/import/fetch", transfer, async (c) => {
  const body = asRecord(await readJson(c.req.raw, 2 * 1024));
  const url = cleanText(body.url);
  const problem = checkUrl(url);
  if (problem || !url.startsWith("https://")) throw new HttpError(422, "invalid_url", problem ?? "只支持 https 地址");

  let text: string;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(10_000), headers: { Accept: "application/json,text/plain,*/*" } });
    if (!response.ok) throw new HttpError(422, "fetch_failed", `对方返回了 HTTP ${response.status}`);
    text = await readBodyText(response, 4_000_000);
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(422, "fetch_failed", "下载失败（超时或连不上）");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new HttpError(422, "fetch_failed", "对方返回的不是 JSON");
  }
  if (!Array.isArray(parsed)) throw new HttpError(422, "fetch_failed", "对方返回的 JSON 不是数组");

  // 只做最便宜的结构检查（是对象、有字符串的 code 和 link）；真正的校验留给分批导入（每批 ≤ 500 条）——
  // 在这一个请求里把两万条都校验一遍（每条要解析两个地址），免费版每次调用 10 毫秒 CPU 放不下，导入原作者的两份列表正好会撞上
  const items: unknown[] = [];
  let invalid = 0;
  for (const entry of parsed.slice(0, 20_000)) {
    const o = entry && typeof entry === "object" ? Object.fromEntries(Object.entries(entry)) : null;
    if (o && typeof o.code === "string" && typeof o.link === "string") items.push(entry);
    else invalid++;
  }
  return c.json({ items, invalid });
});

itemsRoutes.get("/export", transfer, async (c) => {
  const q = c.req.query();
  const channel = CHANNELS.find((x) => x === q.channel);
  const status = ITEM_STATUSES.find((x) => x === q.status);
  const where: string[] = [];
  const params: string[] = [];
  if (channel) {
    where.push("channel = ?");
    params.push(channel);
  }
  if (status) {
    where.push("status = ?");
    params.push(status);
  }
  // JSON 在 SQL 里拼好（json_group_array），Worker 只把字符串拼进外壳：在 JS 里把几千行 stringify 一遍，免费版的 10 毫秒 CPU 不够。
  // D1 返回的字符串也受 2 MB 限制，所以单次最多 EXPORT_MAX 条；超过的按频道 / 状态分开导出（truncated 会是 true）
  const row = await c.env.DB.prepare(
    `SELECT COUNT(*) AS n,
            json_group_array(json_object('channel', channel, 'code', code, 'info', info, 'src', src, 'link', link,
                                         'status', status, 'note', note, 'createdAt', created_at)) AS body
     FROM (SELECT channel, code, info, src, link, status, note, created_at FROM items
           ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
           ORDER BY channel, created_at DESC, id DESC LIMIT ${EXPORT_MAX})`,
  )
    .bind(...params)
    .first<{ n: number; body: string }>();
  const now = Date.now();
  const count = row?.n ?? 0;
  const body = `{"app":"javbus-community","version":${JSON.stringify(APP_VERSION)},"exportedAt":${now},"truncated":${count >= EXPORT_MAX},"items":${row?.body ?? "[]"}}`;
  return new Response(body, {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="javbus-community-${utcDay(now)}.json"`,
    },
  });
});
