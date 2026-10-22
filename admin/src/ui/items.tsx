// 条目相关的共用部分：封面、来源 / 检查单元格、批量操作 hook、新增对话框、编辑抽屉。
// 审核队列、条目管理、自动检查的「待复核」列表都用它们。

import { useEffect, useState } from "preact/hooks";

import { CHANNELS, CHANNEL_NAMES, type Channel, type ItemDTO } from "../../../shared/types";
import { api, type ItemPatchBody } from "../api";
import { checkName, isCheckNote } from "../lib/check-display";
import { chunk } from "../lib/collections";
import { coverProxyUrl } from "../lib/cover";
import { errorMessage } from "../lib/errors";
import { safeHttpUrl, shortHash } from "../lib/format";
import { HIDDEN_REASON_NAMES } from "../lib/names";
import { formatDateTime } from "../lib/time";
import { CheckStatusBadge, Notice, StatusBadge, TimeCell } from "./components";
import { Field } from "./controls";
import { CopyText } from "./copy";
import { confirmDialog } from "./dialogs";
import { useBusy, useFormSubmit } from "./hooks";
import { Icon } from "./icons";
import { Modal } from "./modal";
import { prefsStore } from "./prefs";
import { navigate } from "./router";
import { refreshStats } from "./stats";
import { useStore } from "./store";
import { toast } from "./toast";

// ———— 封面 ————

export type CoverSize = "sm" | "md" | "lg";

/**
 * 封面缩略图。加载失败显示占位；「遮挡封面」开着时糊住，鼠标悬停（或点一下，触屏用）才清晰。
 * 给了 itemId 就走服务端的封面代理：JavBus 一类图床靠 Referer 防盗链，浏览器从后台直接加载一律 403，得由服务端带上站点的 Referer 去取。
 * 没给（编辑抽屉里改过、还没保存的地址）才直接加载，而且不带 Referer，不把后台地址泄露给图床。
 */
export function Cover({ src, itemId, size = "md", label }: { src: string; itemId?: number; size?: CoverSize; label: string }) {
  const masked = useStore(prefsStore).maskCovers;
  const [failed, setFailed] = useState(false);
  const [revealed, setRevealed] = useState(false);
  useEffect(() => {
    setFailed(false);
    setRevealed(false);
  }, [src, itemId]);

  const direct = safeHttpUrl(src);
  const url = direct && itemId !== undefined ? coverProxyUrl(itemId, direct) : direct;
  if (!url || failed) {
    return (
      <div class={`cover cover-${size} cover-empty`} title={url ? "封面加载失败" : "没有封面地址"}>
        <span>{url ? "加载失败" : "无封面"}</span>
      </div>
    );
  }
  const hidden = masked && !revealed;
  return (
    <div
      class={`cover cover-${size} ${hidden ? "is-masked" : ""} ${masked ? "is-clickable" : ""}`}
      role={masked ? "button" : undefined}
      tabIndex={masked ? 0 : undefined}
      aria-label={masked ? (revealed ? "再次遮挡封面" : "显示封面") : undefined}
      onClick={masked ? () => setRevealed((value) => !value) : undefined}
      onKeyDown={
        masked
          ? (event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                setRevealed((value) => !value);
              }
            }
          : undefined
      }
    >
      <img src={url} alt={label} referrerpolicy="no-referrer" loading="lazy" decoding="async" onError={() => setFailed(true)} />
    </div>
  );
}

// ———— 单元格 ————

/** 条目是谁加的：App 提交的显示设备短哈希，维护者建的显示名字，都没有的是导入。 */
export function SourceCell({ item }: { item: ItemDTO }) {
  if (item.submitter) {
    return (
      <span class="mono" title={`提交者设备哈希：${item.submitter}`}>
        {shortHash(item.submitter)}
      </span>
    );
  }
  if (item.createdBy) return <span title="维护者添加">{item.createdBy}</span>;
  if (item.ipHash) {
    return (
      <span class="mono" title={`提交者 IP 哈希：${item.ipHash}`}>
        IP {shortHash(item.ipHash)}
      </span>
    );
  }
  return <span class="muted">导入</span>;
}

export function itemStatusBadge(item: ItemDTO) {
  const reason = HIDDEN_REASON_NAMES[item.hiddenReason];
  return <StatusBadge status={item.status} title={item.status === "hidden" && reason ? reason : undefined} />;
}

/**
 * 检查结果徽章：悬停看详情和连续失效次数；窄屏没有悬停，详情直接写在下面（expanded = 任何宽度都写出来，编辑抽屉用）。
 * 带说明但不是问题的两种情况（见 lib/check-display.ts）：
 * - 「正常」+ 说明（比如「链接 站点先跳到年龄验证页，看不到真实页面」）：绿色「正常」徽章照旧；
 * - 「没查成」（unchecked + 说明，一项都没法判断）：灰色徽章，和从没查过的「没查过」区分开；
 * 这两种的说明都用中性的灰色小字，不带警示色。
 */
export function CheckCell({ item, expanded = false }: { item: ItemDTO; expanded?: boolean }) {
  const name = checkName(item);
  const tip = [name, item.checkDetail, item.checkFail > 0 ? `连续失效 ${item.checkFail} 次` : "", item.checkedAt ? `检查于 ${formatDateTime(item.checkedAt)}` : ""]
    .filter(Boolean)
    .join("｜");
  const isNote = isCheckNote(item);
  return (
    <div class="check-cell">
      <CheckStatusBadge status={item.checkStatus} title={tip} label={name} />
      {item.checkFail > 0 ? (
        <span class="muted small" title="连续失效次数">
          ×{item.checkFail}
        </span>
      ) : null}
      {item.checkDetail ? (
        <div class={`check-detail small ${isNote ? "is-note" : "muted"} ${expanded ? "is-shown" : ""}`}>{isNote ? `说明：${item.checkDetail}` : item.checkDetail}</div>
      ) : null}
    </div>
  );
}

// ———— 批量操作 ————

type StatusTarget = "approved" | "rejected" | "hidden";
const STATUS_VERBS: Record<StatusTarget, string> = { approved: "通过", rejected: "拒绝", hidden: "隐藏" };
/** 「检查这几条」一次最多几个（接口上限）。 */
const CHECK_PICK_LIMIT = 25;

/** 修改状态 / 删除 / 检查 / 跳去封禁：各页面共用，做完统一刷新列表和侧边栏数字。 */
export function useItemActions(onChanged: () => void) {
  const { busy, run } = useBusy();

  function changed(): void {
    void refreshStats();
    onChanged();
  }

  async function setStatus(ids: number[], status: StatusTarget): Promise<boolean> {
    const result = await run(() => api.setItemsStatus(ids, status));
    if (!result) return false;
    const verb = STATUS_VERBS[status];
    const same = ids.length - result.changed;
    toast.success(same > 0 ? `已${verb} ${result.changed} 个条目（另有 ${same} 个本来就是这个状态）` : `已${verb} ${result.changed} 个条目`);
    changed();
    return true;
  }

  async function remove(items: readonly Pick<ItemDTO, "id" | "code">[]): Promise<boolean> {
    if (items.length === 0) return false;
    const preview = items.slice(0, 5).map((item) => item.code);
    const ok = await confirmDialog({
      title: items.length === 1 ? `删除条目 ${preview[0]}？` : `删除 ${items.length} 个条目？`,
      body: (
        <>
          <p>
            {preview.join("、")}
            {items.length > preview.length ? ` 等 ${items.length} 个` : ""}
            将被永久删除，连同它们收到的举报一起，<strong>无法恢复</strong>。
          </p>
          <p class="muted">只是想让它们从公开列表里消失的话，用「隐藏」就行，随时能恢复。</p>
        </>
      ),
      confirmLabel: `删除 ${items.length} 个条目`,
      danger: true,
    });
    if (!ok) return false;
    const result = await run(() => api.deleteItems(items.map((item) => item.id)));
    if (!result) return false;
    toast.success(`已删除 ${result.deleted} 个条目`);
    changed();
    return true;
  }

  /** 立即检查指定的条目（超过 25 个自动分批）。 */
  async function check(ids: number[]): Promise<void> {
    if (ids.length === 0) return;
    const sum = { examined: 0, ok: 0, warn: 0, dead: 0, hidden: 0 };
    const finished = await run(async () => {
      for (const batch of chunk(ids, CHECK_PICK_LIMIT)) {
        // 指定条目时有几个查几个（不受设置里「每次检查几个条目」的限制）
        const result = await api.runChecks({ itemIds: batch });
        if (result.run) {
          sum.examined += result.run.examined;
          sum.ok += result.run.ok;
          sum.warn += result.run.warn;
          sum.dead += result.run.dead;
          sum.hidden += result.run.hidden;
        }
      }
      return true;
    });
    if (finished) {
      const tail = sum.hidden > 0 ? `，其中 ${sum.hidden} 个因连续失效被自动隐藏` : "";
      toast.success(`检查了 ${sum.examined} 个条目：正常 ${sum.ok}、存疑 ${sum.warn}、失效 ${sum.dead}${tail}`);
    }
    changed(); // 出错时前面几批也可能已经生效
  }

  return { busy, setStatus, remove, check };
}

/** 「封禁提交者」：跳到封禁页并预填。有设备哈希封设备（顺带带上 IP，页面里可以改封 IP），只有 IP 哈希就封 IP。 */
export function banSubmitter(item: ItemDTO): void {
  if (item.submitter) navigate("/bans", { kind: "device", value: item.submitter, ip: item.ipHash || undefined });
  else if (item.ipHash) navigate("/bans", { kind: "ip", value: item.ipHash });
}

export function canBanSubmitter(item: ItemDTO): boolean {
  return Boolean(item.submitter || item.ipHash);
}

// ———— 表单：新增 / 编辑 ————

interface ItemValues {
  channel: Channel;
  code: string;
  info: string;
  src: string;
  link: string;
  note: string;
  status: "approved" | "pending";
}

function ItemFields({ values, onChange, create }: { values: ItemValues; onChange: (patch: Partial<ItemValues>) => void; create: boolean }) {
  return (
    <>
      <div class="form-row">
        <Field label={create ? "放进哪份列表" : "所在列表（改它 = 移到另一份）"}>
          <select class="select" value={values.channel} onChange={(event) => onChange({ channel: event.currentTarget.value === "author" ? "author" : "user" })}>
            {CHANNELS.map((channel) => (
              <option key={channel} value={channel}>
                {CHANNEL_NAMES[channel]}
              </option>
            ))}
          </select>
        </Field>
        {create ? (
          <Field label="新增后的状态" hint="待审的不会出现在公开列表里。">
            <select class="select" value={values.status} onChange={(event) => onChange({ status: event.currentTarget.value === "pending" ? "pending" : "approved" })}>
              <option value="approved">直接上线</option>
              <option value="pending">先放进待审</option>
            </select>
          </Field>
        ) : null}
      </div>
      <Field label="番号" hint="字母或数字开头，可以带 . _ -，最长 40 位。">
        <input class="input mono" value={values.code} maxLength={40} autocomplete="off" spellcheck={false} onInput={(event) => onChange({ code: event.currentTarget.value })} />
      </Field>
      <Field label="标题（info）" hint="App 列表里显示的那行字，留空就用番号。最长 160 个字。">
        <input class="input" value={values.info} maxLength={160} autocomplete="off" onInput={(event) => onChange({ info: event.currentTarget.value })} />
      </Field>
      <Field label="封面地址" hint="http(s) 图片地址，可以留空。">
        <input class="input" type="url" inputMode="url" value={values.src} maxLength={300} autocomplete="off" spellcheck={false} onInput={(event) => onChange({ src: event.currentTarget.value })} />
      </Field>
      <Field label="详情页地址" hint="必填。必须是公网网站的 http(s) 地址。">
        <input class="input" type="url" inputMode="url" value={values.link} maxLength={300} autocomplete="off" spellcheck={false} onInput={(event) => onChange({ link: event.currentTarget.value })} />
      </Field>
      <Field label="备注（只有维护者看得到）">
        <textarea class="textarea" rows={2} value={values.note} maxLength={300} onInput={(event) => onChange({ note: event.currentTarget.value })} />
      </Field>
    </>
  );
}

export function CreateItemDialog({ defaultChannel, onClose, onCreated }: { defaultChannel?: Channel; onClose: () => void; onCreated: (item: ItemDTO) => void }) {
  const [values, setValues] = useState<ItemValues>({ channel: defaultChannel ?? "user", code: "", info: "", src: "", link: "", note: "", status: "approved" });
  const { busy, error, submit, clearError } = useFormSubmit();
  const [local, setLocal] = useState<string | null>(null);

  async function save(): Promise<void> {
    if (!values.code.trim() || !values.link.trim()) {
      setLocal("番号和详情页地址必须填写");
      return;
    }
    setLocal(null);
    const item = await submit(() =>
      api.createItem({
        channel: values.channel,
        code: values.code.trim(),
        info: values.info.trim() || undefined,
        src: values.src.trim() || undefined,
        link: values.link.trim(),
        status: values.status,
        note: values.note.trim() || undefined,
      }),
    );
    if (!item) return;
    toast.success(`已新增 ${item.code}（${item.status === "approved" ? "已上线" : "待审"}）`);
    void refreshStats();
    onCreated(item);
  }

  const message = local ?? (error ? errorMessage(error) : null);
  return (
    <Modal
      title="新增条目"
      onClose={onClose}
      onSubmit={() => void save()}
      footer={
        <>
          <button type="button" class="btn" onClick={onClose}>
            取消
          </button>
          <button type="submit" class="btn btn-primary" disabled={busy}>
            {busy ? "新增中…" : "新增"}
          </button>
        </>
      }
    >
      {message ? <Notice tone="error">{message}</Notice> : null}
      <ItemFields
        create
        values={values}
        onChange={(patch) => {
          setValues((current) => ({ ...current, ...patch }));
          setLocal(null);
          clearError();
        }}
      />
      <p class="muted small">维护者新增的条目不受「屏蔽词」和「允许的网站」限制。</p>
    </Modal>
  );
}

/** 编辑抽屉：改标题 / 封面 / 详情页 / 备注 / 移到另一个频道。只提交改过的字段。 */
export function EditItemDrawer({ item, onClose, onSaved }: { item: ItemDTO; onClose: () => void; onSaved: (item: ItemDTO) => void }) {
  const initial: ItemValues = { channel: item.channel, code: item.code, info: item.info, src: item.src, link: item.link, note: item.note, status: "approved" };
  const [values, setValues] = useState<ItemValues>(initial);
  const { busy, error, submit, clearError } = useFormSubmit();
  const [local, setLocal] = useState<string | null>(null);

  const patch: ItemPatchBody = {};
  if (values.code.trim() !== item.code) patch.code = values.code.trim();
  if (values.info.trim() !== item.info) patch.info = values.info.trim();
  if (values.src.trim() !== item.src) patch.src = values.src.trim();
  if (values.link.trim() !== item.link) patch.link = values.link.trim();
  if (values.note.trim() !== item.note) patch.note = values.note.trim();
  if (values.channel !== item.channel) patch.channel = values.channel;
  const dirty = Object.keys(patch).length > 0;

  async function requestClose(): Promise<void> {
    if (dirty && !(await confirmDialog({ title: "放弃未保存的修改？", body: "关闭后，这次改的内容不会保留。", confirmLabel: "放弃修改", cancelLabel: "继续编辑", danger: true }))) return;
    onClose();
  }

  async function save(): Promise<void> {
    if (!dirty) {
      toast.info("没有改动");
      return;
    }
    if (!values.code.trim() || !values.link.trim()) {
      setLocal("番号和详情页地址必须填写");
      return;
    }
    setLocal(null);
    const updated = await submit(() => api.patchItem(item.id, patch));
    if (!updated) return;
    toast.success(patch.channel ? `已保存，并移到「${CHANNEL_NAMES[updated.channel]}」` : "已保存");
    void refreshStats();
    onSaved(updated);
  }

  const message = local ?? (error ? errorMessage(error) : null);
  return (
    <Modal
      variant="drawer"
      title={`编辑 ${item.code}`}
      onClose={() => void requestClose()}
      onSubmit={() => void save()}
      footer={
        <>
          <button type="button" class="btn" onClick={() => void requestClose()}>
            取消
          </button>
          <button type="submit" class="btn btn-primary" disabled={busy || !dirty}>
            {busy ? "保存中…" : "保存修改"}
          </button>
        </>
      }
    >
      <div class="edit-preview">
        {/* 地址没改过就走服务端代理；改过的还没存进库，代理取不到，只能直接加载（防盗链的图床会显示不出来） */}
        <Cover src={values.src} itemId={values.src === item.src ? item.id : undefined} size="lg" label={`${item.code} 的封面`} />
        <dl class="kv">
          {values.src !== item.src ? (
            <>
              <dt>封面</dt>
              <dd class="muted small">改过的封面地址要保存后才会经服务器加载；现在显示不出来，不代表地址有问题。</dd>
            </>
          ) : null}
          <dt>状态</dt>
          <dd>
            {itemStatusBadge(item)} {item.status === "hidden" && item.hiddenReason ? <span class="muted small">{HIDDEN_REASON_NAMES[item.hiddenReason]}</span> : null}
          </dd>
          <dt>创建</dt>
          <dd>
            <TimeCell ms={item.createdAt} />
            <div class="small">
              来源：<SourceCell item={item} />
            </div>
          </dd>
          {item.reviewedAt ? (
            <>
              <dt>审核</dt>
              <dd>
                {item.reviewedBy ?? "—"} · <TimeCell ms={item.reviewedAt} />
              </dd>
            </>
          ) : null}
          <dt>举报</dt>
          <dd>{item.reportCount > 0 ? `${item.reportCount} 个不同 IP 的人举报过，还没处理` : "没有"}</dd>
          <dt>检查</dt>
          <dd>
            <CheckCell item={item} expanded />
            {item.checkedAt ? (
              <div class="small muted">
                上次检查 <TimeCell ms={item.checkedAt} />
              </div>
            ) : null}
          </dd>
        </dl>
      </div>

      {item.submitter || item.ipHash ? (
        <div class="submitter-box">
          <div class="small muted">
            {item.submitter ? (
              <>
                设备 <CopyText text={item.submitter} className="mono" />
              </>
            ) : null}
            {item.submitter && item.ipHash ? " · " : null}
            {item.ipHash ? (
              <>
                IP <CopyText text={item.ipHash} className="mono" />
              </>
            ) : null}
          </div>
          <button type="button" class="btn btn-sm btn-danger-ghost" onClick={() => banSubmitter(item)}>
            <Icon name="ban" size={14} />
            封禁提交者
          </button>
        </div>
      ) : null}

      {message ? <Notice tone="error">{message}</Notice> : null}
      <ItemFields
        create={false}
        values={values}
        onChange={(patchValues) => {
          setValues((current) => ({ ...current, ...patchValues }));
          setLocal(null);
          clearError();
        }}
      />
      {safeHttpUrl(values.link) ? (
        <p class="small">
          <a href={safeHttpUrl(values.link) ?? undefined} target="_blank" rel="noopener noreferrer">
            在新标签页打开详情页 <Icon name="external" size={12} />
          </a>
        </p>
      ) : null}
    </Modal>
  );
}
