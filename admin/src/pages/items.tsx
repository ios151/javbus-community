// 条目管理：筛选 / 搜索 / 排序 / 分页，行操作，多选 + 底部固定的批量操作栏，新增，编辑抽屉。
// 筛选条件都同步在 URL 里（`#/items?check=dead`），刷新、分享链接都能还原。

import { useEffect, useMemo, useState } from "preact/hooks";

import { CHANNELS, CHANNEL_NAMES, CHECK_STATUSES, CHECK_STATUS_NAMES, ITEM_STATUSES, ITEM_STATUS_NAMES, type Channel, type CheckStatus, type ItemDTO, type ItemStatus } from "../../../shared/types";
import { api } from "../api";
import { toggled } from "../lib/collections";
import { ITEM_SORTS, ITEM_SORT_NAMES, hasActiveFilters, itemsApiQuery, itemsFilterToQuery, parseItemsFilter, type ItemSort, type ItemsFilter } from "../lib/filters";
import { hostOf } from "../lib/format";
import { Async, ChannelBadge, EmptyState, ExternalLink, PageHeader, TimeCell } from "../ui/components";
import { Check, Menu, Pager, SearchInput, type MenuItem } from "../ui/controls";
import { CopyText } from "../ui/copy";
import { useResource } from "../ui/hooks";
import { Icon } from "../ui/icons";
import { CheckCell, Cover, CreateItemDialog, EditItemDrawer, SourceCell, banSubmitter, canBanSubmitter, itemStatusBadge, useItemActions } from "../ui/items";
import { linkTo, navigate, useRoute } from "../ui/router";
import { useCan } from "../ui/session";

export function ItemsPage() {
  const route = useRoute();
  const filter = useMemo(() => parseItemsFilter(route.query), [route.query]);
  const apiQuery = itemsApiQuery(filter);
  const key = JSON.stringify(apiQuery);
  const res = useResource(() => api.items(apiQuery), [key]);

  const canModerate = useCan("items.moderate");
  const canBan = useCan("bans.manage");
  const [selected, setSelected] = useState<ReadonlySet<number>>(new Set());
  const [editing, setEditing] = useState<ItemDTO | null>(null);
  const [creating, setCreating] = useState(false);
  const actions = useItemActions(() => {
    setSelected(new Set());
    res.reload();
  });
  // 换了筛选条件 / 翻页，之前的勾选作废
  useEffect(() => setSelected(new Set()), [key]);

  /** 改筛选条件：写回 URL，并回到第一页（翻页本身除外）。 */
  function update(patch: Partial<ItemsFilter>): void {
    const next: ItemsFilter = { ...filter, ...patch, page: patch.page ?? 1 };
    navigate("/items", itemsFilterToQuery(next), { replace: true });
  }

  const items = res.data?.items ?? [];
  const allSelected = items.length > 0 && items.every((item) => selected.has(item.id));
  const picked = items.filter((item) => selected.has(item.id));
  const pickedIds = picked.map((item) => item.id);

  function rowMenu(item: ItemDTO): (MenuItem | "separator")[] {
    const menu: (MenuItem | "separator")[] = [{ label: "立即检查", onSelect: () => void actions.check([item.id]) }];
    if (item.status === "approved") menu.push({ label: "拒绝（不再公开）", onSelect: () => void actions.setStatus([item.id], "rejected") });
    if (item.status === "pending") menu.push({ label: "隐藏", onSelect: () => void actions.setStatus([item.id], "hidden") });
    if (canBan && canBanSubmitter(item)) menu.push({ label: "封禁提交者…", onSelect: () => banSubmitter(item) });
    menu.push("separator", { label: "删除…", danger: true, onSelect: () => void actions.remove([item]) });
    return menu;
  }

  return (
    <>
      <PageHeader
        title="条目管理"
        subtitle="两份公开列表里所有状态的条目。"
        actions={
          canModerate ? (
            <button type="button" class="btn btn-primary" onClick={() => setCreating(true)}>
              <Icon name="plus" size={14} />
              新增条目
            </button>
          ) : undefined
        }
      />

      <div class="toolbar toolbar-wrap">
        <SearchInput label="搜索番号或标题" placeholder="搜索番号 / 标题" value={filter.q} onCommit={(q) => update({ q })} />
        <label class="toolbar-field">
          <span class="muted">列表</span>
          <select class="select" value={filter.channel ?? ""} onChange={(event) => update({ channel: CHANNELS.find((c): c is Channel => c === event.currentTarget.value) })}>
            <option value="">全部</option>
            {CHANNELS.map((channel) => (
              <option key={channel} value={channel}>
                {CHANNEL_NAMES[channel]}
              </option>
            ))}
          </select>
        </label>
        <label class="toolbar-field">
          <span class="muted">状态</span>
          <select class="select" value={filter.status ?? ""} onChange={(event) => update({ status: ITEM_STATUSES.find((s): s is ItemStatus => s === event.currentTarget.value) })}>
            <option value="">全部</option>
            {ITEM_STATUSES.map((status) => (
              <option key={status} value={status}>
                {ITEM_STATUS_NAMES[status]}
              </option>
            ))}
          </select>
        </label>
        <label class="toolbar-field">
          <span class="muted">检查</span>
          <select class="select" value={filter.check ?? ""} onChange={(event) => update({ check: CHECK_STATUSES.find((s): s is CheckStatus => s === event.currentTarget.value) })}>
            <option value="">全部</option>
            {CHECK_STATUSES.map((status) => (
              <option key={status} value={status}>
                {CHECK_STATUS_NAMES[status]}
              </option>
            ))}
          </select>
        </label>
        <label class="toolbar-field">
          <span class="muted">排序</span>
          <select class="select" value={filter.sort} onChange={(event) => update({ sort: ITEM_SORTS.find((s): s is ItemSort => s === event.currentTarget.value) ?? "new" })}>
            {ITEM_SORTS.map((sort) => (
              <option key={sort} value={sort}>
                {ITEM_SORT_NAMES[sort]}
              </option>
            ))}
          </select>
        </label>
        <Check checked={filter.reported} onChange={(reported) => update({ reported })}>
          只看被举报的
        </Check>
        {hasActiveFilters(filter) ? (
          <button type="button" class="btn btn-sm" onClick={() => navigate("/items", {}, { replace: true })}>
            清除筛选
          </button>
        ) : null}
      </div>

      <Async res={res}>
        {(page) =>
          page.items.length === 0 ? (
            <EmptyState title={hasActiveFilters(filter) ? "没有符合条件的条目" : "还没有任何条目"} hint={hasActiveFilters(filter) ? "换个筛选条件试试。" : "点右上角「新增条目」，或者去「导入导出」导入一份列表。"}>
              {hasActiveFilters(filter) ? (
                <button type="button" class="btn" onClick={() => navigate("/items", {}, { replace: true })}>
                  清除筛选
                </button>
              ) : null}
            </EmptyState>
          ) : (
            <>
              <div class="table-wrap">
                <table class="table items-table">
                  <thead>
                    <tr>
                      <th scope="col" class="col-select">
                        <input type="checkbox" aria-label="全选本页" checked={allSelected} onChange={(event) => setSelected(event.currentTarget.checked ? new Set(items.map((item) => item.id)) : new Set())} />
                      </th>
                      <th scope="col">封面</th>
                      <th scope="col">番号 / 列表</th>
                      <th scope="col">标题 / 详情页</th>
                      <th scope="col">状态</th>
                      <th scope="col">检查</th>
                      <th scope="col" title="未处理举报的人数，按「不同的 IP」算">
                        举报
                      </th>
                      <th scope="col">创建 / 提交者</th>
                      <th scope="col">
                        <span class="sr-only">操作</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {page.items.map((item) => (
                      <tr key={item.id} class={selected.has(item.id) ? "is-selected" : undefined}>
                        <td class="col-select" data-label="">
                          <input type="checkbox" aria-label={`选择 ${item.code}`} checked={selected.has(item.id)} onChange={(event) => setSelected((current) => toggled(current, item.id, event.currentTarget.checked))} />
                        </td>
                        <td class="cell-cover" data-label="">
                          <Cover src={item.src} itemId={item.id} size="sm" label={`${item.code} 的封面`} />
                        </td>
                        <td class="cell-code" data-label="番号">
                          <CopyText text={item.code} className="mono strong" />
                          <div class="cell-channel">
                            <ChannelBadge channel={item.channel} />
                          </div>
                        </td>
                        <td class="cell-title" data-label="标题">
                          <div class="clamp-2">{item.info}</div>
                          <div class="small">
                            <ExternalLink href={item.link} className="host-link">
                              {hostOf(item.link) || "（地址无效）"} <Icon name="external" size={12} />
                            </ExternalLink>
                          </div>
                          {item.note ? (
                            <div class="small muted" title="维护者备注">
                              备注：{item.note}
                            </div>
                          ) : null}
                        </td>
                        <td data-label="状态">{itemStatusBadge(item)}</td>
                        <td data-label="检查">
                          <CheckCell item={item} />
                        </td>
                        <td data-label="举报">
                          {item.reportCount > 0 ? (
                            <a href={linkTo("/reports")} class="text-danger strong" title={`${item.reportCount} 个不同 IP 的人举报过，还没处理`}>
                              {item.reportCount}
                            </a>
                          ) : (
                            <span class="muted">0</span>
                          )}
                        </td>
                        <td class="cell-created" data-label="创建">
                          <TimeCell ms={item.createdAt} />
                          <div class="small">
                            <SourceCell item={item} />
                          </div>
                        </td>
                        <td class="cell-actions" data-label="">
                          {canModerate ? (
                            <div class="row-actions">
                              {item.status === "pending" ? (
                                <>
                                  <button type="button" class="btn btn-sm btn-primary" disabled={actions.busy} onClick={() => void actions.setStatus([item.id], "approved")}>
                                    通过
                                  </button>
                                  <button type="button" class="btn btn-sm" disabled={actions.busy} onClick={() => void actions.setStatus([item.id], "rejected")}>
                                    拒绝
                                  </button>
                                </>
                              ) : null}
                              {item.status === "approved" ? (
                                <button type="button" class="btn btn-sm" disabled={actions.busy} onClick={() => void actions.setStatus([item.id], "hidden")}>
                                  隐藏
                                </button>
                              ) : null}
                              {item.status === "hidden" || item.status === "rejected" ? (
                                <button type="button" class="btn btn-sm btn-primary" disabled={actions.busy} onClick={() => void actions.setStatus([item.id], "approved")}>
                                  {item.status === "hidden" ? "恢复上线" : "通过"}
                                </button>
                              ) : null}
                              <button type="button" class="btn btn-sm" onClick={() => setEditing(item)}>
                                编辑
                              </button>
                              <Menu label={`${item.code} 的更多操作`} items={rowMenu(item)} />
                            </div>
                          ) : (
                            <button type="button" class="btn btn-sm" onClick={() => setEditing(item)}>
                              查看
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <Pager page={page.page} pageSize={page.pageSize} total={page.total} onPage={(next) => update({ page: next })} onPageSize={(pageSize) => update({ pageSize })} />
            </>
          )
        }
      </Async>

      {picked.length > 0 ? (
        <div class="batch-bar" role="region" aria-label="批量操作">
          <span class="batch-count">已选 {picked.length} 项</span>
          <button type="button" class="btn btn-sm btn-primary" disabled={actions.busy} onClick={() => void actions.setStatus(pickedIds, "approved")}>
            通过
          </button>
          <button type="button" class="btn btn-sm" disabled={actions.busy} onClick={() => void actions.setStatus(pickedIds, "hidden")}>
            隐藏
          </button>
          <button type="button" class="btn btn-sm" disabled={actions.busy} onClick={() => void actions.setStatus(pickedIds, "rejected")}>
            拒绝
          </button>
          <button type="button" class="btn btn-sm" disabled={actions.busy} onClick={() => void actions.check(pickedIds)}>
            检查
          </button>
          <button type="button" class="btn btn-sm btn-danger" disabled={actions.busy} onClick={() => void actions.remove(picked)}>
            <Icon name="trash" size={14} />
            删除
          </button>
          <button type="button" class="btn btn-sm btn-ghost" onClick={() => setSelected(new Set())}>
            取消选择
          </button>
        </div>
      ) : null}

      {editing ? (
        <EditItemDrawer
          item={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            res.reload();
          }}
        />
      ) : null}
      {creating ? (
        <CreateItemDialog
          defaultChannel={filter.channel}
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false);
            res.reload();
          }}
        />
      ) : null}
    </>
  );
}
