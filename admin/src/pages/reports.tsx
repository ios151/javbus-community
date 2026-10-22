// 举报：未处理的按条目分组（同一个条目的多条举报合并成一张卡片，看得到各原因计数、举报人数和详情文字），
// 每组一次处理（隐藏条目 / 驳回举报 / 删除条目）；已处理、已驳回的按时间平铺，只读。

import { useMemo } from "preact/hooks";

import { CHANNEL_NAMES, REPORT_REASON_NAMES, type Paged, type ReportDTO, type ReportStatus } from "../../../shared/types";
import { api, type ResolveAction } from "../api";
import { formatCount, truncate } from "../lib/format";
import { REPORT_STATUS_NAMES } from "../lib/names";
import { groupReports, type ReportGroup } from "../lib/report-groups";
import { Async, Badge, ChannelBadge, EmptyState, Notice, PageHeader, StatusBadge, TimeCell } from "../ui/components";
import { Pager, Tabs, type TabDef } from "../ui/controls";
import { confirmDialog } from "../ui/dialogs";
import { useBusy, useResource } from "../ui/hooks";
import { Icon } from "../ui/icons";
import { Cover } from "../ui/items";
import { linkTo, navigate, useRoute } from "../ui/router";
import { refreshStats } from "../ui/stats";
import { toast } from "../ui/toast";

const STATUSES: readonly ReportStatus[] = ["open", "resolved", "dismissed"];
/** 未处理的要全部取回来才好分组：一页 100 条，最多取这么多页（超过的提示「只显示了前面一部分」）。 */
const MAX_OPEN_PAGES = 10;
const PAGE_SIZE = 100;
const LIST_PAGE_SIZE = 50;

interface OpenData {
  reports: ReportDTO[];
  total: number;
}

async function loadOpenReports(): Promise<OpenData> {
  const first = await api.reports({ status: "open", page: 1, pageSize: PAGE_SIZE });
  const reports = [...first.items];
  for (let page = 2; page <= MAX_OPEN_PAGES && reports.length < first.total; page++) {
    reports.push(...(await api.reports({ status: "open", page, pageSize: PAGE_SIZE })).items);
  }
  return { reports, total: first.total };
}

const ACTION_TEXT: Record<ResolveAction, { done: string; busy: string }> = {
  hide: { done: "已隐藏条目", busy: "隐藏中…" },
  dismiss: { done: "已驳回举报", busy: "处理中…" },
  delete: { done: "已删除条目", busy: "删除中…" },
};

function GroupCard({ group, onAction, busy }: { group: ReportGroup; onAction: (group: ReportGroup, action: ResolveAction) => void; busy: boolean }) {
  return (
    <li class="report-card">
      <Cover src={group.src} itemId={group.itemId} size="lg" label={`${group.code} 的封面`} />
      <div class="report-main">
        <div class="report-title">
          <span class="mono strong">{group.code}</span>
          <ChannelBadge channel={group.channel} />
          <StatusBadge status={group.itemStatus} />
          <span class="report-count" title="按举报人（设备号；没带设备号的按 IP）去重。自动隐藏按「不同的 IP」算，换设备号不算多个人。">
            <strong>{group.reporters}</strong> 人举报
          </span>
        </div>
        <div class="report-info">{group.info}</div>
        <div class="report-reasons">
          {group.reasons.map(({ reason, count }) => (
            <Badge key={reason} tone={reason === "inappropriate" ? "red" : reason === "dead" ? "orange" : "gray"}>
              {REPORT_REASON_NAMES[reason]} × {count}
            </Badge>
          ))}
          <span class="muted small inline-time">
            最近一次 <TimeCell ms={group.latestAt} />
          </span>
        </div>
        {group.details.length > 0 ? (
          <ul class="report-details">
            {group.details.map((detail) => (
              <li key={detail.id}>
                <span class="muted">{REPORT_REASON_NAMES[detail.reason]}：</span>
                {truncate(detail.text, 300)}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      <div class="report-actions">
        <button type="button" class="btn btn-sm" disabled={busy} onClick={() => onAction(group, "hide")}>
          隐藏条目
        </button>
        <button type="button" class="btn btn-sm" disabled={busy} onClick={() => onAction(group, "dismiss")}>
          驳回举报
        </button>
        <button type="button" class="btn btn-sm btn-danger" disabled={busy} onClick={() => onAction(group, "delete")}>
          <Icon name="trash" size={14} />
          删除条目
        </button>
        <a class="btn btn-sm btn-ghost" href={linkTo("/items", { q: group.code, channel: group.channel })}>
          在条目管理中查看
        </a>
      </div>
    </li>
  );
}

function OpenReports() {
  const res = useResource(loadOpenReports, []);
  const { busy, run } = useBusy();
  const groups = useMemo(() => groupReports(res.data?.reports ?? []), [res.data]);

  async function handle(group: ReportGroup, action: ResolveAction): Promise<void> {
    if (action === "delete") {
      const ok = await confirmDialog({
        title: `删除条目 ${group.code}？`,
        body: <p>这个条目会被永久删除，连同它收到的 {group.reporters} 人的举报一起，无法恢复。</p>,
        confirmLabel: `删除 ${group.code}`,
        danger: true,
      });
      if (!ok) return;
    }
    const done = await run(() => api.resolveReports(group.itemId, action));
    if (!done) return;
    toast.success(`${ACTION_TEXT[action].done}：${group.code}`);
    void refreshStats();
    res.reload();
  }

  return (
    <Async res={res}>
      {(data) =>
        groups.length === 0 ? (
          <EmptyState title="没有未处理的举报" hint="有人在 App 里举报条目后会出现在这里；够多人举报的条目会被自动隐藏。" />
        ) : (
          <>
            {data.reports.length < data.total ? <Notice tone="warn">未处理的举报有 {formatCount(data.total)} 条，这里只显示了前 {formatCount(data.reports.length)} 条，先处理掉再刷新看剩下的。</Notice> : null}
            <p class="muted small">
              共 {groups.length} 个条目被举报（{formatCount(data.reports.length)} 条举报）。「隐藏」和「删除」会一并处理该条目的全部举报（已经被自动隐藏的条目点「隐藏」也行：隐藏原因改成手动，举报标成已处理）；「驳回」表示条目没问题，如果它是被举报自动隐藏的，会同时恢复上线。
            </p>
            <ul class="report-list">
              {groups.map((group) => (
                <GroupCard key={group.itemId} group={group} busy={busy} onAction={(g, action) => void handle(g, action)} />
              ))}
            </ul>
          </>
        )
      }
    </Async>
  );
}

function HistoryReports({ status, page }: { status: ReportStatus; page: number }) {
  const res = useResource<Paged<ReportDTO>>(() => api.reports({ status, page, pageSize: LIST_PAGE_SIZE }), [status, page]);
  return (
    <Async res={res}>
      {(data) =>
        data.items.length === 0 ? (
          <EmptyState title={`没有${REPORT_STATUS_NAMES[status]}的举报`} />
        ) : (
          <>
            <div class="table-wrap">
              <table class="table">
                <thead>
                  <tr>
                    <th scope="col">条目</th>
                    <th scope="col">原因 / 详情</th>
                    <th scope="col">举报时间</th>
                    <th scope="col">处理</th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((report) => (
                    <tr key={report.id}>
                      <td data-label="条目">
                        <a class="mono strong" href={linkTo("/items", { q: report.code, channel: report.channel })}>
                          {report.code}
                        </a>{" "}
                        <span class="muted small">{CHANNEL_NAMES[report.channel]}</span> <StatusBadge status={report.itemStatus} />
                        <div class="small clamp-2">{report.info}</div>
                      </td>
                      <td data-label="原因">
                        <Badge tone="gray">{REPORT_REASON_NAMES[report.reason]}</Badge>
                        {report.detail ? <div class="small">{truncate(report.detail, 200)}</div> : null}
                      </td>
                      <td data-label="举报时间">
                        <TimeCell ms={report.createdAt} />
                      </td>
                      <td data-label="处理">
                        {report.resolvedBy ?? "系统"} · <TimeCell ms={report.resolvedAt} />
                        {report.resolution ? <div class="small muted">{report.resolution}</div> : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pager page={data.page} pageSize={data.pageSize} total={data.total} onPage={(next) => navigate("/reports", { status, page: next > 1 ? next : undefined }, { replace: true })} />
          </>
        )
      }
    </Async>
  );
}

export function ReportsPage() {
  const route = useRoute();
  const status = STATUSES.find((s) => s === route.query.status) ?? "open";
  const page = Math.max(1, Number(route.query.page) || 1);

  const tabs: TabDef<ReportStatus>[] = STATUSES.map((value) => ({ value, label: REPORT_STATUS_NAMES[value] }));
  return (
    <>
      <PageHeader
        title="举报"
        subtitle="App 里被举报的条目。网友推荐的条目被足够多「不同 IP」的人举报（默认 3 个）会自动隐藏、进入这里待复核；作者精选不会自动隐藏，只进这里等你处理。"
      />
      <Tabs label="举报状态" value={status} tabs={tabs} onChange={(next) => navigate("/reports", { status: next === "open" ? undefined : next }, { replace: true })} />
      {status === "open" ? <OpenReports /> : <HistoryReports status={status} page={page} />}
    </>
  );
}
