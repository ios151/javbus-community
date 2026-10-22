// toast 提示：成功 / 失败 / 提示。任何地方 `toast.success("…")` 即可，由根组件里的 <Toaster /> 显示。
// 层级比弹窗高：弹窗开着的时候操作失败，提示也要看得见。

import { Icon } from "./icons";
import { createStore, useStore } from "./store";

export type ToastKind = "success" | "error" | "info";

interface ToastItem {
  id: number;
  kind: ToastKind;
  message: string;
}

const store = createStore<ToastItem[]>([]);
let nextId = 1;
const MAX_VISIBLE = 4;

function dismiss(id: number): void {
  store.set((list) => list.filter((t) => t.id !== id));
}

function push(kind: ToastKind, message: string, ms: number): void {
  const id = nextId++;
  store.set((list) => [...list.slice(-(MAX_VISIBLE - 1)), { id, kind, message }]);
  setTimeout(() => dismiss(id), ms);
}

export const toast = {
  success: (message: string) => push("success", message, 3500),
  /** 失败信息要让人看清，停留更久。 */
  error: (message: string) => push("error", message, 8000),
  info: (message: string) => push("info", message, 4500),
};

export function Toaster() {
  const list = useStore(store);
  return (
    <div class="toasts" aria-live="polite" aria-atomic="false">
      {list.map((item) => (
        <div key={item.id} class={`toast toast-${item.kind}`} role={item.kind === "error" ? "alert" : "status"}>
          <span class="toast-icon">
            <Icon name={item.kind === "success" ? "check" : item.kind === "error" ? "alert" : "info"} size={16} />
          </span>
          <span class="toast-text">{item.message}</span>
          <button type="button" class="icon-btn toast-close" aria-label="关闭提示" onClick={() => dismiss(item.id)}>
            <Icon name="x" size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}
