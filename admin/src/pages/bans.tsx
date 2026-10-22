// 封禁：设备 / IP（都是条目里看到的 16 位哈希）/ 番号。被封的设备和 IP 提交、举报都会被拒；被封的番号谁也提交不了。
// 支持 `#/bans?kind=device&value=…` 预填（条目上的「封禁提交者」跳过来）。

import { useEffect, useState } from "preact/hooks";

import type { BanDTO } from "../../../shared/types";
import { api } from "../api";
import { BAN_KINDS, parseBanPrefill, validateBanValue, type BanKind } from "../lib/bans";
import { errorMessage } from "../lib/errors";
import { BAN_KIND_NAMES } from "../lib/names";
import { Async, Badge, Card, EmptyState, Notice, PageHeader, TimeCell } from "../ui/components";
import { Check, Field } from "../ui/controls";
import { CopyText } from "../ui/copy";
import { confirmDialog } from "../ui/dialogs";
import { useBusy, useFormSubmit, useResource } from "../ui/hooks";
import { navigate, useRoute } from "../ui/router";
import { refreshStats } from "../ui/stats";
import { toast } from "../ui/toast";

const PLACEHOLDERS: Record<BanKind, string> = {
  device: "16 位设备哈希，比如 3fa9c2d41b7e08a5",
  ip: "16 位 IP 哈希",
  code: "番号，比如 ABC-123",
};

const PURGE_TEXT: Record<BanKind, string> = {
  device: "这个设备已提交的条目：已上线的会被隐藏，待审的会被拒绝。",
  ip: "这个 IP 已提交的条目：已上线的会被隐藏，待审的会被拒绝。",
  code: "两份列表里所有同番号的条目：已上线的会被隐藏，待审的会被拒绝。",
};

function AddBanForm({ onAdded }: { onAdded: () => void }) {
  const route = useRoute();
  const prefill = parseBanPrefill(route.query);
  const [kind, setKind] = useState<BanKind>(prefill.kind);
  const [value, setValue] = useState(prefill.value);
  const [reason, setReason] = useState("");
  const [purge, setPurge] = useState(false);
  const { busy, error, submit, clearError } = useFormSubmit();

  // 从别的页面带着预填跳过来（或者已经在本页又点了一次）：同步进表单
  useEffect(() => {
    const next = parseBanPrefill(route.query);
    if (route.query.value || route.query.kind) {
      setKind(next.kind);
      setValue(next.value);
      clearError();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route.query.kind, route.query.value]);

  const problem = value.trim() ? validateBanValue(kind, value) : null;

  async function add(): Promise<void> {
    const invalid = validateBanValue(kind, value);
    if (invalid) {
      toast.error(invalid);
      return;
    }
    if (purge) {
      const ok = await confirmDialog({
        title: "封禁并清理已有条目？",
        body: (
          <>
            <p>
              将封禁{BAN_KIND_NAMES[kind]} <code>{value.trim()}</code>，并且：
            </p>
            <p>{PURGE_TEXT[kind]}</p>
            <p class="muted">被隐藏 / 拒绝的条目可以在「条目管理」里恢复，但对方以后提交会被拒绝。</p>
          </>
        ),
        confirmLabel: "封禁并清理",
        danger: true,
      });
      if (!ok) return;
    }
    const result = await submit(() => api.addBan({ kind, value: value.trim(), reason: reason.trim() || undefined, purge }));
    if (!result) return;
    toast.success(purge ? `已封禁，并清理了 ${result.purged} 个条目` : "已封禁");
    void refreshStats();
    setValue("");
    setReason("");
    setPurge(false);
    if (route.query.value || route.query.kind) navigate("/bans", {}, { replace: true });
    onAdded();
  }

  return (
    <Card title="添加封禁">
      {error ? <Notice tone="error">{errorMessage(error)}</Notice> : null}
      {prefill.ip && kind === "device" ? (
        <Notice tone="info">
          这个条目还带着提交者的 IP 哈希 <code>{prefill.ip}</code>。如果对方是换着设备刷的，可以{" "}
          <button
            type="button"
            class="link-btn"
            onClick={() => {
              setKind("ip");
              setValue(prefill.ip);
            }}
          >
            改成封这个 IP
          </button>
          （注意：同一个出口 IP 后面可能有很多人）。
        </Notice>
      ) : null}
      <form
        class="form form-inline-grid"
        onSubmit={(event) => {
          event.preventDefault();
          void add();
        }}
      >
        <Field label="类型">
          <select
            class="select"
            value={kind}
            onChange={(event) => {
              setKind(BAN_KINDS.find((k) => k === event.currentTarget.value) ?? "device");
              clearError();
            }}
          >
            {BAN_KINDS.map((k) => (
              <option key={k} value={k}>
                {BAN_KIND_NAMES[k]}
              </option>
            ))}
          </select>
        </Field>
        <Field label={kind === "code" ? "番号" : "哈希"} error={problem}>
          <input class="input mono" value={value} placeholder={PLACEHOLDERS[kind]} spellcheck={false} autocomplete="off" onInput={(event) => setValue(event.currentTarget.value)} />
        </Field>
        <Field label="理由（可选）">
          <input class="input" value={reason} maxLength={200} placeholder="比如：刷屏 / 乱放链接" onInput={(event) => setReason(event.currentTarget.value)} />
        </Field>
        <div class="form-actions">
          <Check checked={purge} onChange={setPurge}>
            同时清理对方已有的条目
          </Check>
          <button type="submit" class="btn btn-primary" disabled={busy || !value.trim()}>
            {busy ? "封禁中…" : "封禁"}
          </button>
        </div>
      </form>
      <p class="muted small">设备和 IP 的哈希在「条目管理」里每个条目的「创建 / 提交者」一列，也可以在条目的「⋯」菜单里直接选「封禁提交者」。</p>
    </Card>
  );
}

export function BansPage() {
  const res = useResource(() => api.bans(), []);
  const { busy, run } = useBusy();

  async function unban(ban: BanDTO): Promise<void> {
    const ok = await confirmDialog({
      title: `解除对${BAN_KIND_NAMES[ban.kind]}的封禁？`,
      body: (
        <p>
          <code>{ban.value}</code> 解封后可以重新提交和举报。
        </p>
      ),
      confirmLabel: "解除封禁",
    });
    if (!ok) return;
    const done = await run(() => api.removeBan(ban.kind, ban.value));
    if (!done) return;
    toast.success("已解除封禁");
    res.reload();
  }

  return (
    <>
      <PageHeader title="封禁" subtitle="拦截刷屏、乱放链接的设备 / IP，或者不想收的番号。" />
      <AddBanForm onAdded={res.reload} />
      <Card title="当前封禁">
        <Async res={res}>
          {(bans) =>
            bans.length === 0 ? (
              <EmptyState title="没有封禁" hint="还没有封过任何设备、IP 或番号。" />
            ) : (
              <div class="table-wrap">
                <table class="table">
                  <thead>
                    <tr>
                      <th scope="col">类型</th>
                      <th scope="col">值</th>
                      <th scope="col">理由</th>
                      <th scope="col">封禁时间</th>
                      <th scope="col">操作人</th>
                      <th scope="col">
                        <span class="sr-only">操作</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {bans.map((ban) => (
                      <tr key={`${ban.kind}:${ban.value}`}>
                        <td data-label="类型">
                          <Badge tone={ban.kind === "code" ? "blue" : "orange"}>{BAN_KIND_NAMES[ban.kind]}</Badge>
                        </td>
                        <td data-label="值">
                          <CopyText text={ban.value} className="mono" />
                        </td>
                        <td data-label="理由">{ban.reason || <span class="muted">—</span>}</td>
                        <td data-label="封禁时间">
                          <TimeCell ms={ban.createdAt} />
                        </td>
                        <td data-label="操作人">{ban.createdBy ?? <span class="muted">—</span>}</td>
                        <td class="cell-actions" data-label="">
                          <button type="button" class="btn btn-sm" disabled={busy} onClick={() => void unban(ban)}>
                            解封
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
          }
        </Async>
      </Card>
    </>
  );
}
