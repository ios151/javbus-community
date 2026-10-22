// 表单和交互控件：字段外壳、开关、标签页、分页器、搜索框、下拉菜单。

import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";

import { pageCount, pageRange } from "../lib/pager";
import { PAGE_SIZES } from "../lib/filters";
import { formatCount } from "../lib/format";
import { Icon } from "./icons";

// ———— 字段 ————

/** 标签 + 控件 + 说明 + 错误。控件放在 <label> 里，点标签就聚焦，读屏也能关联上。 */
export function Field({
  label,
  hint,
  error,
  className,
  children,
}: {
  label: ComponentChildren;
  hint?: ComponentChildren;
  error?: string | null;
  className?: string;
  children: ComponentChildren;
}) {
  return (
    <div class={`field ${error ? "has-error" : ""} ${className ?? ""}`}>
      <label class="field-label">
        <span class="field-name">{label}</span>
        {children}
      </label>
      {hint ? <div class="field-hint">{hint}</div> : null}
      {error ? (
        <div class="field-error" role="alert">
          {error}
        </div>
      ) : null}
    </div>
  );
}

/** 勾选框（带文字）。 */
export function Check({ checked, onChange, disabled, children }: { checked: boolean; onChange: (checked: boolean) => void; disabled?: boolean; children: ComponentChildren }) {
  return (
    <label class="check">
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(event) => onChange(event.currentTarget.checked)} />
      <span>{children}</span>
    </label>
  );
}

/** 开关：真正的 checkbox（role=switch），外观是滑块。旁边的文字默认是「开 / 关」，也可以自己指定。 */
export function Switch({ checked, onChange, disabled, label, text }: { checked: boolean; onChange: (checked: boolean) => void; disabled?: boolean; label: string; text?: string }) {
  return (
    <label class={`switch ${disabled ? "is-disabled" : ""}`}>
      <input type="checkbox" role="switch" checked={checked} disabled={disabled} aria-label={label} onChange={(event) => onChange(event.currentTarget.checked)} />
      <span class="switch-track" aria-hidden="true">
        <span class="switch-thumb" />
      </span>
      <span class="switch-text">{text ?? (checked ? "开" : "关")}</span>
    </label>
  );
}

// ———— 标签页 ————

export interface TabDef<T extends string> {
  value: T;
  label: ComponentChildren;
  count?: number;
}

export function Tabs<T extends string>({ value, onChange, tabs, label }: { value: T; onChange: (value: T) => void; tabs: readonly TabDef<T>[]; label: string }) {
  return (
    <div class="tabs" role="tablist" aria-label={label}>
      {tabs.map((tab) => (
        <button key={tab.value} type="button" role="tab" aria-selected={tab.value === value} class={`tab ${tab.value === value ? "is-active" : ""}`} onClick={() => onChange(tab.value)}>
          {tab.label}
          {tab.count !== undefined ? <span class="tab-count">{formatCount(tab.count)}</span> : null}
        </button>
      ))}
    </div>
  );
}

// ———— 分页 ————

export function Pager({
  page,
  pageSize,
  total,
  onPage,
  onPageSize,
}: {
  page: number;
  pageSize: number;
  total: number;
  onPage: (page: number) => void;
  onPageSize?: (size: number) => void;
}) {
  const count = pageCount(total, pageSize);
  const current = Math.min(page, count);
  const from = total === 0 ? 0 : (current - 1) * pageSize + 1;
  const to = Math.min(total, current * pageSize);
  return (
    <nav class="pager" aria-label="分页">
      <div class="pager-info muted">
        {total === 0 ? "没有记录" : `第 ${formatCount(from)}–${formatCount(to)} 条，共 ${formatCount(total)} 条`}
      </div>
      <div class="pager-buttons">
        <button type="button" class="btn btn-sm" disabled={current <= 1} onClick={() => onPage(current - 1)}>
          上一页
        </button>
        {pageRange(current, count).map((item, index) =>
          item === "gap" ? (
            <span key={`gap-${index}`} class="pager-gap" aria-hidden="true">
              …
            </span>
          ) : (
            <button key={item} type="button" class={`btn btn-sm pager-num ${item === current ? "is-current" : ""}`} aria-current={item === current ? "page" : undefined} onClick={() => onPage(item)}>
              {item}
            </button>
          ),
        )}
        <button type="button" class="btn btn-sm" disabled={current >= count} onClick={() => onPage(current + 1)}>
          下一页
        </button>
      </div>
      {onPageSize ? (
        <label class="pager-size muted">
          每页
          <select class="select select-sm" value={String(pageSize)} onChange={(event) => onPageSize(Number(event.currentTarget.value))}>
            {PAGE_SIZES.map((size) => (
              <option key={size} value={size}>
                {size} 条
              </option>
            ))}
          </select>
        </label>
      ) : null}
    </nav>
  );
}

// ———— 搜索框 ————

/** 输入停下来 delay 毫秒后才提交（或按回车立刻提交）；外面的值变了（比如点了「清除筛选」）会同步进来。 */
export function SearchInput({ value, onCommit, placeholder, label, delay = 350 }: { value: string; onCommit: (value: string) => void; placeholder?: string; label: string; delay?: number }) {
  const [text, setText] = useState(value);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => setText(value), [value]);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  function schedule(next: string): void {
    setText(next);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      if (next.trim() !== value) onCommit(next.trim());
    }, delay);
  }

  return (
    <div class="search">
      <Icon name="search" size={16} />
      <input
        type="search"
        class="search-input"
        value={text}
        placeholder={placeholder}
        aria-label={label}
        maxLength={60}
        onInput={(event) => schedule(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            window.clearTimeout(timer.current);
            if (text.trim() !== value) onCommit(text.trim());
          }
        }}
      />
    </div>
  );
}

// ———— 下拉菜单 ————

export interface MenuItem {
  label: string;
  onSelect: () => void;
  danger?: boolean;
  disabled?: boolean;
}

/**
 * 「⋯」更多操作菜单。弹层用 fixed 定位：表格外面包着 overflow 容器，absolute 的弹层会被裁掉。
 * 键盘：Enter / 空格 / ↓ 打开，↑↓ 移动，Esc 关闭并把焦点还给按钮。
 */
export function Menu({ label, items }: { label: string; items: readonly (MenuItem | "separator")[] }) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ top?: number; bottom?: number; right: number }>({ right: 0 });
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  function openMenu(): void {
    const button = buttonRef.current;
    if (!button) return;
    const rect = button.getBoundingClientRect();
    const estimated = items.length * 38 + 12;
    const right = Math.max(8, window.innerWidth - rect.right);
    if (rect.bottom + estimated > window.innerHeight && rect.top > estimated) {
      setPosition({ bottom: window.innerHeight - rect.top + 4, right });
    } else {
      setPosition({ top: rect.bottom + 4, right });
    }
    setOpen(true);
  }

  useEffect(() => {
    if (!open) return;
    menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]:not([disabled])')?.focus();
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target as Node | null;
      if (target && (menuRef.current?.contains(target) || buttonRef.current?.contains(target))) return;
      setOpen(false);
    };
    const close = (): void => setOpen(false);
    document.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [open]);

  function onMenuKeyDown(event: KeyboardEvent): void {
    const menu = menuRef.current;
    if (!menu) return;
    const entries = [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])')];
    const index = entries.indexOf(document.activeElement as HTMLElement);
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      buttonRef.current?.focus();
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      entries[(index + 1) % entries.length]?.focus();
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      entries[(index - 1 + entries.length) % entries.length]?.focus();
    } else if (event.key === "Tab") {
      setOpen(false);
    }
  }

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        class="icon-btn"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => (open ? setOpen(false) : openMenu())}
        onKeyDown={(event) => {
          if (!open && event.key === "ArrowDown") {
            event.preventDefault();
            openMenu();
          }
        }}
      >
        <Icon name="more" />
      </button>
      {open ? (
        <div ref={menuRef} class="menu" role="menu" aria-label={label} style={position} onKeyDown={onMenuKeyDown}>
          {items.map((item, index) =>
            item === "separator" ? (
              <div key={`sep-${index}`} class="menu-sep" role="separator" />
            ) : (
              <button
                key={item.label}
                type="button"
                role="menuitem"
                class={`menu-item ${item.danger ? "is-danger" : ""}`}
                disabled={item.disabled}
                onClick={() => {
                  setOpen(false);
                  item.onSelect();
                }}
              >
                {item.label}
              </button>
            ),
          )}
        </div>
      ) : null}
    </>
  );
}
