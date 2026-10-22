// 弹窗外壳：居中小窗 / 右侧抽屉。
// 基本功都在这里：role=dialog + aria-modal、焦点移进去并困在里面（Tab 循环）、Esc 关最上面那个、关掉后焦点还给原来的按钮、
// 弹窗开着时锁住页面滚动。不用原生 <dialog>：它在浏览器的「顶层」里，会把 toast 盖在下面。

import type { ComponentChildren } from "preact";
import { useEffect, useId, useRef } from "preact/hooks";

import { Icon } from "./icons";

/** 弹窗栈：只有最上面的响应 Esc 和 Tab。 */
const stack: symbol[] = [];
let scrollLocks = 0;

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function focusablesIn(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.getClientRects().length > 0);
}

export interface ModalProps {
  title: ComponentChildren;
  onClose: () => void;
  children: ComponentChildren;
  footer?: ComponentChildren;
  /** center = 居中小窗；drawer = 右侧抽屉（编辑表单用）。 */
  variant?: "center" | "drawer";
  /** false = 点遮罩 / Esc / × 都关不掉（一次性密钥弹窗：要先勾选「我已保存」）。 */
  dismissible?: boolean;
  wide?: boolean;
  /** 传了就把弹窗包成 <form>，footer 里的 type=submit 按钮能直接提交。 */
  onSubmit?: () => void;
}

export function Modal({ title, onClose, children, footer, variant = "center", dismissible = true, wide = false, onSubmit }: ModalProps) {
  const titleId = useId();
  const rootRef = useRef<HTMLElement | null>(null);
  const setRoot = (el: HTMLElement | null): void => {
    rootRef.current = el;
  };
  // 回调里要用最新的 onClose / dismissible，但 effect 只挂载一次
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const dismissibleRef = useRef(dismissible);
  dismissibleRef.current = dismissible;

  useEffect(() => {
    const token = Symbol("modal");
    stack.push(token);
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (scrollLocks++ === 0) document.body.classList.add("modal-open");

    const root = rootRef.current;
    if (root) {
      // 优先聚焦内容区里的第一个控件（标题栏的关闭按钮排在最前，但不该是默认焦点）
      const body = root.querySelector<HTMLElement>(".modal-body");
      const preferred =
        root.querySelector<HTMLElement>("[data-autofocus]") ??
        (body ? focusablesIn(body)[0] : undefined) ??
        focusablesIn(root)[0] ??
        root;
      preferred.focus();
    }

    const onKeyDown = (event: KeyboardEvent): void => {
      if (stack[stack.length - 1] !== token) return;
      if (event.key === "Escape") {
        event.stopPropagation();
        if (dismissibleRef.current) closeRef.current();
        return;
      }
      if (event.key !== "Tab" || !root) return;
      const items = focusablesIn(root);
      const first = items[0];
      const last = items[items.length - 1];
      if (!first || !last) {
        event.preventDefault();
        root.focus();
        return;
      }
      const active = document.activeElement;
      if (!root.contains(active)) {
        event.preventDefault();
        first.focus();
      } else if (event.shiftKey && (active === first || active === root)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown, true);

    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      const index = stack.indexOf(token);
      if (index >= 0) stack.splice(index, 1);
      if (--scrollLocks === 0) document.body.classList.remove("modal-open");
      if (previouslyFocused && document.contains(previouslyFocused)) previouslyFocused.focus();
    };
  }, []);

  const className = `modal modal-${variant}${wide ? " modal-wide" : ""}`;
  const content = (
    <>
      <header class="modal-head">
        <h2 id={titleId} class="modal-title">
          {title}
        </h2>
        {dismissible ? (
          <button type="button" class="icon-btn" aria-label="关闭" onClick={onClose}>
            <Icon name="x" />
          </button>
        ) : null}
      </header>
      <div class="modal-body">{children}</div>
      {footer ? <footer class="modal-foot">{footer}</footer> : null}
    </>
  );

  return (
    <div class="modal-layer">
      <div class="scrim" onClick={dismissible ? onClose : undefined} />
      {onSubmit ? (
        <form
          class={className}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          tabIndex={-1}
          ref={setRoot}
          onSubmit={(event) => {
            event.preventDefault();
            onSubmit();
          }}
        >
          {content}
        </form>
      ) : (
        <div class={className} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} ref={setRoot}>
          {content}
        </div>
      )}
    </div>
  );
}
