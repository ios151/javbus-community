// 操作日志：谁、什么时候、做了什么。分页，可以按动作 / 操作人筛选，动作翻译成中文，detail 能展开看 JSON。

import { Fragment } from "preact";
import { useState } from "preact/hooks";

import type { AuditDTO } from "../../../shared/types";
import { api } from "../api";
import { ACTION_GROUPS, actionLabel, actorLabel, summarizeDetail } from "../lib/audit-names";
import { toggled } from "../lib/collections";
import { mergeQuery } from "../lib/route";
import { Async, EmptyState, PageHeader, TimeCell } from "../ui/components";
import { Pager, SearchInput } from "../ui/controls";
import { useResource } from "../ui/hooks";
import { navigate, useRoute } from "../ui/router";

const PAGE_SIZE = 50;
/** 服务端的 total 最多数到这么多（没有筛选时数全表太贵），到了这个数就是「至少这么多」。 */
const AUDIT_TOTAL_CAP = 10_000;

function detailText(detail: unknown): string {
  return typeof detail === "string" ? detail : JSON.stringify(detail, null, 2);
}

function hasDetail(entry: AuditDTO): boolean {
  return entry.detail !== null && entry.detail !== undefined && entry.detail !== "";
}

export function AuditPage() {
  const route = useRoute();
  const action = route.query.action ?? "";
  const actor = route.query.actor ?? "";
  const page = Math.max(1, Number(route.query.page) || 1);
  const res = useResource(() => api.audit({ action: action || undefined, actor: actor || undefined, page, pageSize: PAGE_SIZE }), [action, actor, page]);
  const [open, setOpen] = useState<ReadonlySet<number>>(new Set());

  function update(patch: Record<string, string | undefined>): void {
    navigate("/audit", mergeQuery(route.query, { page: undefined, ...patch }), { replace: true });
  }

  const known = ACTION_GROUPS.some((group) => group.actions.some((a) => a.value === action));

  return (
    <>
      <PageHeader title="操作日志" subtitle="后台里每一次改动都会留一条记录；system 是定时任务 / 自动规则，app 是脚本里的提交。" />

      <div class="toolbar toolbar-wrap">
        <label class="toolbar-field">
          <span class="muted">动作</span>
          <select class="select" value={action} onChange={(event) => update({ action: event.currentTarget.value || undefined })}>
            <option value="">全部动作</option>
            {action && !known ? <option value={action}>{action}</option> : null}
            {ACTION_GROUPS.map((group) => (
              <optgroup key={group.label} label={group.label}>
                {group.actions.map((item) => (
                  <option key={item.value} value={item.value}>
                    {item.label}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </label>
        <SearchInput label="按操作人筛选" placeholder="操作人（名字，或 system / app）" value={actor} onCommit={(value) => update({ actor: value || undefined })} />
        {action || actor ? (
          <button type="button" class="btn btn-sm" onClick={() => navigate("/audit", {}, { replace: true })}>
            清除筛选
          </button>
        ) : null}
      </div>

      <Async res={res}>
        {(data) =>
          data.items.length === 0 ? (
            <EmptyState title="没有符合条件的记录" hint={action || actor ? "换个筛选条件试试。" : undefined} />
          ) : (
            <>
              <div class="table-wrap">
                <table class="table table-compact audit-table">
                  <thead>
                    <tr>
                      <th scope="col">时间</th>
                      <th scope="col">操作人</th>
                      <th scope="col">动作</th>
                      <th scope="col">对象</th>
                      <th scope="col">概要</th>
                      <th scope="col">
                        <span class="sr-only">详情</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.items.map((entry) => {
                      const expanded = open.has(entry.id);
                      const summary = summarizeDetail(entry.action, entry.detail);
                      return (
                        <Fragment key={entry.id}>
                          <tr>
                            <td data-label="时间">
                              <TimeCell ms={entry.at} seconds />
                            </td>
                            <td data-label="操作人">{actorLabel(entry.actor)}</td>
                            <td data-label="动作">
                              <span class="strong">{actionLabel(entry.action)}</span>
                              <div class="small muted mono">{entry.action}</div>
                            </td>
                            <td data-label="对象">
                              {entry.targetType || entry.targetId ? (
                                <>
                                  <span class="muted small">{entry.targetType}</span> <span class="mono">{entry.targetId}</span>
                                </>
                              ) : (
                                <span class="muted">—</span>
                              )}
                            </td>
                            <td data-label="概要">{summary || <span class="muted">—</span>}</td>
                            <td class="cell-actions" data-label="">
                              {hasDetail(entry) ? (
                                <button type="button" class="btn btn-sm btn-ghost" aria-expanded={expanded} onClick={() => setOpen((current) => toggled(current, entry.id, !expanded))}>
                                  {expanded ? "收起" : "展开"}
                                </button>
                              ) : null}
                            </td>
                          </tr>
                          {expanded ? (
                            <tr class="detail-row">
                              <td colSpan={6}>
                                <pre class="json">{detailText(entry.detail)}</pre>
                              </td>
                            </tr>
                          ) : null}
                        </Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              {data.total >= AUDIT_TOTAL_CAP ? <p class="muted small">日志太多了，这里最多只数到 {AUDIT_TOTAL_CAP.toLocaleString("zh-CN")} 条；更早的请用上面的「动作 / 操作人」筛选缩小范围。</p> : null}
              <Pager page={data.page} pageSize={data.pageSize} total={data.total} onPage={(next) => update({ page: next > 1 ? String(next) : undefined })} />
            </>
          )
        }
      </Async>
    </>
  );
}
