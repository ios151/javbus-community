// 命令式弹窗：确认框 `await confirmDialog({...})` 返回 true / false；
// 一次性密钥框 `await showSecret({...})` 在用户勾选「我已保存」并点「完成」后返回。
// 弹窗由根组件里的 <DialogHost /> 渲染，所以即使触发它的页面已经切走（比如安装成功后进入后台），弹窗也不会丢。

import type { ComponentChildren } from "preact";
import { useState } from "preact/hooks";

import { CopyButton } from "./copy";
import { Icon } from "./icons";
import { Modal } from "./modal";
import { createStore, useStore } from "./store";

export interface ConfirmOptions {
  title: string;
  body?: ComponentChildren;
  /** 确认按钮上的字：写清后果，比如「删除 3 个条目」，别写「确定」。 */
  confirmLabel: string;
  cancelLabel?: string;
  /** 破坏性操作：确认按钮标红，默认焦点放在「取消」上。 */
  danger?: boolean;
}

export interface SecretItem {
  label: string;
  value: string;
  note?: string;
}

export interface SecretOptions {
  title: string;
  intro?: ComponentChildren;
  items: SecretItem[];
  doneLabel?: string;
}

type Entry =
  | { id: number; kind: "confirm"; options: ConfirmOptions; resolve: (value: boolean) => void }
  | { id: number; kind: "secret"; options: SecretOptions; resolve: () => void };

const store = createStore<Entry[]>([]);
let nextId = 1;

function remove(id: number): void {
  store.set((list) => list.filter((entry) => entry.id !== id));
}

export function confirmDialog(options: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    store.set((list) => [...list, { id: nextId++, kind: "confirm", options, resolve }]);
  });
}

export function showSecret(options: SecretOptions): Promise<void> {
  return new Promise((resolve) => {
    store.set((list) => [...list, { id: nextId++, kind: "secret", options, resolve: () => resolve() }]);
  });
}

function ConfirmView({ options, onResult }: { options: ConfirmOptions; onResult: (value: boolean) => void }) {
  return (
    <Modal
      title={options.title}
      onClose={() => onResult(false)}
      footer={
        <>
          <button type="button" class="btn" data-autofocus={options.danger ? "" : undefined} onClick={() => onResult(false)}>
            {options.cancelLabel ?? "取消"}
          </button>
          <button type="button" class={`btn ${options.danger ? "btn-danger" : "btn-primary"}`} data-autofocus={options.danger ? undefined : ""} onClick={() => onResult(true)}>
            {options.confirmLabel}
          </button>
        </>
      }
    >
      <div class="confirm-body">{options.body}</div>
    </Modal>
  );
}

function SecretView({ options, onDone }: { options: SecretOptions; onDone: () => void }) {
  const [saved, setSaved] = useState(false);
  return (
    <Modal
      title={options.title}
      onClose={onDone}
      dismissible={saved}
      footer={
        <button type="button" class="btn btn-primary" disabled={!saved} onClick={onDone}>
          {options.doneLabel ?? "完成"}
        </button>
      }
    >
      {options.intro ? <div class="secret-intro">{options.intro}</div> : null}
      <div class="notice notice-warn" role="note">
        <Icon name="alert" size={18} />
        <div>
          <strong>下面的内容只显示这一次，关闭后不会再显示。</strong>
          丢了只能重置。请现在复制并妥善保存（比如放进密码管理器）。
        </div>
      </div>
      <div class="secret-list">
        {options.items.map((item) => (
          <div class="secret-item" key={item.label}>
            <div class="secret-label">{item.label}</div>
            <div class="secret-row">
              <code class="secret-value">{item.value}</code>
              <CopyButton text={item.value} />
            </div>
            {item.note ? <div class="muted small">{item.note}</div> : null}
          </div>
        ))}
      </div>
      <label class="check secret-saved">
        <input type="checkbox" checked={saved} onChange={(event) => setSaved(event.currentTarget.checked)} />
        <span>我已保存好，知道关闭后无法再查看</span>
      </label>
    </Modal>
  );
}

export function DialogHost() {
  const entries = useStore(store);
  return (
    <>
      {entries.map((entry) =>
        entry.kind === "confirm" ? (
          <ConfirmView
            key={entry.id}
            options={entry.options}
            onResult={(value) => {
              remove(entry.id);
              entry.resolve(value);
            }}
          />
        ) : (
          <SecretView
            key={entry.id}
            options={entry.options}
            onDone={() => {
              remove(entry.id);
              entry.resolve();
            }}
          />
        ),
      )}
    </>
  );
}
