// 根组件：决定现在该显示什么——启动中 / 连不上 / 安装 / 凭邀请加入 / 登录 / 登录后的后台，
// 以及登录后按 hash 路由和权限显示哪个页面。弹窗和 toast 的容器也在这里（所以不会随页面切换丢失）。

import type { ComponentChildren } from "preact";
import { useErrorBoundary, useEffect } from "preact/hooks";

import type { MeDTO, Permission } from "../../shared/types";
import { AccountPage } from "./pages/account";
import { AuditPage } from "./pages/audit";
import { JoinPage, LoginPage, SetupPage } from "./pages/auth";
import { BansPage } from "./pages/bans";
import { ChecksPage } from "./pages/checks";
import { DashboardPage } from "./pages/dashboard";
import { DataPage } from "./pages/data";
import { ItemsPage } from "./pages/items";
import { ReportsPage } from "./pages/reports";
import { ReviewPage } from "./pages/review";
import { SettingsPage } from "./pages/settings";
import { Shell } from "./pages/shell";
import { TeamPage } from "./pages/team";
import { errorMessage } from "./lib/errors";
import { EmptyState, Loading, PageHeader } from "./ui/components";
import { DialogHost } from "./ui/dialogs";
import { Icon } from "./ui/icons";
import { linkTo, useRoute } from "./ui/router";
import { MeContext, bootSession, sessionStore } from "./ui/session";
import { useStore } from "./ui/store";
import { Toaster } from "./ui/toast";

/** 顶层 / 页面级错误边界：某个页面渲染时崩了，只显示这一块的错误，侧边栏还在，可以点走。 */
function Boundary({ children }: { children: ComponentChildren }) {
  const [error, reset] = useErrorBoundary((caught) => console.error("页面渲染出错", caught));
  if (error) {
    return (
      <div class="state state-error boundary" role="alert">
        <Icon name="alert" size={26} />
        <div class="state-title">这个页面出错了</div>
        <div class="muted">{errorMessage(error)}</div>
        <div class="button-row">
          <button type="button" class="btn btn-primary" onClick={reset}>
            重试
          </button>
          <button type="button" class="btn" onClick={() => location.reload()}>
            刷新整个页面
          </button>
        </div>
      </div>
    );
  }
  return <>{children}</>;
}

interface PageDef {
  path: string;
  permission?: Permission;
  render: () => ComponentChildren;
}

const PAGES: readonly PageDef[] = [
  { path: "/", render: () => <DashboardPage /> },
  { path: "/review", permission: "items.moderate", render: () => <ReviewPage /> },
  { path: "/items", render: () => <ItemsPage /> },
  { path: "/reports", permission: "reports.resolve", render: () => <ReportsPage /> },
  { path: "/checks", permission: "checks.run", render: () => <ChecksPage /> },
  { path: "/settings", render: () => <SettingsPage /> },
  { path: "/team", permission: "users.read", render: () => <TeamPage /> },
  { path: "/bans", permission: "bans.manage", render: () => <BansPage /> },
  { path: "/audit", permission: "audit.read", render: () => <AuditPage /> },
  { path: "/data", permission: "transfer", render: () => <DataPage /> },
  { path: "/account", render: () => <AccountPage /> },
];

function Routes({ me }: { me: MeDTO }) {
  const route = useRoute();
  const page = PAGES.find((p) => p.path === route.path);
  if (!page) {
    return (
      <>
        <PageHeader title="页面不存在" />
        <EmptyState title="没有这个页面" hint="链接可能写错了。">
          <a class="btn" href={linkTo("/")}>
            回概览
          </a>
        </EmptyState>
      </>
    );
  }
  if (page.permission && !me.permissions.includes(page.permission)) {
    return (
      <>
        <PageHeader title="没有权限" />
        <EmptyState title="你没有权限访问这个页面" hint="需要更高的角色。有需要的话找站长调整。">
          <a class="btn" href={linkTo("/")}>
            回概览
          </a>
        </EmptyState>
      </>
    );
  }
  // 按路径做 key：切换页面时错误边界和页面状态一起重置
  return <Boundary key={route.path}>{page.render()}</Boundary>;
}

function FullPage({ children }: { children: ComponentChildren }) {
  return <div class="fullpage">{children}</div>;
}

export function App() {
  const session = useStore(sessionStore);
  const route = useRoute();
  useEffect(() => {
    void bootSession();
  }, []);

  let body: ComponentChildren;
  if (session.phase === "booting") {
    body = (
      <FullPage>
        <Loading label="正在连接服务器…" />
      </FullPage>
    );
  } else if (session.phase === "failed") {
    body = (
      <FullPage>
        <div class="state state-error" role="alert">
          <Icon name="alert" size={26} />
          <div class="state-title">连不上后台服务</div>
          <div class="muted">{session.failure}</div>
          <button type="button" class="btn btn-primary" onClick={() => void bootSession()}>
            重试
          </button>
        </div>
      </FullPage>
    );
  } else if (route.path === "/join" && !session.needsSetup) {
    body = <JoinPage />;
  } else if (session.needsSetup) {
    body = <SetupPage />;
  } else if (!session.me) {
    body = <LoginPage />;
  } else {
    body = (
      <MeContext.Provider value={session.me}>
        <Shell me={session.me}>
          <Routes me={session.me} />
        </Shell>
      </MeContext.Provider>
    );
  }

  return (
    <>
      <Boundary>{body}</Boundary>
      <DialogHost />
      <Toaster />
    </>
  );
}
