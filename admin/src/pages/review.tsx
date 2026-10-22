// 审核队列：所有待审的条目（两个频道），带封面、番号、标题、来源域名、提交时间。
// 单条「通过 / 拒绝」，勾选后批量，「检查这几条」先看看封面和链接还活着没有，点开能编辑。

import { useEffect, useMemo, useState } from "preact/hooks";

import { CHANNELS, CHANNEL_NAMES, type Channel, type ItemDTO } from "../../../shared/types";
import { api } from "../api";
import { toggled } from "../lib/collections";
import { itemsApiQuery, itemsFilterToQuery, parseItemsFilter, type FilterDefaults, type ItemSort } from "../lib/filters";
import { hostOf } from "../lib/format";
import { Async, ChannelBadge, EmptyState, ExternalLink, PageHeader, TimeCell } from "../ui/components";
import { Check, Pager } from "../ui/controls";
import { CopyText } from "../ui/copy";
import { useResource } from "../ui/hooks";
import { Icon } from "../ui/icons";
import { CheckCell, Cover, EditItemDrawer, SourceCell, useItemActions } from "../ui/items";
import { navigate, useRoute } from "../ui/router";

/** 审核队列先进先出：默认最早提交的排在最前。 */
const DEFAULTS: FilterDefaults = { sort: "old", pageSize: 50 };

export function ReviewPage() {
  const route = useRoute();
  const filter = useMemo(() => ({ ...parseItemsFilter(route.query, DEFAULTS), status: "pending" as const }), [route.query]);
  const apiQuery = itemsApiQuery(filter);
  const key = JSON.stringify(apiQuery);
  const res = useResource(() => api.items(apiQuery), [key]);

  const [selected, setSelected] = useState<ReadonlySet<number>>(new Set());
  const [editing, setEditing] = useState<ItemDTO | null>(null);
  const actions = useItemActions(() => {
    setSelected(new Set());
    res.reload();
  });
  useEffect(() => setSelected(new Set()), [key]);

  /** 改列表 / 排序 / 页码：写回 URL（筛选变了回到第一页）。status 固定是待审，不进 URL。 */
  function go(next: { channel: Channel | undefined; sort: ItemSort; page: number }): void {
    navigate("/review", itemsFilterToQuery({ ...filter, ...next, status: undefined }, DEFAULTS), { replace: true });
  }

  const items = res.data?.items ?? [];
  const allSelected = items.length > 0 && items.every((item) => selected.has(item.id));
  const picked = items.filter((item) => selected.has(item.id));

  return (
    <>
      <PageHeader title="审核队列" subtitle="网友提交、等维护者通过才会公开的条目。" />

      <div class="toolbar toolbar-wrap">
        <label class="toolbar-field">
          <span class="muted">列表</span>
          <select class="select" value={filter.channel ?? ""} onChange={(event) => go({ channel: CHANNELS.find((c) => c === event.currentTarget.value), sort: filter.sort, page: 1 })}>
            <option value="">全部</option>
            {CHANNELS.map((channel) => (
              <option key={channel} value={channel}>
                {CHANNEL_NAMES[channel]}
              </option>
            ))}
          </select>
        </label>
        <label class="toolbar-field">
          <span class="muted">排序</span>
          <select class="select" value={filter.sort} onChange={(event) => go({ channel: filter.channel, sort: event.currentTarget.value === "new" ? "new" : "old", page: 1 })}>
            <option value="old">最早提交的在前</option>
            <option value="new">最新提交的在前</option>
          </select>
        </label>
        <div class="toolbar-spacer" />
        <button type="button" class="btn" onClick={res.reload} disabled={res.loading}>
          <Icon name="refresh" size={14} />
          刷新
        </button>
      </div>

      <Async res={res}>
        {(page) =>
          page.items.length === 0 ? (
            <EmptyState title={page.total === 0 ? "没有待审的条目" : "这一页没有内容了"} hint="新的提交会出现在这里；也可以去「条目管理」看看全部条目。">
              {page.total > 0 ? (
                <button type="button" class="btn" onClick={() => go({ channel: filter.channel, sort: filter.sort, page: 1 })}>
                  回到第一页
                </button>
              ) : null}
            </EmptyState>
          ) : (
            <>
              <div class="bulkbar">
                <Check checked={allSelected} onChange={(on) => setSelected(on ? new Set(items.map((item) => item.id)) : new Set())}>
                  全选本页（{items.length}）
                </Check>
                <span class="muted">已选 {picked.length} 个</span>
                <div class="toolbar-spacer" />
                <button type="button" class="btn btn-primary" disabled={picked.length === 0 || actions.busy} onClick={() => void actions.setStatus(picked.map((item) => item.id), "approved")}>
                  批量通过
                </button>
                <button type="button" class="btn" disabled={picked.length === 0 || actions.busy} onClick={() => void actions.setStatus(picked.map((item) => item.id), "rejected")}>
                  批量拒绝
                </button>
                <button type="button" class="btn" disabled={picked.length === 0 || actions.busy} onClick={() => void actions.check(picked.map((item) => item.id))}>
                  检查这几条
                </button>
              </div>

              <ul class="review-list">
                {page.items.map((item) => (
                  <li class={`review-item ${selected.has(item.id) ? "is-selected" : ""}`} key={item.id}>
                    <div class="review-select">
                      <input type="checkbox" aria-label={`选择 ${item.code}`} checked={selected.has(item.id)} onChange={(event) => setSelected((current) => toggled(current, item.id, event.currentTarget.checked))} />
                    </div>
                    <Cover src={item.src} itemId={item.id} size="lg" label={`${item.code} 的封面`} />
                    <div class="review-main">
                      <div class="review-title">
                        <CopyText text={item.code} className="mono strong" />
                        <ChannelBadge channel={item.channel} />
                        {item.checkStatus !== "unchecked" ? <CheckCell item={item} /> : null}
                      </div>
                      <div class="review-info">{item.info}</div>
                      <div class="review-meta muted small">
                        <span>
                          详情页：
                          <ExternalLink href={item.link}>
                            {hostOf(item.link) || item.link} <Icon name="external" size={12} />
                          </ExternalLink>
                        </span>
                        {item.src && hostOf(item.src) !== hostOf(item.link) ? <span>封面来自：{hostOf(item.src) || "—"}</span> : null}
                        <span>
                          提交者：
                          <SourceCell item={item} />
                        </span>
                        <span class="inline-time">
                          提交于 <TimeCell ms={item.createdAt} />
                        </span>
                      </div>
                    </div>
                    <div class="review-actions">
                      <button type="button" class="btn btn-primary btn-sm" disabled={actions.busy} onClick={() => void actions.setStatus([item.id], "approved")}>
                        通过
                      </button>
                      <button type="button" class="btn btn-sm" disabled={actions.busy} onClick={() => void actions.setStatus([item.id], "rejected")}>
                        拒绝
                      </button>
                      <button type="button" class="btn btn-sm" disabled={actions.busy} onClick={() => void actions.check([item.id])}>
                        检查
                      </button>
                      <button type="button" class="btn btn-sm" onClick={() => setEditing(item)}>
                        <Icon name="edit" size={14} />
                        详情 / 编辑
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
              <Pager page={page.page} pageSize={page.pageSize} total={page.total} onPage={(next) => go({ channel: filter.channel, sort: filter.sort, page: next })} />
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
            res.reload();
          }}
        />
      ) : null}
    </>
  );
}
