// 导入导出：导出 JSON（普通下载链接）；从文件导入、导入原作者在 GitLab 上的两份列表——都是前端每 500 条一批调接口，
// 累计显示结果。分批导入带统一的 order（base + offset），批次之间的先后只看位置，中断后能接着导。

import { useMemo, useRef, useState } from "preact/hooks";

import { CHANNELS, CHANNEL_NAMES, ITEM_STATUSES, ITEM_STATUS_NAMES, type Channel, type ItemStatus } from "../../../shared/types";
import { api, type FetchedItem } from "../api";
import { errorMessage } from "../lib/errors";
import { EXPORT_LIMIT, exportCount, willBeTruncated } from "../lib/export-range";
import { formatCount, percent } from "../lib/format";
import {
  canResumeImport,
  emptyTotals,
  parseImportFile,
  planImport,
  runImport,
  summarizeFile,
  type FileSummary,
  type ImportBatch,
  type ImportStatus,
  type ImportTotals,
} from "../lib/import-plan";
import { Card, Notice, PageHeader, Spinner } from "../ui/components";
import { Check, Field } from "../ui/controls";
import { confirmDialog } from "../ui/dialogs";
import { useLeaveGuard } from "../ui/hooks";
import { Icon } from "../ui/icons";
import { refreshStats, statsStore } from "../ui/stats";
import { useStore } from "../ui/store";
import { toast } from "../ui/toast";

// ———— 导出 ————

function ExportCard() {
  const [channel, setChannel] = useState<Channel | "">("");
  const [status, setStatus] = useState<ItemStatus | "">("");
  const stats = useStore(statsStore).data;
  const href = api.exportUrl({ channel: channel || undefined, status: status || undefined });
  // 概览统计里已经有各频道各状态的条数，不用再请求一次就能提前知道这次会不会超过单次上限
  const count = stats ? exportCount(stats.channels, channel || undefined, status || undefined) : undefined;
  return (
    <Card title="导出">
      <p class="muted">把条目导出成一个 JSON 文件（单次最多 {formatCount(EXPORT_LIMIT)} 条）。可以原样导回来，也能当备份。</p>
      <div class="form-row">
        <Field label="列表">
          <select class="select" value={channel} onChange={(event) => setChannel(CHANNELS.find((c) => c === event.currentTarget.value) ?? "")}>
            <option value="">全部</option>
            {CHANNELS.map((c) => (
              <option key={c} value={c}>
                {CHANNEL_NAMES[c]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="状态">
          <select class="select" value={status} onChange={(event) => setStatus(ITEM_STATUSES.find((s) => s === event.currentTarget.value) ?? "")}>
            <option value="">全部</option>
            {ITEM_STATUSES.map((s) => (
              <option key={s} value={s}>
                {ITEM_STATUS_NAMES[s]}
              </option>
            ))}
          </select>
        </Field>
      </div>
      {count !== undefined ? (
        <p class="small muted">
          这个范围里一共有 <strong>{formatCount(count)}</strong> 条。
        </p>
      ) : null}
      {count !== undefined && willBeTruncated(count) ? (
        <Notice tone="warn">
          超过单次 {formatCount(EXPORT_LIMIT)} 条的上限，下载的文件只会包含前 {formatCount(EXPORT_LIMIT)} 条（文件里会标 truncated: true）。请按「列表 / 状态」分开导出。
        </Notice>
      ) : null}
      <a class="btn btn-primary" href={href} download>
        <Icon name="download" size={14} />
        下载 JSON
      </a>
    </Card>
  );
}

// ———— 导入任务（文件导入和 GitLab 导入共用一个进度面板）————

interface ImportJob {
  title: string;
  batches: ImportBatch[];
  /** 整个导入共用的基准时间；中断后续导沿用它，顺序才不会乱。 */
  base: number;
  phase: "running" | "done" | "stopped" | "error";
  /** 已经发完几批。 */
  done: number;
  totals: ImportTotals;
  error?: string;
  notes: string[];
}

function JobPanel({ job, onStop, onResume, onClose }: { job: ImportJob; onStop: () => void; onResume: () => void; onClose: () => void }) {
  const total = job.batches.length;
  const pct = percent(job.done, total);
  const canResume = (job.phase === "error" || job.phase === "stopped") && job.done < total && canResumeImport(job.base, Date.now());
  const heading =
    job.phase === "running" ? "导入中…" : job.phase === "done" ? "导入完成" : job.phase === "stopped" ? "已停止" : "导入中断了";
  return (
    <Card
      title={`${heading}　${job.title}`}
      actions={
        job.phase === "running" ? (
          <button type="button" class="btn btn-sm" onClick={onStop}>
            停止
          </button>
        ) : (
          <button type="button" class="btn btn-sm btn-ghost" onClick={onClose}>
            关闭
          </button>
        )
      }
    >
      <div class="progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label="导入进度">
        <div class="progress-bar" style={{ width: `${pct}%` }} />
      </div>
      <p class="muted small">
        第 {Math.min(job.done + (job.phase === "running" ? 1 : 0), total)} / {total} 批（每批最多 500 条）
      </p>
      <dl class="result-grid">
        <div>
          <dt>收到</dt>
          <dd>{formatCount(job.totals.received)}</dd>
        </div>
        <div>
          <dt>新增</dt>
          <dd class="text-ok">{formatCount(job.totals.inserted)}</dd>
        </div>
        <div>
          <dt>跳过（已存在）</dt>
          <dd>{formatCount(job.totals.skipped)}</dd>
        </div>
        <div>
          <dt>不合格</dt>
          <dd class={job.totals.invalid > 0 ? "text-danger" : undefined}>{formatCount(job.totals.invalid)}</dd>
        </div>
      </dl>
      {job.notes.map((note) => (
        <p class="muted small" key={note}>
          {note}
        </p>
      ))}
      {job.totals.samples.length > 0 ? (
        <div class="samples">
          <div class="strong small">不合格的样例（前 {job.totals.samples.length} 个）</div>
          <ul>
            {job.totals.samples.map((sample, index) => (
              <li key={index}>
                第 {sample.position} 条：{sample.reason}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {job.phase === "error" ? <Notice tone="error">导入中途出错：{job.error}。已导入的部分已经生效。</Notice> : null}
      {canResume ? (
        <div class="button-row">
          <button type="button" class="btn btn-primary" onClick={onResume}>
            从第 {job.done + 1} 批接着导入
          </button>
          <span class="muted small">沿用同一个排序基准，接着导也不会打乱列表顺序。</span>
        </div>
      ) : null}
      {(job.phase === "error" || job.phase === "stopped") && job.done < total && !canResume ? <p class="muted small">距离开始已经超过一天，没法接着导了，请重新选文件导入（已存在的会自动跳过）。</p> : null}
    </Card>
  );
}

// ———— 从文件导入 ————

interface PickedFile {
  name: string;
  size: number;
  items: unknown[];
  format: "export" | "array";
  truncated: boolean;
  summary: FileSummary;
}

function FileImportCard({ busy, onStart }: { busy: boolean; onStart: (title: string, batches: ImportBatch[], notes: string[]) => void }) {
  const [picked, setPicked] = useState<PickedFile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [channel, setChannel] = useState<Channel | "file">("user");
  const [status, setStatus] = useState<ImportStatus>("approved");
  const [onlyLive, setOnlyLive] = useState(true);
  const [reading, setReading] = useState(false);

  async function pick(file: File | undefined): Promise<void> {
    setPicked(null);
    setError(null);
    if (!file) return;
    setReading(true);
    try {
      const parsed = parseImportFile(await file.text());
      if (!parsed.ok) {
        setError(parsed.error);
        return;
      }
      const summary = summarizeFile(parsed.file.items);
      setPicked({ name: file.name, size: file.size, items: parsed.file.items, format: parsed.file.format, truncated: parsed.file.truncated, summary });
      // 本站导出的文件：条目自带频道和状态，默认按它们来；原作者的列表没有，默认进网友推荐
      setChannel(summary.byChannel.user + summary.byChannel.author > 0 && summary.noChannel === 0 ? "file" : "user");
      setOnlyLive(summary.hasStatus);
    } catch {
      setError("读取文件失败");
    } finally {
      setReading(false);
    }
  }

  const plan = useMemo(() => (picked ? planImport(picked.items, { channel, status, onlyLive }) : null), [picked, channel, status, onlyLive]);
  const hasChannelField = picked ? picked.summary.byChannel.user + picked.summary.byChannel.author > 0 : false;

  async function start(): Promise<void> {
    if (!picked || !plan || plan.selected === 0) return;
    const where = channel === "file" ? `按文件里的频道（网友推荐 ${plan.byChannel.user} 条、作者精选 ${plan.byChannel.author} 条）` : `「${CHANNEL_NAMES[channel]}」`;
    const ok = await confirmDialog({
      title: `导入 ${formatCount(plan.selected)} 条？`,
      body: (
        <>
          <p>
            把「{picked.name}」里的 {formatCount(plan.selected)} 条导入到{where}，导入后{status === "approved" ? "直接上线，会出现在公开列表里" : "先放进待审"}。
          </p>
          <p class="muted">已经存在的番号会自动跳过；顺序保持和文件里一致（文件里第一条排最前）。</p>
        </>
      ),
      confirmLabel: `导入 ${formatCount(plan.selected)} 条`,
    });
    if (!ok) return;
    const notes: string[] = [];
    if (plan.skippedNotLive > 0) notes.push(`文件里有 ${formatCount(plan.skippedNotLive)} 条的状态不是「已上线」，按你的选择跳过了。`);
    if (plan.unassigned > 0) notes.push(`有 ${formatCount(plan.unassigned)} 条没标频道，没法归类，已忽略。`);
    onStart(`从文件「${picked.name}」导入`, plan.batches, notes);
  }

  return (
    <Card title="从文件导入">
      <p class="muted">选一个 JSON 文件：本站导出的文件，或者一个条目数组 {"[{ code, info, src, link }, …]"}。每 500 条一批导入，已存在的番号跳过。</p>
      <Field label="选择文件">
        <input class="input" type="file" accept=".json,application/json" disabled={busy || reading} onChange={(event) => void pick(event.currentTarget.files?.[0])} />
      </Field>
      {reading ? (
        <p class="muted">
          <Spinner /> 读取中…
        </p>
      ) : null}
      {error ? <Notice tone="error">{error}</Notice> : null}
      {picked && plan ? (
        <>
          <Notice tone="info">
            「{picked.name}」共 {formatCount(picked.summary.total)} 条（{picked.format === "export" ? "本站导出的文件" : "条目数组"}
            {hasChannelField ? `，网友推荐 ${picked.summary.byChannel.user}、作者精选 ${picked.summary.byChannel.author}` : ""}
            {picked.summary.hasStatus
              ? `；${Object.entries(picked.summary.byStatus)
                  .map(([key, count]) => `${ITEM_STATUSES.find((s) => s === key) ? ITEM_STATUS_NAMES[key as ItemStatus] : key} ${count}`)
                  .join("、")}`
              : ""}
            ）。
          </Notice>
          {picked.truncated ? <Notice tone="warn">这个文件是导出时被截断的（当时超过单次 {formatCount(EXPORT_LIMIT)} 条，文件里不是全部条目）。缺的部分要回去按「列表 / 状态」分开再导一次。</Notice> : null}
          <div class="form-row">
            <Field label="导入到">
              <select class="select" value={channel} onChange={(event) => setChannel(event.currentTarget.value === "file" ? "file" : event.currentTarget.value === "author" ? "author" : "user")}>
                <option value="user">网友推荐</option>
                <option value="author">作者精选</option>
                {hasChannelField ? <option value="file">按文件里每条的频道</option> : null}
              </select>
            </Field>
            <Field label="导入后的状态">
              <select class="select" value={status} onChange={(event) => setStatus(event.currentTarget.value === "pending" ? "pending" : "approved")}>
                <option value="approved">直接上线</option>
                <option value="pending">先放进待审</option>
              </select>
            </Field>
          </div>
          {picked.summary.hasStatus ? (
            <Check checked={onlyLive} onChange={setOnlyLive}>
              只导入文件里状态是「已上线」的（已隐藏 / 已拒绝 / 待审的跳过，免得被隐藏的又上线了）
            </Check>
          ) : null}
          <p class="small">
            将导入 <strong>{formatCount(plan.selected)}</strong> 条，分 {plan.batches.length} 批
            {plan.skippedNotLive > 0 ? `；跳过 ${formatCount(plan.skippedNotLive)} 条（状态不是已上线）` : ""}
            {plan.unassigned > 0 ? `；${formatCount(plan.unassigned)} 条没标频道，无法归类` : ""}。
          </p>
          <button type="button" class="btn btn-primary" disabled={busy || plan.selected === 0} onClick={() => void start()}>
            <Icon name="upload" size={14} />
            开始导入
          </button>
        </>
      ) : null}
    </Card>
  );
}

// ———— 导入原作者的 GitLab 列表 ————

const REMOTE_LISTS: readonly { channel: Channel; file: string; url: string }[] = [
  { channel: "author", file: "Rec", url: "https://gitlab.com/Nicked639/javrev/raw/master/Rec" },
  { channel: "user", file: "RecBot", url: "https://gitlab.com/Nicked639/javrev/raw/master/RecBot" },
];

interface Fetched {
  channel: Channel;
  file: string;
  /** 服务端原样返回的条目（只做过最便宜的结构检查），逐条校验在导入时做。 */
  items: FetchedItem[];
  /** 下载时就丢掉的：连基本结构都不对（不是对象，或缺少番号 / 详情页地址）。 */
  invalid: number;
}

function GitlabCard({ busy, onStart }: { busy: boolean; onStart: (title: string, batches: ImportBatch[], notes: string[]) => void }) {
  const [fetching, setFetching] = useState<Channel | null>(null);
  const [fetched, setFetched] = useState<Fetched | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<ImportStatus>("approved");

  async function fetchList(list: (typeof REMOTE_LISTS)[number]): Promise<void> {
    setFetching(list.channel);
    setError(null);
    setFetched(null);
    try {
      const result = await api.fetchRemote(list.url);
      setFetched({ channel: list.channel, file: list.file, items: result.items, invalid: result.invalid });
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setFetching(null);
    }
  }

  function start(): void {
    if (!fetched || fetched.items.length === 0) return;
    const plan = planImport(fetched.items, { channel: fetched.channel, status, onlyLive: false });
    const notes = [`逐条的校验（番号格式、地址、过长的标题截断）在导入时做，上面「不合格」里说的「第几条」是下载到的列表里的第几条。`];
    if (fetched.invalid > 0) notes.unshift(`下载时就丢掉了 ${formatCount(fetched.invalid)} 条连基本结构都不对的（不是对象，或缺少番号 / 详情页地址）。`);
    onStart(`原作者的「${CHANNEL_NAMES[fetched.channel]}」列表（${fetched.file}）`, plan.batches, notes);
    setFetched(null);
  }

  return (
    <Card title="导入原作者的列表（GitLab）">
      <p class="muted">从原作者在 GitLab 上公开的两份列表下载条目（由服务器代为下载），确认数量后再导入。已存在的番号会跳过，列表顺序保持和对方一致。</p>
      <div class="button-row">
        {REMOTE_LISTS.map((list) => (
          <button key={list.channel} type="button" class="btn" disabled={busy || fetching !== null} onClick={() => void fetchList(list)}>
            {fetching === list.channel ? <Spinner /> : <Icon name="download" size={14} />}
            {CHANNEL_NAMES[list.channel]} ← {list.file}
          </button>
        ))}
      </div>
      <p class="muted small">
        {REMOTE_LISTS.map((list) => (
          <span key={list.channel} class="mono block">
            {CHANNEL_NAMES[list.channel]}：{list.url}
          </span>
        ))}
      </p>
      {error ? <Notice tone="error">{error.startsWith("下载失败") ? error : `下载失败：${error}`}</Notice> : null}
      {fetched ? (
        <div class="fetched-box">
          <Notice tone={fetched.items.length > 0 ? "ok" : "warn"}>
            从 {fetched.file} 下载到 <strong>{formatCount(fetched.items.length)}</strong> 条
            {fetched.invalid > 0 ? `（另有 ${formatCount(fetched.invalid)} 条连基本结构都不对，已丢掉）` : ""}。
            {fetched.items.length > 0 ? "导入时才会逐条校验，不合格的会在导入结果里统计出来。" : ""}
          </Notice>
          {fetched.items.length > 0 ? (
            <div class="button-row">
              <label class="inline-field">
                <span class="muted">导入后的状态</span>
                <select class="select" value={status} onChange={(event) => setStatus(event.currentTarget.value === "pending" ? "pending" : "approved")}>
                  <option value="approved">直接上线</option>
                  <option value="pending">先放进待审</option>
                </select>
              </label>
              <button type="button" class="btn btn-primary" disabled={busy} onClick={start}>
                导入 {formatCount(fetched.items.length)} 条到「{CHANNEL_NAMES[fetched.channel]}」
              </button>
              <button type="button" class="btn btn-ghost" onClick={() => setFetched(null)}>
                取消
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </Card>
  );
}

// ———— 页面 ————

export function DataPage() {
  const [job, setJob] = useState<ImportJob | null>(null);
  const stopRef = useRef(false);
  const running = job?.phase === "running";
  useLeaveGuard(running);

  async function execute(current: ImportJob, startIndex: number, totals: ImportTotals): Promise<void> {
    stopRef.current = false;
    setJob({ ...current, phase: "running", error: undefined });
    try {
      const { stopped } = await runImport(current.batches, {
        base: current.base,
        startIndex,
        totals,
        send: (batch, order) => api.importItems({ channel: batch.channel, status: batch.status, items: batch.items, order }),
        shouldStop: () => stopRef.current,
        onProgress: (progress) => setJob((j) => (j ? { ...j, phase: "running", done: progress.done, totals: progress.totals } : j)),
      });
      setJob((j) => (j ? { ...j, phase: stopped ? "stopped" : "done" } : j));
      if (!stopped) toast.success("导入完成");
    } catch (error) {
      setJob((j) => (j ? { ...j, phase: "error", error: errorMessage(error) } : j));
    } finally {
      void refreshStats();
    }
  }

  function start(title: string, batches: ImportBatch[], notes: string[]): void {
    // base 在整个导入开始时取一次，之后每一批都用它（顺序只看位置，和发送顺序、重试无关）
    const fresh: ImportJob = { title, batches, base: Date.now(), phase: "running", done: 0, totals: emptyTotals(), notes };
    void execute(fresh, 0, fresh.totals);
  }

  return (
    <>
      <PageHeader title="导入导出" subtitle="备份、迁移，或者一次性导入一份现成的列表。" />
      {job ? <JobPanel job={job} onStop={() => (stopRef.current = true)} onResume={() => void execute(job, job.done, job.totals)} onClose={() => setJob(null)} /> : null}
      <ExportCard />
      <FileImportCard busy={running} onStart={start} />
      <GitlabCard busy={running} onStart={start} />
    </>
  );
}
