// 进后台之前的三个页面：首次安装、登录、凭邀请链接加入。共用一个居中的卡片外壳。

import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";

import { api } from "../api";
import { ApiError, errorMessage } from "../lib/errors";
import { INVITE_ROLE_NAMES } from "../lib/names";
import { normalizeTotpCode } from "../lib/totp";
import { Loading, Notice, Spinner } from "../ui/components";
import { CopyButton } from "../ui/copy";
import { showSecret } from "../ui/dialogs";
import { useDocumentTitle, useFormSubmit, useResource } from "../ui/hooks";
import { Icon } from "../ui/icons";
import { Field } from "../ui/controls";
import { navigate, useRoute } from "../ui/router";
import { bootSession, sessionStore, signedIn } from "../ui/session";
import { useStore } from "../ui/store";

/** 账号名规则（和服务端一致，不合规时服务端会返回中文原因，直接显示）。 */
const NAME_RULE = "2–24 个字，只能用文字、数字和 _ . -（不分大小写、不能和别人重复；全角字母会自动换成普通字母；system、app 是保留名）。";

function AuthLayout({ title, subtitle, children }: { title: string; subtitle?: ComponentChildren; children: ComponentChildren }) {
  const session = useStore(sessionStore);
  useDocumentTitle(`${title} · ${session.siteName}`);
  return (
    <main class="auth-page">
      <div class="auth-card">
        <div class="auth-brand">
          <span class="brand-mark" aria-hidden="true">
            <Icon name="check" size={18} />
          </span>
          <span class="brand-name">{session.siteName}</span>
          <span class="brand-sub">管理后台</span>
        </div>
        <h1 class="auth-title">{title}</h1>
        {subtitle ? <p class="muted auth-subtitle">{subtitle}</p> : null}
        {children}
      </div>
    </main>
  );
}

// ———— 首次安装 ————

function CodeBlock({ text }: { text: string }) {
  return (
    <div class="codeblock">
      <code>{text}</code>
      <CopyButton text={text} />
    </div>
  );
}

export function SetupPage() {
  const session = useStore(sessionStore);
  const [token, setToken] = useState("");
  const [name, setName] = useState("");
  const { busy, error, submit } = useFormSubmit();
  const [rechecking, setRechecking] = useState(false);

  async function recheck(): Promise<void> {
    setRechecking(true);
    await bootSession();
    setRechecking(false);
  }

  if (!session.tokenConfigured) {
    return (
      <AuthLayout title="还差一步：配置安装口令" subtitle="这是全新的部署，还没有任何账号。">
        <p>为了防止别人抢在你前面创建站长账号，服务端要先配置一个「安装口令」（环境变量 SETUP_TOKEN），第一次创建站长时要出示它。</p>
        <h2 class="auth-h2">线上（Cloudflare）</h2>
        <p class="muted">在项目目录里执行下面的命令，按提示输入一串足够长的随机字符：</p>
        <CodeBlock text="wrangler secret put SETUP_TOKEN" />
        <h2 class="auth-h2">本地开发</h2>
        <p class="muted">
          在项目根目录的 <code>.dev.vars</code> 文件里加一行，然后重启 <code>wrangler dev</code>：
        </p>
        <CodeBlock text={'SETUP_TOKEN="换成一串很长的随机字符"'} />
        <p class="muted">配好之后回到这里，点下面的按钮重新检查。站长账号建好以后，这个口令就不再有用了（接口永久关闭），可以删掉。</p>
        <button type="button" class="btn btn-primary" disabled={rechecking} onClick={() => void recheck()}>
          {rechecking ? "检查中…" : "我配好了，重新检查"}
        </button>
      </AuthLayout>
    );
  }

  async function onSubmit(): Promise<void> {
    const result = await submit(() => api.setup({ token: token.trim(), name: name.trim() }));
    if (!result) return;
    if (result.accessKey) {
      await showSecret({
        title: "站长账号创建成功",
        intro: (
          <p>
            欢迎，<strong>{result.me.user.name}</strong>。后台不用密码，登录靠下面这个「访问密钥」。
          </p>
        ),
        items: [{ label: "访问密钥", value: result.accessKey, note: "换设备登录、退出后重新登录都要用它。服务端只存它的哈希，丢了只能由另一位站长重置。" }],
        doneLabel: "完成，进入后台",
      });
    }
    signedIn(result.me);
    navigate("/", {}, { replace: true });
  }

  return (
    <AuthLayout title="创建站长账号" subtitle="第一次使用：用安装口令创建第一个账号，它就是站长。">
      {error ? <Notice tone="error">{errorMessage(error)}</Notice> : null}
      <form
        class="form"
        onSubmit={(event) => {
          event.preventDefault();
          void onSubmit();
        }}
      >
        <Field label="安装口令" hint="服务端配置的 SETUP_TOKEN。">
          <input class="input" type="password" name="setup-token" autocomplete="off" required value={token} onInput={(event) => setToken(event.currentTarget.value)} />
        </Field>
        <Field label="你的名字" hint={NAME_RULE}>
          <input class="input" name="username" autocomplete="username" required minLength={2} maxLength={24} value={name} onInput={(event) => setName(event.currentTarget.value)} />
        </Field>
        <button type="submit" class="btn btn-primary btn-block" disabled={busy || !token.trim() || !name.trim()}>
          {busy ? "创建中…" : "创建站长账号"}
        </button>
      </form>
    </AuthLayout>
  );
}

// ———— 登录 ————

export function LoginPage() {
  const [key, setKey] = useState("");
  const [code, setCode] = useState("");
  const [reveal, setReveal] = useState(false);
  const [needTotp, setNeedTotp] = useState(false);
  const { busy, error, submit } = useFormSubmit();
  const codeRef = useRef<HTMLInputElement>(null);

  const totpPrompt = error instanceof ApiError && error.code === "totp_required";
  useEffect(() => {
    if (totpPrompt) setNeedTotp(true);
  }, [totpPrompt]);
  // 验证码输入框是 needTotp 变成 true 之后才渲染出来的，要等它出现了再把焦点放进去
  useEffect(() => {
    if (needTotp) codeRef.current?.focus();
  }, [needTotp]);

  async function onSubmit(): Promise<void> {
    const result = await submit(() => api.login({ key: key.trim(), totp: needTotp ? normalizeTotpCode(code) : undefined }));
    if (result) signedIn(result.me);
  }

  return (
    <AuthLayout title="登录" subtitle="用你的访问密钥登录。">
      {totpPrompt ? <Notice tone="info">这个账号开启了二次验证，请输入验证器里的 6 位验证码。</Notice> : error ? <Notice tone="error">{errorMessage(error)}</Notice> : null}
      <form
        class="form"
        onSubmit={(event) => {
          event.preventDefault();
          void onSubmit();
        }}
      >
        <Field label="访问密钥" hint="以 jck_ 开头。">
          <span class="input-group">
            <input
              class="input mono"
              type={reveal ? "text" : "password"}
              name="access-key"
              autocomplete="current-password"
              spellcheck={false}
              required
              value={key}
              onInput={(event) => setKey(event.currentTarget.value)}
            />
            <button type="button" class="icon-btn" aria-label={reveal ? "隐藏访问密钥" : "显示访问密钥"} aria-pressed={reveal} onClick={() => setReveal((value) => !value)}>
              <Icon name={reveal ? "eye-off" : "eye"} />
            </button>
          </span>
        </Field>
        {needTotp ? (
          <Field label="验证码" hint="验证器 App 里的 6 位数字。">
            <input
              ref={codeRef}
              class="input mono"
              name="totp"
              inputMode="numeric"
              autocomplete="one-time-code"
              maxLength={7}
              placeholder="123456"
              required
              value={code}
              onInput={(event) => setCode(event.currentTarget.value)}
            />
          </Field>
        ) : null}
        <button type="submit" class="btn btn-primary btn-block" disabled={busy || !key.trim()}>
          {busy ? "登录中…" : "登录"}
        </button>
      </form>
      <p class="muted small auth-foot">没有账号？让站长或管理员给你发邀请链接。丢了访问密钥，找站长重置。</p>
    </AuthLayout>
  );
}

// ———— 凭邀请加入 ————

export function JoinPage() {
  const route = useRoute();
  const token = route.query.token ?? "";
  const session = useStore(sessionStore);
  const invite = useResource(() => api.invite(token), [token]);
  const [name, setName] = useState("");
  const { busy, error, submit } = useFormSubmit();

  async function onSubmit(): Promise<void> {
    const result = await submit(() => api.join({ token, name: name.trim() }));
    if (!result) return;
    if (result.accessKey) {
      await showSecret({
        title: "账号创建成功",
        intro: (
          <p>
            欢迎加入，<strong>{result.me.user.name}</strong>。后台不用密码，登录靠下面这个「访问密钥」。
          </p>
        ),
        items: [{ label: "访问密钥", value: result.accessKey, note: "换设备登录、退出后重新登录都要用它。丢了找站长重置。" }],
        doneLabel: "完成，进入后台",
      });
    }
    signedIn(result.me);
    navigate("/", {}, { replace: true }); // 把一次性令牌从地址栏里去掉
  }

  if (invite.data === undefined) {
    return (
      <AuthLayout title="加入团队">
        {invite.error ? <Notice tone="error">{errorMessage(invite.error)}</Notice> : <Loading />}
      </AuthLayout>
    );
  }

  const info = invite.data;
  if (!info.valid || !info.role) {
    return (
      <AuthLayout title="邀请无效">
        <Notice tone="warn">这个邀请无效、已被使用或已过期。请联系邀请你的人重新发一个。</Notice>
        <p>
          <a class="btn" href="#/">
            去登录页
          </a>
        </p>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout title={`加入「${info.siteName}」`} subtitle={`你被邀请成为 ${INVITE_ROLE_NAMES[info.role]}${info.note ? `（备注：${info.note}）` : ""}。`}>
      {session.me ? <Notice tone="warn">你现在登录的是「{session.me.user.name}」。加入后会切换成新账号。</Notice> : null}
      {error ? <Notice tone="error">{errorMessage(error)}</Notice> : null}
      <form
        class="form"
        onSubmit={(event) => {
          event.preventDefault();
          void onSubmit();
        }}
      >
        <Field label="给自己起个名字" hint={NAME_RULE}>
          <input class="input" name="username" autocomplete="username" required minLength={2} maxLength={24} value={name} onInput={(event) => setName(event.currentTarget.value)} />
        </Field>
        <button type="submit" class="btn btn-primary btn-block" disabled={busy || name.trim().length < 2}>
          {busy ? <Spinner /> : null}
          {busy ? "加入中…" : "加入"}
        </button>
      </form>
    </AuthLayout>
  );
}
