// 自动检查：规则说明、「检查一批 / 全部检查」、最近 30 次运行记录、失效和存疑条目的待复核列表。

import { useRef, useState } from "preact/hooks";

import type { CheckRunDTO, ItemDTO } from "../../../shared/types";
import { api } from "../api";
import { emptyCheckTotals, runAllChecks, type CheckAllProgress } from "../lib/check-all";
import { errorMessage } from "../lib/errors";
import { formatCount, hostOf } from "../lib/format";
import { TRIGGER_NAMES } from "../lib/names";
import { Async, Badge, Card, EmptyState, ExternalLink, Notice, PageHeader, TimeCell } from "../ui/components";
import { CopyText } from "../ui/copy";
import { confirmDialog } from "../ui/dialogs";
import { useBusy, useLeaveGuard, useResource } from "../ui/hooks";
import { Icon } from "../ui/icons";
import { Cover, EditItemDrawer, itemStatusBadge, useItemActions } from "../ui/items";
import { linkTo } from "../ui/router";
import { useCan } from "../ui/session";
import { refreshStats } from "../ui/stats";
import { toast } from "../ui/toast";

// ———— 待复核列表 ————

function ReviewList({ check, title, hint, version, onChanged }: { check: "dead" | "warn"; title: string; hint: string; version: number; onChanged: () => void }) {
  const res = useResource(() => api.items({ check, sort: "new", page: 1, pageSize: 20 }), [check, version]);
  const [editing, setEditing] = useState<ItemDTO | null>(null);
  // 操作完让父页面统一刷新（version 加一 → 两个列表和上面的数字一起重新加载）
  const actions = useItemActions(onChanged);

  return (
    <Card title={title} actions={<a href={linkTo("/items", { check })}>查看全部 →</a>}>
      <p class="muted small">{hint}</p>
      <Async res={res}>
        {(page) =>
          page.items.length === 0 ? (
            <EmptyState title={check === "dead" ? "没有失效的条目" : "没有存疑的条目"} />
          ) : (
            <>
              <div class="table-wrap">
                <table class="table table-compact">
                  <thead>
                    <tr>
                      <th scope="col">封面</th>
                      <th scope="col">番号 / 标题</th>
                      <th scope="col">检查结果</th>
                      <th scope="col">状态</th>
                      <th scope="col">
                        <span class="sr-only">操作</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {page.items.map((item) => (
                      <tr key={item.id}>
                        <td class="cell-cover" data-label="">
                          <Cover src={item.src} itemId={item.id} size="sm" label={`${item.code} 的封面`} />
                        </td>
                        <td data-label="番号">
                          <CopyText text={item.code} className="mono strong" />
                          <div class="small clamp-2">{item.info}</div>
                          <div class="small">
                            <ExternalLink href={item.link} className="host-link">
                              {hostOf(item.link) || "（地址无效）"} <Icon name="external" size={12} />
                            </ExternalLink>
                          </div>
                        </td>
                        <td data-label="检查结果">
                          {item.checkDetail || "—"}
                          <div class="small muted">
                            {item.checkFail > 0 ? `连续失效 ${item.checkFail} 次 · ` : ""}
                            <TimeCell ms={item.checkedAt} />
                          </div>
                        </td>
                        <td data-label="状态">{itemStatusBadge(item)}</td>
                        <td class="cell-actions" data-label="">
                          <div class="row-actions">
                            {item.status === "approved" ? (
                              <button type="button" class="btn btn-sm" disabled={actions.busy} onClick={() => void actions.setStatus([item.id], "hidden")}>
                                隐藏
                              </button>
                            ) : null}
                            <button type="button" class="btn btn-sm" disabled={actions.busy} onClick={() => void actions.check([item.id])}>
                              重新检查
                            </button>
                            <button type="button" class="btn btn-sm" onClick={() => setEditing(item)}>
                              编辑
                            </button>
                            <button type="button" class="btn btn-sm btn-danger" disabled={actions.busy} onClick={() => void actions.remove([item])}>
                              删除
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {page.total > page.items.length ? <p class="muted small">还有 {formatCount(page.total - page.items.length)} 个没列出来，处理完这些再刷新，或点右上角「查看全部」。</p> : null}
            </>
          )
        }
      </Async>
      {editing ? (
        <EditItemDrawer
          item={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            onChanged();
          }}
        />
      ) : null}
    </Card>
  );
}

// ———— 全部检查 ————

interface RunAllState {
  phase: "idle" | "running" | "done" | "stopped" | "error";
  progress: CheckAllProgress;
  error?: string;
}

const IDLE: RunAllState = { phase: "idle", progress: { totals: emptyCheckTotals(), remaining: 0, percent: 0, notes: [] } };

function RunAllPanel({ state, onStop }: { state: RunAllState; onStop: () => void }) {
  const { totals, remaining, percent, notes } = state.progress;
  const title =
    state.phase === "running" ? "全部检查进行中…" : state.phase === "done" ? "全部检查完成" : state.phase === "stopped" ? "已停止（已检查的结果都已保存）" : "全部检查中断了";
  return (
    <div class={`runall runall-${state.phase}`} role="status" aria-live="polite">
      <div class="runall-head">
        <strong>{title}</strong>
        {state.phase === "running" ? (
          <button type="button" class="btn btn-sm" onClick={onStop}>
            停止
          </button>
        ) : null}
      </div>
      <div class="progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} aria-label="全部检查进度">
        <div class="progress-bar" style={{ width: `${percent}%` }} />
      </div>
      <div class="runall-numbers">
        <span>
          已检查 <strong>{formatCount(totals.examined)}</strong> 个
        </span>
        {state.phase === "running" ? (
          <span>
            还剩 <strong>{formatCount(remaining)}</strong> 个
          </span>
        ) : null}
        <span class="text-ok">正常 {formatCount(totals.ok)}</span>
        <span class="text-warn">存疑 {formatCount(totals.warn)}</span>
        <span class="text-danger">失效 {formatCount(totals.dead)}</span>
        <span>自动隐藏 {formatCount(totals.hidden)}</span>
        <span class="muted">共 {totals.batches} 批</span>
      </div>
      {notes.length > 0 ? (
        <ul class="runall-notes muted small">
          {notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      ) : null}
      {state.phase === "error" ? <Notice tone="error">中途出错了：{state.error}。已经检查完的部分已保存，排除问题后可以再点「全部检查」接着查。</Notice> : null}
    </div>
  );
}

export function ChecksPage() {
  const canRunAll = useCan("checks.runAll");
  const [version, setVersion] = useState(0);
  const res = useResource(() => Promise.all([api.checks(), api.settings()]), [version]);
  const { busy, run } = useBusy();
  const [all, setAll] = useState<RunAllState>(IDLE);
  const stopRef = useRef(false);
  const running = all.phase === "running";
  useLeaveGuard(running);

  function refreshAll(): void {
    setVersion((v) => v + 1);
    void refreshStats();
  }

  async function runBatch(): Promise<void> {
    const result = await run(() => api.runChecks({}));
    if (!result) return;
    if (!result.run) toast.info("没有可检查的条目（还没有已上线的条目）");
    else {
      const r = result.run;
      toast.success(`检查了 ${r.examined} 个条目：正常 ${r.ok}、存疑 ${r.warn}、失效 ${r.dead}${r.hidden > 0 ? `，自动隐藏 ${r.hidden}` : ""}`);
    }
    refreshAll();
  }

  async function runAll(): Promise<void> {
    const ok = await confirmDialog({
      title: "检查全部条目？",
      body: (
        <>
          <p>会一批一批地检查所有已上线的条目（每个条目请求一次封面和一次详情页），条目多的话要几分钟。</p>
          <p class="muted">检查期间请保持这个页面打开；可以随时点「停止」，已经查完的结果都会保留。</p>
        </>
      ),
      confirmLabel: "开始全部检查",
    });
    if (!ok) return;
    stopRef.current = false;
    setAll({ ...IDLE, phase: "running" });
    try {
      const outcome = await runAllChecks({
        startedAt: Date.now(),
        call: (olderThan) => api.runChecks({ olderThan }),
        shouldStop: () => stopRef.current,
        onProgress: (progress) => setAll((s) => ({ ...s, progress })),
      });
      setAll((s) => ({ ...s, phase: outcome.stopped ? "stopped" : "done" }));
    } catch (error) {
      setAll((s) => ({ ...s, phase: "error", error: errorMessage(error) }));
    } finally {
      refreshAll();
    }
  }

  return (
    <>
      <PageHeader title="自动检查" subtitle="定期去看条目的封面和详情页还在不在，失效的自动隐藏。" />

      <Async res={res}>
        {([checks, { settings }]) => (
          <>
            <Card title="规则">
              <ul class="rules">
                <li>
                  封面和详情页地址各请求一次。<strong>HTTP 404 / 410 判为「失效」</strong>；2xx 判为「正常」（封面还要求返回的是图片）；
                  <strong>其余（403 / 429 / 5xx、超时、网络错误、封面返回了网页）判为「存疑」</strong>，只做标记，因为站点拒绝机器访问是常事。
                </li>
                <li>
                  有的站点（JavBus 一类）没有年龄验证的 cookie 时，所有详情页都会先跳到年龄验证页并返回 200，看不到真实页面，判「正常」是假信号。
                  这样的链接<strong>没法检查，不参与判定、只看封面</strong>（封面正常就是「正常」）；
                  如果一项都没法判断（只剩被挡住的链接，或没有可查的地址），条目记成<strong>「没查成」</strong>，原因写在检查结果的说明里（鼠标悬停在结果上能看到）。
                  它不是「正常」（不会清零失效计数、不会触发自动恢复），也不是问题，不用处理。带说明的「正常」同理。
                </li>
                <li>
                  自动隐藏有三道保险：① 连续失效 <strong>{settings.checkFailThreshold}</strong> 次才隐藏（{settings.checkAutoHide ? "「失效自动隐藏」已开启" : "「失效自动隐藏」已关闭，只标记不隐藏"}）；
                  ② 「连续」要隔得开，两次失效之间至少隔半个复查间隔才都算数；
                  ③ 一批里几乎全判成失效（≥ 5 条且 ≥ 80%）会整批改判「存疑」、不累计（手动指定条目时没有这条）——多半是服务器这边出了网络问题。
                  因失效被隐藏的，恢复正常后自动放回来。
                </li>
                <li>
                  定时任务{settings.checksEnabled ? "每 30 分钟查一批" : "已关闭"}（每批 {settings.checkBatchSize} 个，复查间隔 {settings.checkIntervalDays} 天）。这些都能在{" "}
                  <a href={linkTo("/settings")}>站点设置</a> 里改。
                </li>
              </ul>
              {!settings.checkCover && !settings.checkLink ? <Notice tone="warn">封面和详情页的检查现在都关着，手动检查也会被拒绝；先去设置里打开至少一项。</Notice> : null}
            </Card>

            <Card
              title="立即检查"
              actions={
                <span class="muted small">
                  按复查间隔，还有 <strong>{formatCount(checks.remaining)}</strong> 个条目到期没查
                </span>
              }
            >
              <div class="button-row">
                <button type="button" class="btn btn-primary" disabled={busy || running} onClick={() => void runBatch()}>
                  <Icon name="activity" size={14} />
                  {busy ? "检查中…（可能要十几秒）" : "检查一批"}
                </button>
                {canRunAll ? (
                  <button type="button" class="btn" disabled={busy || running} onClick={() => void runAll()}>
                    全部检查
                  </button>
                ) : null}
                <span class="muted small">「检查一批」查最久没查过的 {settings.checkBatchSize} 个（一批最多 25 个）。{canRunAll ? "" : "「全部检查」需要管理员权限。"}</span>
              </div>
              {all.phase !== "idle" ? <RunAllPanel state={all} onStop={() => (stopRef.current = true)} /> : null}
            </Card>

            <Card title="最近 30 次检查">
              {checks.runs.length === 0 ? (
                <EmptyState title="还没有检查记录" hint="点上面的「检查一批」，或者等定时任务跑第一批。" />
              ) : (
                <div class="table-wrap">
                  <table class="table table-compact">
                    <thead>
                      <tr>
                        <th scope="col">开始时间</th>
                        <th scope="col">方式</th>
                        <th scope="col">操作人</th>
                        <th scope="col" class="num">
                          查了
                        </th>
                        <th scope="col" class="num">
                          正常
                        </th>
                        <th scope="col" class="num">
                          存疑
                        </th>
                        <th scope="col" class="num">
                          失效
                        </th>
                        <th scope="col" class="num">
                          自动隐藏
                        </th>
                        <th scope="col">备注</th>
                      </tr>
                    </thead>
                    <tbody>
                      {checks.runs.map((item: CheckRunDTO) => (
                        <tr key={item.id}>
                          <td data-label="开始时间">
                            <TimeCell ms={item.startedAt} seconds />
                          </td>
                          <td data-label="方式">
                            <Badge tone={item.trigger === "cron" ? "gray" : "blue"}>{TRIGGER_NAMES[item.trigger]}</Badge>
                            {item.finishedAt === null ? <span class="muted small"> 未完成</span> : null}
                          </td>
                          <td data-label="操作人">{item.by ?? <span class="muted">系统</span>}</td>
                          <td class="num" data-label="查了">
                            {item.examined}
                          </td>
                          <td class="num text-ok" data-label="正常">
                            {item.finishedAt === null ? "—" : item.ok}
                          </td>
                          <td class="num text-warn" data-label="存疑">
                            {item.finishedAt === null ? "—" : item.warn}
                          </td>
                          <td class="num text-danger" data-label="失效">
                            {item.finishedAt === null ? "—" : item.dead}
                          </td>
                          <td class="num" data-label="自动隐藏">
                            {item.finishedAt === null ? "—" : item.hidden}
                          </td>
                          <td data-label="备注">{item.note || <span class="muted">—</span>}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>
          </>
        )}
      </Async>

      <h2 class="section-title">待复核</h2>
      <p class="muted">检查判成失效或存疑的条目（各列前 20 个）。失效的先确认是真的没了，再删除或隐藏；存疑的多半是站点拒绝机器访问，人工点开看一眼。</p>
      <ReviewList check="dead" title="失效" hint="封面或详情页返回了 404 / 410。连续失效达到阈值会被自动隐藏。" version={version} onChanged={refreshAll} />
      <ReviewList check="warn" title="存疑" hint="403 / 429 / 5xx、超时、网络错误，或封面返回的不是图片。不会自动隐藏。" version={version} onChanged={refreshAll} />
    </>
  );
}
