// 导入的纯逻辑：解析文件、拆成每 500 条一批、累计结果，以及把批次一批批发出去。
//
// 顺序（重要）：服务端导入时，「数组里越靠前 = 上线后排得越靠前」，靠的是 created_at = base - offset - 下标（毫秒）。
// 所以分批导入必须让所有批次共用同一个 base（整个导入开始时取一次 Date.now()），
// 每一批再带上 offset = 这一批前面有多少条（同一份列表里的位置，不是去重后的、也不是已经导进去的条数）。
// 这样批次之间的先后只由位置决定，发送顺序、中途失败后接着导、重试，都不会把顺序弄反。

import { CHANNELS, type Channel, type ImportResultDTO } from "../../../shared/types";

export const IMPORT_BATCH_SIZE = 500;
/** 服务端要求 base 在一天以内；续导时留一点余量，超过就别续了，重新开始。 */
export const IMPORT_BASE_MAX_AGE_MS = 23 * 60 * 60 * 1000;

export type ImportStatus = "approved" | "pending";

/** POST /items/import 的 order 参数。 */
export interface ImportOrder {
  base: number;
  offset: number;
}

export interface ParsedFile {
  items: unknown[];
  /** `export` = 本站导出的 { app, items }；`array` = 直接是个数组（比如原作者的列表）。 */
  format: "export" | "array";
  /** 本站导出的文件里标了 truncated: true：当时超过单次上限，文件里不是全部条目。 */
  truncated: boolean;
}

export type ParseResult = { ok: true; file: ParsedFile } | { ok: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 读文件正文。每个条目是否合格交给服务端判断（返回「不合格」计数和样例），这里只管找到列表。 */
export function parseImportFile(text: string): ParseResult {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, error: "这不是合法的 JSON 文件" };
  }
  let items: unknown;
  let format: ParsedFile["format"] = "array";
  let truncated = false;
  if (Array.isArray(data)) {
    items = data;
  } else if (isRecord(data) && Array.isArray(data.items)) {
    items = data.items;
    format = "export";
    truncated = data.truncated === true;
  } else {
    return { ok: false, error: "文件里没有找到条目列表（应该是一个 JSON 数组，或者本站导出的 { items: [...] } 文件）" };
  }
  if (!Array.isArray(items) || items.length === 0) return { ok: false, error: "文件里没有任何条目" };
  return { ok: true, file: { items, format, truncated } };
}

export interface FileSummary {
  total: number;
  byChannel: Record<Channel, number>;
  /** 没标频道（或标的不认识）的条数。 */
  noChannel: number;
  /** 各状态的条数（文件里的 status 字段，没有的不计）。 */
  byStatus: Record<string, number>;
  /** 文件里有没有 status 字段（本站导出的有；原作者的列表没有）。 */
  hasStatus: boolean;
}

export function summarizeFile(items: readonly unknown[]): FileSummary {
  const summary: FileSummary = { total: items.length, byChannel: { user: 0, author: 0 }, noChannel: 0, byStatus: {}, hasStatus: false };
  for (const item of items) {
    const channel = isRecord(item) ? CHANNELS.find((c) => c === item.channel) : undefined;
    if (channel) summary.byChannel[channel]++;
    else summary.noChannel++;
    if (isRecord(item) && typeof item.status === "string") {
      summary.hasStatus = true;
      summary.byStatus[item.status] = (summary.byStatus[item.status] ?? 0) + 1;
    }
  }
  return summary;
}

export interface ImportOptions {
  /** 全部导入到哪个频道；`file` = 按每个条目自带的 channel 字段分别导入。 */
  channel: Channel | "file";
  /** 导入后的状态：已上线 / 待审。 */
  status: ImportStatus;
  /** 跳过文件里标着「已隐藏 / 已拒绝 / 待审」的条目（导回本站的备份时用，免得被隐藏的又上线了）。 */
  onlyLive: boolean;
  batchSize?: number;
}

export interface ImportBatch {
  channel: Channel;
  status: ImportStatus;
  items: unknown[];
  /** 这一批前面（同一份列表里）有多少条：服务端用它算排序时间。 */
  offset: number;
  /** 每个条目在原文件里的下标（0 起），把服务端报的「第几条不合格」换算回文件里的位置。 */
  positions: number[];
}

export interface ImportPlan {
  /** 发送顺序：先网友推荐、后作者精选，每份列表内按文件顺序。 */
  batches: ImportBatch[];
  /** 会被导入的条数。 */
  selected: number;
  /** 因为状态不是已上线而跳过的条数。 */
  skippedNotLive: number;
  /** 选了「按文件里的频道」但条目没标频道，没法归类而忽略的条数。 */
  unassigned: number;
  byChannel: Record<Channel, number>;
}

export function planImport(items: readonly unknown[], options: ImportOptions): ImportPlan {
  const size = Math.max(1, options.batchSize ?? IMPORT_BATCH_SIZE);
  const buckets: Record<Channel, { item: unknown; position: number }[]> = { user: [], author: [] };
  let skippedNotLive = 0;
  let unassigned = 0;

  items.forEach((item, position) => {
    if (options.onlyLive && isRecord(item) && typeof item.status === "string" && item.status !== "approved") {
      skippedNotLive++;
      return;
    }
    const channel = options.channel === "file" ? (isRecord(item) ? CHANNELS.find((c) => c === item.channel) : undefined) : options.channel;
    if (!channel) {
      unassigned++;
      return;
    }
    buckets[channel].push({ item, position });
  });

  const batches: ImportBatch[] = [];
  for (const channel of CHANNELS) {
    const list = buckets[channel];
    for (let start = 0; start < list.length; start += size) {
      const slice = list.slice(start, start + size);
      batches.push({ channel, status: options.status, items: slice.map((s) => s.item), offset: start, positions: slice.map((s) => s.position) });
    }
  }
  return {
    batches,
    selected: buckets.user.length + buckets.author.length,
    skippedNotLive,
    unassigned,
    byChannel: { user: buckets.user.length, author: buckets.author.length },
  };
}

// ———— 累计结果 ————

export interface ImportSample {
  /** 在原文件里是第几条（1 起）。 */
  position: number;
  reason: string;
}

export interface ImportTotals {
  received: number;
  inserted: number;
  skipped: number;
  invalid: number;
  samples: ImportSample[];
}

export const MAX_SAMPLES = 10;

export function emptyTotals(): ImportTotals {
  return { received: 0, inserted: 0, skipped: 0, invalid: 0, samples: [] };
}

/** 把一批的结果累加进总数（不改原对象）。 */
export function addResult(totals: ImportTotals, result: ImportResultDTO, batch: ImportBatch): ImportTotals {
  const samples = [...totals.samples];
  for (const sample of result.samples) {
    if (samples.length >= MAX_SAMPLES) break;
    const position = batch.positions[sample.index];
    samples.push({ position: (position ?? sample.index) + 1, reason: sample.reason });
  }
  return {
    received: totals.received + result.received,
    inserted: totals.inserted + result.inserted,
    skipped: totals.skipped + result.skipped,
    invalid: totals.invalid + result.invalid,
    samples,
  };
}

// ———— 逐批发送 ————

export interface ImportProgress {
  /** 已经发完几批（含之前续导前完成的）。 */
  done: number;
  total: number;
  totals: ImportTotals;
}

export interface ImportRunnerDeps {
  /** 整个导入共用的 base（开始导入时取一次 Date.now()；续导时沿用第一次的）。 */
  base: number;
  send: (batch: ImportBatch, order: ImportOrder) => Promise<ImportResultDTO>;
  shouldStop: () => boolean;
  onProgress: (progress: ImportProgress) => void;
  /** 续导：从第几批开始（前面的已经导完了）。 */
  startIndex?: number;
  /** 续导：前面已经累计的结果。 */
  totals?: ImportTotals;
}

/**
 * 按顺序发批次。某一批出错就抛出（已完成的进度已经通过 onProgress 交出去了，调用方据此续导）；
 * 中途要求停止则在两批之间退出，返回 stopped = true。
 */
export async function runImport(batches: readonly ImportBatch[], deps: ImportRunnerDeps): Promise<{ stopped: boolean }> {
  let totals = deps.totals ?? emptyTotals();
  const start = deps.startIndex ?? 0;
  deps.onProgress({ done: start, total: batches.length, totals });
  for (let index = start; index < batches.length; index++) {
    const batch = batches[index];
    if (!batch) break;
    if (deps.shouldStop()) return { stopped: true };
    const result = await deps.send(batch, { base: deps.base, offset: batch.offset });
    totals = addResult(totals, result, batch);
    deps.onProgress({ done: index + 1, total: batches.length, totals });
  }
  return { stopped: false };
}

/** 一次中断了的导入还能不能接着导（base 不能超过一天，不然服务端不收）。 */
export function canResumeImport(base: number, now: number): boolean {
  return now - base < IMPORT_BASE_MAX_AGE_MS;
}
