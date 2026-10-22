// 通用展示组件：徽章、页面骨架、加载 / 出错 / 空状态、时间、外链。

import type { ComponentChildren } from "preact";

import { CHANNEL_NAMES, CHECK_STATUS_NAMES, ITEM_STATUS_NAMES, ROLE_NAMES, type Channel, type CheckStatus, type ItemStatus, type Role } from "../../../shared/types";
import { errorMessage } from "../lib/errors";
import { formatDateTime, formatRelative } from "../lib/time";
import { safeHttpUrl } from "../lib/format";
import { useDocumentTitle, type Resource } from "./hooks";
import { Icon } from "./icons";
import { sessionStore } from "./session";
import { useStore } from "./store";

// ———— 徽章 ————

export type Tone = "gray" | "green" | "yellow" | "orange" | "red" | "blue";

export function Badge({ tone, title, children }: { tone: Tone; title?: string; children: ComponentChildren }) {
  return (
    <span class={`badge badge-${tone}`} title={title}>
      {children}
    </span>
  );
}

const STATUS_TONES: Record<ItemStatus, Tone> = { pending: "yellow", approved: "green", rejected: "gray", hidden: "orange" };

export function StatusBadge({ status, title }: { status: ItemStatus; title?: string }) {
  return (
    <Badge tone={STATUS_TONES[status]} title={title}>
      {ITEM_STATUS_NAMES[status]}
    </Badge>
  );
}

const CHECK_TONES: Record<CheckStatus, Tone> = { unchecked: "gray", ok: "green", warn: "yellow", dead: "red" };

/** label：换掉徽章上的字（比如「没查成」，状态仍然是 unchecked、颜色仍然是灰的）。 */
export function CheckStatusBadge({ status, title, label }: { status: CheckStatus; title?: string; label?: string }) {
  return (
    <Badge tone={CHECK_TONES[status]} title={title}>
      {label ?? CHECK_STATUS_NAMES[status]}
    </Badge>
  );
}

export function ChannelBadge({ channel }: { channel: Channel }) {
  return <Badge tone={channel === "author" ? "blue" : "gray"}>{CHANNEL_NAMES[channel]}</Badge>;
}

const ROLE_TONES: Record<Role, Tone> = { owner: "blue", admin: "green", moderator: "gray" };

export function RoleBadge({ role }: { role: Role }) {
  return <Badge tone={ROLE_TONES[role]}>{ROLE_NAMES[role]}</Badge>;
}

// ———— 页面骨架 ————

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: ComponentChildren; actions?: ComponentChildren }) {
  const siteName = useStore(sessionStore).siteName;
  useDocumentTitle(`${title} · ${siteName}`);
  return (
    <header class="page-head">
      <div class="page-head-text">
        <h1>{title}</h1>
        {subtitle ? <p class="muted">{subtitle}</p> : null}
      </div>
      {actions ? <div class="page-actions">{actions}</div> : null}
    </header>
  );
}

export function Card({ title, actions, className, children }: { title?: ComponentChildren; actions?: ComponentChildren; className?: string; children: ComponentChildren }) {
  return (
    <section class={`card ${className ?? ""}`}>
      {title || actions ? (
        <header class="card-head">
          {title ? <h2>{title}</h2> : <span />}
          {actions ? <div class="card-actions">{actions}</div> : null}
        </header>
      ) : null}
      {children}
    </section>
  );
}

export function Notice({ tone = "info", children }: { tone?: "info" | "warn" | "error" | "ok"; children: ComponentChildren }) {
  const icon = tone === "ok" ? "check" : tone === "info" ? "info" : "alert";
  return (
    <div class={`notice notice-${tone}`} role={tone === "error" ? "alert" : "note"}>
      <Icon name={icon} size={18} />
      <div class="notice-body">{children}</div>
    </div>
  );
}

// ———— 加载 / 出错 / 空 ————

export function Loading({ label = "加载中…" }: { label?: string }) {
  return (
    <div class="state state-loading" role="status">
      <span class="spinner" aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  return (
    <div class="state state-error" role="alert">
      <Icon name="alert" size={22} />
      <div class="state-title">加载失败</div>
      <div class="muted">{errorMessage(error)}</div>
      {onRetry ? (
        <button type="button" class="btn" onClick={onRetry}>
          <Icon name="refresh" size={14} />
          重试
        </button>
      ) : null}
    </div>
  );
}

export function EmptyState({ title, hint, children }: { title: string; hint?: ComponentChildren; children?: ComponentChildren }) {
  return (
    <div class="state state-empty">
      <div class="state-title">{title}</div>
      {hint ? <div class="muted">{hint}</div> : null}
      {children}
    </div>
  );
}

/**
 * 把一个 Resource 渲染成：首次加载中 → 转圈；首次失败 → 带重试的错误；有数据 → 内容。
 * 重新加载时旧内容保留（半透明），失败了在内容上方给一条可重试的提示，不把已有内容吹掉。
 */
export function Async<T>({ res, children }: { res: Resource<T>; children: (data: T) => ComponentChildren }) {
  if (res.data === undefined) {
    return res.error ? <ErrorState error={res.error} onRetry={res.reload} /> : <Loading />;
  }
  return (
    <div class={res.loading ? "async is-loading" : "async"} aria-busy={res.loading}>
      {res.error ? (
        <div class="notice notice-error" role="alert">
          <Icon name="alert" size={18} />
          <div class="notice-body">刷新失败：{errorMessage(res.error)}</div>
          <button type="button" class="btn btn-sm" onClick={res.reload}>
            重试
          </button>
        </div>
      ) : null}
      {children(res.data)}
    </div>
  );
}

// ———— 小零件 ————

/** 时间：本地时区的绝对时间 + 相对时间（「3 小时前」）。 */
export function TimeCell({ ms, seconds = false }: { ms: number | null | undefined; seconds?: boolean }) {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return <span class="muted">—</span>;
  return (
    <time class="time" dateTime={new Date(ms).toISOString()}>
      <span class="time-abs">{formatDateTime(ms, { seconds })}</span>
      <span class="time-rel muted">{formatRelative(ms, Date.now())}</span>
    </time>
  );
}

/** 外链：新标签页打开，不带 opener / referrer。地址不是 http(s) 就只显示文字，不做成链接。 */
export function ExternalLink({ href, className, children }: { href: string; className?: string; children: ComponentChildren }) {
  const safe = safeHttpUrl(href);
  if (!safe) return <span class={className}>{children}</span>;
  return (
    <a class={className} href={safe} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  );
}

export function Spinner() {
  return <span class="spinner" aria-hidden="true" />;
}
