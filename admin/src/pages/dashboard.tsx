// 概览：待办数字（点进去就是对应的筛选列表）、两份列表各状态的条数、最近一次检查、最近 30 天每天新增的柱状图。

import type { ComponentChildren } from "preact";
import { useState } from "preact/hooks";

import { CHANNELS, CHANNEL_NAMES, ITEM_STATUSES, ITEM_STATUS_NAMES, type ItemStatus, type StatsDTO } from "../../../shared/types";
import { chartLayout } from "../lib/chart";
import { formatCount } from "../lib/format";
import { shortDay } from "../lib/time";
import { TRIGGER_NAMES } from "../lib/names";
import { Badge, Card, ErrorState, Loading, PageHeader, TimeCell } from "../ui/components";
import { useElementWidth } from "../ui/hooks";
import { Icon } from "../ui/icons";
import { linkTo } from "../ui/router";
import { useCan } from "../ui/session";
import { pendingTotal, refreshStats, statsStore } from "../ui/stats";
import { useStore } from "../ui/store";

function StatCard({ label, value, href, tone, note }: { label: string; value: number; href?: string; tone?: "warn" | "danger" | "ok"; note?: string }) {
  const body = (
    <>
      <div class="stat-label">{label}</div>
      <div class={`stat-value ${tone ? `is-${tone}` : ""}`}>{formatCount(value)}</div>
      {note ? <div class="stat-note muted">{note}</div> : null}
    </>
  );
  return href ? (
    <a class="stat-card is-link" href={href}>
      {body}
    </a>
  ) : (
    <div class="stat-card">{body}</div>
  );
}

/** 最近 30 天每天新增条数：手写 SVG。宽度跟着容器走（量出来再算坐标），文字大小才不会随屏幕缩放变形。 */
function SubmissionsChart({ days }: { days: StatsDTO["submissionsByDay"] }) {
  const [ref, measured] = useElementWidth<HTMLDivElement>();
  const [active, setActive] = useState<number | null>(null);
  const width = Math.max(measured, 260);
  const height = 190;
  const layout = chartLayout(
    days.map((d) => d.count),
    width,
    height,
  );
  const total = days.reduce((sum, d) => sum + d.count, 0);
  const labelIndexes = new Set([0, 7, 14, 21, days.length - 1]);
  const shown = active === null ? undefined : days[active];
  const bar = active === null ? undefined : layout.bars[active];

  return (
    <div class="chart" ref={ref}>
      <svg class="chart-svg" width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`最近 ${days.length} 天每天新增的条目数，一共 ${total} 条`}>
        {layout.ticks.map((tick) => (
          <g key={tick.y}>
            <line class="chart-grid" x1={layout.plot.left} x2={layout.plot.left + layout.plot.width} y1={tick.y} y2={tick.y} />
            <text class="chart-tick" x={layout.plot.left - 6} y={tick.y + 4} text-anchor="end">
              {tick.value}
            </text>
          </g>
        ))}
        {layout.bars.map((b) => (
          <rect key={b.index} class={`chart-bar ${active === b.index ? "is-active" : ""}`} x={b.x} y={b.y} width={b.width} height={Math.max(b.height, b.value > 0 ? 1 : 0)} rx="2" />
        ))}
        {days.map((d, index) => (
          <text key={d.day} class="chart-label" x={layout.plot.left + layout.slot * index + layout.slot / 2} y={height - 6} text-anchor="middle" opacity={labelIndexes.has(index) ? 1 : 0}>
            {shortDay(d.day)}
          </text>
        ))}
        {/* 每个槽一块透明的感应区：鼠标悬停 / 键盘聚焦 / 触屏点按都能看数字，0 的那天也点得到 */}
        {days.map((d, index) => (
          <rect
            key={`hit-${d.day}`}
            class="chart-hit"
            x={layout.plot.left + layout.slot * index}
            y={layout.plot.top}
            width={layout.slot}
            height={layout.plot.height}
            tabIndex={0}
            role="img"
            aria-label={`${d.day}：${d.count} 条`}
            onMouseEnter={() => setActive(index)}
            onMouseLeave={() => setActive((current) => (current === index ? null : current))}
            onFocus={() => setActive(index)}
            onBlur={() => setActive((current) => (current === index ? null : current))}
            onClick={() => setActive((current) => (current === index ? null : index))}
          >
            <title>{`${d.day}：${d.count} 条`}</title>
          </rect>
        ))}
      </svg>
      {shown && bar ? (
        <div class="chart-tip" style={{ left: Math.min(Math.max(bar.x + bar.width / 2, 56), width - 56) }} role="status">
          <strong>{shown.day}</strong>
          <span>新增 {formatCount(shown.count)} 条</span>
        </div>
      ) : null}
    </div>
  );
}

export function DashboardPage() {
  const state = useStore(statsStore);
  const canModerate = useCan("items.moderate");
  const canReports = useCan("reports.resolve");
  const canChecks = useCan("checks.run");
  const stats = state.data;

  const refresh = (
    <button type="button" class="btn" onClick={() => void refreshStats()} disabled={state.loading}>
      <Icon name="refresh" size={14} />
      刷新
    </button>
  );

  if (!stats) {
    return (
      <>
        <PageHeader title="概览" actions={refresh} />
        {state.error ? <ErrorState error={state.error} onRetry={() => void refreshStats()} /> : <Loading />}
      </>
    );
  }

  const pending = pendingTotal(stats);
  const total30 = stats.submissionsByDay.reduce((sum, d) => sum + d.count, 0);
  const cell = (channel: (typeof CHANNELS)[number], status: ItemStatus): ComponentChildren => (
    <a href={linkTo("/items", { channel, status })}>{formatCount(stats.channels[channel][status])}</a>
  );

  return (
    <>
      <PageHeader title="概览" subtitle={`共 ${stats.maintainers} 位维护者在维护`} actions={refresh} />

      <div class={`stat-grid ${state.loading ? "is-loading" : ""}`}>
        <StatCard label="待审条目" value={pending} href={canModerate ? linkTo("/review") : undefined} tone={pending > 0 ? "warn" : undefined} note={pending > 0 ? "等你审核" : "没有积压"} />
        <StatCard label="未处理举报" value={stats.openReports} href={canReports ? linkTo("/reports") : undefined} tone={stats.openReports > 0 ? "danger" : undefined} note="按条目计" />
        <StatCard label="检查失效" value={stats.checks.dead} href={linkTo("/items", { check: "dead" })} tone={stats.checks.dead > 0 ? "danger" : undefined} note="已上线的条目里" />
        <StatCard label="检查存疑" value={stats.checks.warn} href={linkTo("/items", { check: "warn" })} tone={stats.checks.warn > 0 ? "warn" : undefined} note="已上线的条目里" />
        <StatCard label="网友推荐 · 已上线" value={stats.channels.user.approved} href={linkTo("/items", { channel: "user", status: "approved" })} />
        <StatCard label="作者精选 · 已上线" value={stats.channels.author.approved} href={linkTo("/items", { channel: "author", status: "approved" })} />
      </div>

      <div class="grid-2">
        <Card title="各列表各状态的条数">
          <div class="table-wrap">
            <table class="table table-compact">
              <thead>
                <tr>
                  <th scope="col">列表</th>
                  {ITEM_STATUSES.map((status) => (
                    <th scope="col" key={status}>
                      {ITEM_STATUS_NAMES[status]}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {CHANNELS.map((channel) => (
                  <tr key={channel}>
                    <th scope="row" data-label="列表">
                      {CHANNEL_NAMES[channel]}
                    </th>
                    {ITEM_STATUSES.map((status) => (
                      <td key={status} data-label={ITEM_STATUS_NAMES[status]}>
                        {cell(channel, status)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>

        <Card title="最近一次检查" actions={canChecks ? <a href={linkTo("/checks")}>检查记录 →</a> : undefined}>
          {stats.lastCheck ? (
            <dl class="kv">
              <dt>时间</dt>
              <dd>
                <TimeCell ms={stats.lastCheck.startedAt} />
              </dd>
              <dt>方式</dt>
              <dd>
                <Badge tone={stats.lastCheck.trigger === "cron" ? "gray" : "blue"}>{TRIGGER_NAMES[stats.lastCheck.trigger]}</Badge> {stats.lastCheck.by ? `（${stats.lastCheck.by}）` : ""}
              </dd>
              <dt>结果</dt>
              <dd>
                {stats.lastCheck.finishedAt === null ? (
                  <span class="muted">这一批没有跑完（可能被中断了），结果没有记下来。</span>
                ) : (
                  <>
                    查了 {stats.lastCheck.examined} 个：<span class="text-ok">正常 {stats.lastCheck.ok}</span>、<span class="text-warn">存疑 {stats.lastCheck.warn}</span>、
                    <span class="text-danger">失效 {stats.lastCheck.dead}</span>
                    {stats.lastCheck.hidden > 0 ? `，自动隐藏 ${stats.lastCheck.hidden}` : ""}
                  </>
                )}
              </dd>
              {stats.lastCheck.note ? (
                <>
                  <dt>备注</dt>
                  <dd>{stats.lastCheck.note}</dd>
                </>
              ) : null}
            </dl>
          ) : (
            <p class="muted">还没有检查过。定时任务每 30 分钟查一批，也可以在「自动检查」里手动查。</p>
          )}
        </Card>
      </div>

      <Card title="最近 30 天每天新增" actions={<span class="muted small">共 {formatCount(total30)} 条（按 UTC 日期）</span>}>
        <SubmissionsChart days={stats.submissionsByDay} />
      </Card>
    </>
  );
}
