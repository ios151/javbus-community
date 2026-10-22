// 我的账号：基本信息、换访问密钥、二次验证（TOTP）、App 口令（给脚本里「作者通道」用的密码）。

import { useState } from "preact/hooks";

import { allPermissions, type AppKeyDTO, type TotpStartDTO } from "../../../shared/types";
import { api } from "../api";
import { errorMessage } from "../lib/errors";
import { PERMISSION_NAMES } from "../lib/names";
import { groupSecret, isTotpCode, normalizeTotpCode } from "../lib/totp";
import { Async, Badge, Card, EmptyState, Notice, PageHeader, RoleBadge, TimeCell } from "../ui/components";
import { Field } from "../ui/controls";
import { CopyButton } from "../ui/copy";
import { confirmDialog, showSecret } from "../ui/dialogs";
import { useBusy, useFormSubmit, useResource } from "../ui/hooks";
import { Icon } from "../ui/icons";
import { QrCode } from "../ui/qrcode";
import { updateMe, useMe } from "../ui/session";
import { toast } from "../ui/toast";

// ———— 换访问密钥 ————

function KeyCard() {
  const { busy, run } = useBusy();
  async function rotate(): Promise<void> {
    const ok = await confirmDialog({
      title: "换一个新的访问密钥？",
      body: (
        <>
          <p>旧密钥立刻作废，你在其他设备上的登录会被踢下线（当前这个浏览器不受影响）。</p>
          <p>新密钥只显示一次，换完要马上保存好。</p>
        </>
      ),
      confirmLabel: "换新密钥",
      danger: true,
    });
    if (!ok) return;
    const result = await run(() => api.rotateKey());
    if (!result) return;
    await showSecret({
      title: "新的访问密钥",
      intro: <p>旧密钥已经作废，下次登录请用这个新密钥。</p>,
      items: [{ label: "访问密钥", value: result.accessKey }],
    });
  }
  return (
    <Card title="访问密钥">
      <p class="muted">后台不用密码，登录靠访问密钥（以 jck_ 开头）。怀疑密钥泄露了就换一个。</p>
      <button type="button" class="btn" disabled={busy} onClick={() => void rotate()}>
        <Icon name="key" size={14} />
        换访问密钥…
      </button>
    </Card>
  );
}

// ———— 二次验证 ————

function TotpCard() {
  const me = useMe();
  const enabled = me.user.totpEnabled;
  const [setup, setSetup] = useState<TotpStartDTO | null>(null);
  const [code, setCode] = useState("");
  const starting = useBusy();
  const { busy, error, submit, clearError } = useFormSubmit();

  async function start(): Promise<void> {
    const result = await starting.run(() => api.totpStart());
    if (!result) return;
    setSetup(result);
    setCode("");
    clearError();
  }

  async function refreshMe(): Promise<void> {
    try {
      updateMe(await api.me());
    } catch {
      // 拿不到就先不更新，页面上的状态下次进来会对上
    }
  }

  async function enable(): Promise<void> {
    const done = await submit(() => api.totpEnable(normalizeTotpCode(code)));
    if (!done) return;
    toast.success("二次验证已开启，下次登录需要验证码");
    setSetup(null);
    setCode("");
    await refreshMe();
  }

  async function disable(): Promise<void> {
    const ok = await confirmDialog({
      title: "关闭二次验证？",
      body: <p>关闭后，登录只需要访问密钥。账号的安全性会降低。</p>,
      confirmLabel: "关闭二次验证",
      danger: true,
    });
    if (!ok) return;
    const done = await submit(() => api.totpDisable(normalizeTotpCode(code)));
    if (!done) return;
    toast.success("二次验证已关闭");
    setCode("");
    await refreshMe();
  }

  return (
    <Card title="二次验证" actions={enabled ? <Badge tone="green">已开启</Badge> : <Badge tone="gray">未开启</Badge>}>
      <p class="muted">开启后，登录除了访问密钥还要输入验证器 App（Google Authenticator、1Password、Authy 等）里的 6 位验证码。</p>

      {!enabled && !setup ? (
        <button type="button" class="btn btn-primary" disabled={starting.busy} onClick={() => void start()}>
          {starting.busy ? "准备中…" : "开始设置"}
        </button>
      ) : null}

      {!enabled && setup ? (
        <form
          class="totp-setup"
          onSubmit={(event) => {
            event.preventDefault();
            void enable();
          }}
        >
          <ol class="steps">
            <li>
              用验证器 App 扫描二维码，或者手动输入下面的密钥。
              <div class="totp-visual">
                <QrCode text={setup.uri} size={196} label="二次验证二维码，用验证器 App 扫描" />
                <div class="totp-secret">
                  <div class="muted small">密钥（手动输入用）</div>
                  <code class="secret-value">{groupSecret(setup.secret)}</code>
                  <CopyButton text={setup.secret} label="复制密钥" />
                  <div class="small">
                    手机上直接打开：<a href={setup.uri}>otpauth 链接</a>
                  </div>
                </div>
              </div>
            </li>
            <li>
              输入验证器里显示的 6 位验证码，确认开启。
              {error ? <Notice tone="error">{errorMessage(error)}</Notice> : null}
              <div class="button-row">
                <input
                  class="input mono input-code"
                  inputMode="numeric"
                  autocomplete="one-time-code"
                  maxLength={7}
                  placeholder="123456"
                  aria-label="6 位验证码"
                  value={code}
                  onInput={(event) => setCode(event.currentTarget.value)}
                />
                <button type="submit" class="btn btn-primary" disabled={busy || !isTotpCode(code)}>
                  {busy ? "验证中…" : "确认开启"}
                </button>
                <button type="button" class="btn btn-ghost" onClick={() => setSetup(null)}>
                  取消
                </button>
              </div>
            </li>
          </ol>
        </form>
      ) : null}

      {enabled ? (
        <form
          class="totp-disable"
          onSubmit={(event) => {
            event.preventDefault();
            void disable();
          }}
        >
          {error ? <Notice tone="error">{errorMessage(error)}</Notice> : null}
          <Field label="要关闭，先输入当前的验证码">
            <span class="button-row">
              <input
                class="input mono input-code"
                inputMode="numeric"
                autocomplete="one-time-code"
                maxLength={7}
                placeholder="123456"
                value={code}
                onInput={(event) => setCode(event.currentTarget.value)}
              />
              <button type="submit" class="btn btn-danger" disabled={busy || !isTotpCode(code)}>
                关闭二次验证…
              </button>
            </span>
          </Field>
        </form>
      ) : null}
    </Card>
  );
}

// ———— App 口令 ————

function AppKeysCard() {
  const res = useResource(() => api.appKeys(), []);
  const [name, setName] = useState("");
  const create = useFormSubmit();
  const { busy, run } = useBusy();

  async function add(): Promise<void> {
    const created = await create.submit(() => api.createAppKey(name.trim()));
    if (!created) return;
    setName("");
    res.reload();
    await showSecret({
      title: `App 口令「${created.appKey.name}」`,
      intro: (
        <p>
          把它填到脚本设置里的<strong>「作者通道密码」</strong>。用这个口令提交的条目直接上线（作者精选也只有带口令才能提交），不受限频和屏蔽词限制，所以别外传。
        </p>
      ),
      items: [{ label: "App 口令", value: created.key, note: "不用的口令随时可以在这里撤销。账号被停用时，名下的口令会一起失效。" }],
    });
  }

  async function revoke(key: AppKeyDTO): Promise<void> {
    const ok = await confirmDialog({
      title: `撤销口令「${key.name}」？`,
      body: <p>用这个口令的脚本会立刻失去「作者通道」权限，需要换新的口令。</p>,
      confirmLabel: "撤销口令",
      danger: true,
    });
    if (!ok) return;
    const done = await run(() => api.revokeAppKey(key.id));
    if (!done) return;
    toast.success("已撤销");
    res.reload();
  }

  return (
    <Card title="App 口令">
      <p class="muted">
        脚本里「作者通道」的密码。给每台设备各建一个，丢了哪台就撤销哪个。最多同时有 10 个有效口令。
      </p>
      {create.error ? <Notice tone="error">{errorMessage(create.error)}</Notice> : null}
      <form
        class="button-row"
        onSubmit={(event) => {
          event.preventDefault();
          void add();
        }}
      >
        <input class="input" aria-label="口令名字" placeholder="给它起个名字，比如「我的 iPhone」" maxLength={40} value={name} onInput={(event) => setName(event.currentTarget.value)} />
        <button type="submit" class="btn btn-primary" disabled={create.busy || !name.trim()}>
          <Icon name="plus" size={14} />
          新建口令
        </button>
      </form>
      <Async res={res}>
        {(keys) =>
          keys.length === 0 ? (
            <EmptyState title="还没有 App 口令" hint="新建一个，填到脚本里就能用「作者通道」提交了。" />
          ) : (
            <div class="table-wrap">
              <table class="table table-compact">
                <thead>
                  <tr>
                    <th scope="col">名字</th>
                    <th scope="col">创建时间</th>
                    <th scope="col">最后使用</th>
                    <th scope="col">状态</th>
                    <th scope="col">
                      <span class="sr-only">操作</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {keys.map((key) => (
                    <tr key={key.id} class={key.revoked ? "is-muted" : undefined}>
                      <th scope="row" data-label="名字">
                        {key.name}
                      </th>
                      <td data-label="创建时间">
                        <TimeCell ms={key.createdAt} />
                      </td>
                      <td data-label="最后使用">{key.lastUsedAt ? <TimeCell ms={key.lastUsedAt} /> : <span class="muted">从未使用</span>}</td>
                      <td data-label="状态">{key.revoked ? <Badge tone="gray">已撤销</Badge> : <Badge tone="green">有效</Badge>}</td>
                      <td class="cell-actions" data-label="">
                        {key.revoked ? null : (
                          <button type="button" class="btn btn-sm btn-danger-ghost" disabled={busy} onClick={() => void revoke(key)}>
                            撤销
                          </button>
                        )}
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
  );
}

// ———— 页面 ————

export function AccountPage() {
  const me = useMe();
  return (
    <>
      <PageHeader title="我的账号" />
      <Card title="基本信息">
        <dl class="kv">
          <dt>名字</dt>
          <dd class="strong">{me.user.name}</dd>
          <dt>角色</dt>
          <dd>
            <RoleBadge role={me.user.role} />
          </dd>
          <dt>创建时间</dt>
          <dd>
            <TimeCell ms={me.user.createdAt} />
          </dd>
          <dt>最后登录</dt>
          <dd>{me.user.lastLoginAt ? <TimeCell ms={me.user.lastLoginAt} /> : <span class="muted">—</span>}</dd>
          <dt>我的权限</dt>
          <dd>
            <ul class="perm-list">
              {allPermissions(me.user.role).map((permission) => (
                <li key={permission}>{PERMISSION_NAMES[permission]}</li>
              ))}
            </ul>
          </dd>
        </dl>
      </Card>
      <KeyCard />
      <TotpCard />
      <AppKeysCard />
    </>
  );
}
