// 登录后的外壳：侧边栏（窄屏变抽屉）+ 顶栏（站点名、遮挡封面开关、当前用户、退出）。
// 侧边栏上「审核队列」和「举报」旁边的数字来自 /stats，只在切页面时刷新，不轮询。

import type { ComponentChildren } from "preact";
import { useEffect, useState } from "preact/hooks";

import { ROLE_NAMES, type MeDTO, type Permission } from "../../../shared/types";
import { formatCount } from "../lib/format";
import { RoleBadge } from "../ui/components";
import { Switch } from "../ui/controls";
import { Icon, type IconName } from "../ui/icons";
import { prefsStore, setMaskCovers } from "../ui/prefs";
import { linkTo, useRoute } from "../ui/router";
import { sessionStore, signOut } from "../ui/session";
import { pendingTotal, refreshStats, statsStore } from "../ui/stats";
import { useStore } from "../ui/store";

interface NavItem {
  path: string;
  label: string;
  icon: IconName;
  permission?: Permission;
  badge?: "pending" | "reports";
}

interface NavSection {
  title: string;
  items: NavItem[];
}

/** 菜单按权限显示：没权限的功能根本不出现在侧边栏里。 */
export const NAV: readonly NavSection[] = [
  {
    title: "内容",
    items: [
      { path: "/", label: "概览", icon: "home" },
      { path: "/review", label: "审核队列", icon: "inbox", permission: "items.moderate", badge: "pending" },
      { path: "/items", label: "条目管理", icon: "list" },
      { path: "/reports", label: "举报", icon: "flag", permission: "reports.resolve", badge: "reports" },
      { path: "/checks", label: "自动检查", icon: "activity", permission: "checks.run" },
    ],
  },
  {
    title: "管理",
    items: [
      { path: "/settings", label: "站点设置", icon: "settings" },
      { path: "/team", label: "团队", icon: "users", permission: "users.read" },
      { path: "/bans", label: "封禁", icon: "ban", permission: "bans.manage" },
      { path: "/audit", label: "操作日志", icon: "scroll", permission: "audit.read" },
      { path: "/data", label: "导入导出", icon: "transfer", permission: "transfer" },
    ],
  },
  {
    title: "我的",
    items: [{ path: "/account", label: "我的账号", icon: "user" }],
  },
];

function Badge({ count, label }: { count: number; label: string }) {
  if (count <= 0) return null;
  return (
    <span class="nav-badge" aria-label={`${count} 个${label}`}>
      {count > 99 ? "99+" : formatCount(count)}
    </span>
  );
}

export function Shell({ me, children }: { me: MeDTO; children: ComponentChildren }) {
  const route = useRoute();
  const stats = useStore(statsStore).data;
  const siteName = useStore(sessionStore).siteName;
  const maskCovers = useStore(prefsStore).maskCovers;
  const [menuOpen, setMenuOpen] = useState(false);

  // 切页面（路径变了，查询参数变了不算）：刷新一次统计，顺手收起抽屉
  useEffect(() => {
    void refreshStats();
    setMenuOpen(false);
  }, [route.path]);

  // 抽屉开着时 Esc 关闭
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [menuOpen]);

  const counts = { pending: stats ? pendingTotal(stats) : 0, reports: stats ? stats.openReports : 0 };
  const badgeLabels = { pending: "待审条目", reports: "待处理举报" };

  return (
    <div class="shell">
      <aside class={`sidebar ${menuOpen ? "is-open" : ""}`} id="sidebar">
        <div class="sidebar-brand">
          <span class="brand-mark" aria-hidden="true">
            <Icon name="check" size={18} />
          </span>
          <div class="brand-text">
            <span class="brand-name">{siteName}</span>
            <span class="brand-sub">管理后台</span>
          </div>
        </div>
        <nav aria-label="主导航">
          {NAV.map((section) => {
            const visible = section.items.filter((item) => !item.permission || me.permissions.includes(item.permission));
            if (visible.length === 0) return null;
            return (
              <div class="nav-section" key={section.title}>
                <div class="nav-title">{section.title}</div>
                <ul>
                  {visible.map((item) => {
                    const active = item.path === "/" ? route.path === "/" : route.path === item.path || route.path.startsWith(`${item.path}/`);
                    return (
                      <li key={item.path}>
                        <a class={`nav-link ${active ? "is-active" : ""}`} href={linkTo(item.path)} aria-current={active ? "page" : undefined}>
                          <Icon name={item.icon} />
                          <span class="nav-label">{item.label}</span>
                          {item.badge ? <Badge count={counts[item.badge]} label={badgeLabels[item.badge]} /> : null}
                        </a>
                      </li>
                    );
                  })}
                </ul>
              </div>
            );
          })}
        </nav>
      </aside>
      {menuOpen ? <div class="scrim sidebar-scrim" onClick={() => setMenuOpen(false)} /> : null}

      <div class="main-col">
        <header class="topbar">
          <button type="button" class="icon-btn menu-toggle" aria-label={menuOpen ? "关闭菜单" : "打开菜单"} aria-expanded={menuOpen} aria-controls="sidebar" onClick={() => setMenuOpen((open) => !open)}>
            <Icon name={menuOpen ? "x" : "menu"} size={20} />
          </button>
          <div class="topbar-title">{siteName}</div>
          <div class="topbar-spacer" />
          <Switch checked={maskCovers} onChange={setMaskCovers} label="遮挡封面（鼠标悬停或点一下才清晰）" text="遮挡封面" />
          <div class="topbar-user" title={`${me.user.name}（${ROLE_NAMES[me.user.role]}）`}>
            <Icon name="user" size={16} />
            <span class="user-name">{me.user.name}</span>
            <RoleBadge role={me.user.role} />
          </div>
          <button type="button" class="btn btn-sm" onClick={() => void signOut()}>
            <Icon name="logout" size={14} />
            退出
          </button>
        </header>
        <main class="page" id="main">
          {children}
        </main>
      </div>
    </div>
  );
}
