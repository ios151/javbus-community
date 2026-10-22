// 团队：账号列表（站长可以改角色、停用 / 启用、重置密钥、重置二次验证）+ 邀请（创建、状态、撤销）。
// 访问密钥 / 邀请令牌都只在创建那一刻显示一次，用一次性弹窗交给人。

import { useState } from "preact/hooks";

import { ROLES, ROLE_NAMES, type InviteDTO, type Role, type UserDTO } from "../../../shared/types";
import { api } from "../api";
import { errorMessage } from "../lib/errors";
import { INVITE_STATE_NAMES, inviteLink, inviteState } from "../lib/invite";
import { INVITE_ROLE_NAMES } from "../lib/names";
import { Async, Badge, Card, EmptyState, Notice, PageHeader, RoleBadge, TimeCell } from "../ui/components";
import { Field, Menu, type MenuItem } from "../ui/controls";
import { confirmDialog, showSecret } from "../ui/dialogs";
import { useBusy, useFormSubmit, useResource } from "../ui/hooks";
import { Icon } from "../ui/icons";
import { Modal } from "../ui/modal";
import { useCan, useMe } from "../ui/session";
import { toast } from "../ui/toast";

// ———— 改角色 ————

function ChangeRoleDialog({ user, onClose, onDone }: { user: UserDTO; onClose: () => void; onDone: () => void }) {
  const [role, setRole] = useState<Role>(user.role);
  const { busy, error, submit } = useFormSubmit();

  async function save(): Promise<void> {
    if (role === user.role) {
      onClose();
      return;
    }
    const ok = await confirmDialog({
      title: `把 ${user.name} 改成${ROLE_NAMES[role]}？`,
      body: (
        <>
          <p>角色一改就立刻生效（对方不用重新登录）。{role === "owner" ? "站长拥有全部权限，包括管理所有账号。" : ""}</p>
          <p class="muted">他发出去还没用的邀请会一并作废。</p>
        </>
      ),
      confirmLabel: `改成${ROLE_NAMES[role]}`,
    });
    if (!ok) return;
    const updated = await submit(() => api.patchUser(user.id, { role }));
    if (!updated) return;
    toast.success(`${updated.name} 现在是${ROLE_NAMES[updated.role]}`);
    onDone();
  }

  return (
    <Modal
      title={`修改 ${user.name} 的角色`}
      onClose={onClose}
      onSubmit={() => void save()}
      footer={
        <>
          <button type="button" class="btn" onClick={onClose}>
            取消
          </button>
          <button type="submit" class="btn btn-primary" disabled={busy || role === user.role}>
            保存
          </button>
        </>
      }
    >
      {error ? <Notice tone="error">{errorMessage(error)}</Notice> : null}
      <Field label="角色" hint="站长：管所有账号；管理员：设置、封禁、导入导出、邀请协管；协管：审核条目、处理举报。">
        <select class="select" value={role} onChange={(event) => setRole(ROLES.find((r) => r === event.currentTarget.value) ?? user.role)}>
          {ROLES.map((r) => (
            <option key={r} value={r}>
              {ROLE_NAMES[r]}
            </option>
          ))}
        </select>
      </Field>
    </Modal>
  );
}

// ———— 创建邀请 ————

function InviteDialog({ canInviteAdmin, onClose, onCreated }: { canInviteAdmin: boolean; onClose: () => void; onCreated: () => void }) {
  const [role, setRole] = useState<"admin" | "moderator">("moderator");
  const [note, setNote] = useState("");
  const [days, setDays] = useState(7);
  const { busy, error, submit } = useFormSubmit();

  async function create(): Promise<void> {
    const created = await submit(() => api.createInvite({ role, note: note.trim() || undefined, days }));
    if (!created) return;
    onCreated();
    onClose();
    await showSecret({
      title: "邀请已创建",
      intro: (
        <p>
          把下面的链接发给对方（{INVITE_ROLE_NAMES[created.invite.role]}
          {created.invite.note ? `，备注：${created.invite.note}` : ""}）。对方打开链接、起个名字就能加入；链接 {days} 天内有效，<strong>只能用一次</strong>。
        </p>
      ),
      items: [
        { label: "邀请链接", value: inviteLink(location.origin, created.token) },
        { label: "邀请令牌", value: created.token, note: "链接里带的就是这个令牌；通常只需要发链接。" },
      ],
      doneLabel: "完成",
    });
  }

  return (
    <Modal
      title="邀请新成员"
      onClose={onClose}
      onSubmit={() => void create()}
      footer={
        <>
          <button type="button" class="btn" onClick={onClose}>
            取消
          </button>
          <button type="submit" class="btn btn-primary" disabled={busy}>
            {busy ? "创建中…" : "创建邀请"}
          </button>
        </>
      }
    >
      {error ? <Notice tone="error">{errorMessage(error)}</Notice> : null}
      <Field label="角色" hint={canInviteAdmin ? undefined : "管理员只能邀请协管；邀请管理员需要站长。"}>
        <select class="select" value={role} onChange={(event) => setRole(event.currentTarget.value === "admin" ? "admin" : "moderator")}>
          <option value="moderator">协管（审核条目、处理举报）</option>
          {canInviteAdmin ? <option value="admin">管理员（再加设置、封禁、导入导出、邀请协管）</option> : null}
        </select>
      </Field>
      <Field label="备注（可选）" hint="比如这个人是谁，方便以后对得上。最长 100 个字。">
        <input class="input" value={note} maxLength={100} onInput={(event) => setNote(event.currentTarget.value)} />
      </Field>
      <Field label="有效天数" hint="1–30 天，过期没用就作废。">
        <input class="input input-num" type="number" min={1} max={30} step={1} value={days} onInput={(event) => setDays(Number(event.currentTarget.value) || 7)} />
      </Field>
    </Modal>
  );
}

// ———— 页面 ————

export function TeamPage() {
  const me = useMe();
  const canManage = useCan("users.manage");
  const canInvite = useCan("users.inviteModerator");
  const users = useResource(() => api.users(), []);
  const invites = useResource(() => api.invites(), []);
  const { busy, run } = useBusy();
  const [roleFor, setRoleFor] = useState<UserDTO | null>(null);
  const [inviting, setInviting] = useState(false);

  async function toggleDisabled(user: UserDTO): Promise<void> {
    if (!user.disabled) {
      const ok = await confirmDialog({
        title: `停用 ${user.name}？`,
        body: (
          <>
            <p>对方会立刻被踢下线，不能再登录；他的 App 口令也会失效（脚本里的作者通道就用不了了）；他发出去还没用的邀请也会作废。</p>
            <p class="muted">以后可以随时重新启用。</p>
          </>
        ),
        confirmLabel: `停用 ${user.name}`,
        danger: true,
      });
      if (!ok) return;
    }
    const updated = await run(() => api.patchUser(user.id, { disabled: !user.disabled }));
    if (!updated) return;
    toast.success(updated.disabled ? `已停用 ${updated.name}` : `已重新启用 ${updated.name}`);
    users.reload();
  }

  async function resetKey(user: UserDTO): Promise<void> {
    const ok = await confirmDialog({
      title: `重置 ${user.name} 的访问密钥？`,
      body: (
        <>
          <p>旧密钥立刻作废，对方所有设备上的登录都会被踢下线。新密钥只会显示一次，你需要安全地转交给对方。</p>
          <p>
            <strong>对方名下所有 App 口令也会一并撤销</strong>（脚本里的「作者通道」要换新口令）——账号被盗期间别人生成的口令不能留着。
          </p>
        </>
      ),
      confirmLabel: "重置密钥",
      danger: true,
    });
    if (!ok) return;
    const result = await run(() => api.resetUserKey(user.id));
    if (!result) return;
    await showSecret({
      title: `${user.name} 的新访问密钥`,
      intro: (
        <p>
          把它安全地交给 {user.name}。旧密钥已经作废，对方需要用新密钥重新登录；他名下的 App 口令都已撤销，脚本里的「作者通道」要让他重新生成。
        </p>
      ),
      items: [{ label: "新的访问密钥", value: result.accessKey }],
    });
  }

  async function resetTotp(user: UserDTO): Promise<void> {
    const ok = await confirmDialog({
      title: `关掉 ${user.name} 的二次验证？`,
      body: <p>用于对方丢了验证器的情况：关掉后他只凭访问密钥就能登录，可以自己重新开启二次验证。</p>,
      confirmLabel: "关掉二次验证",
      danger: true,
    });
    if (!ok) return;
    const done = await run(() => api.resetUserTotp(user.id));
    if (!done) return;
    toast.success(`已关掉 ${user.name} 的二次验证`);
    users.reload();
  }

  async function revoke(invite: InviteDTO): Promise<void> {
    const ok = await confirmDialog({
      title: "撤销这个邀请？",
      body: <p>对应的邀请链接会立刻失效。{invite.note ? `（备注：${invite.note}）` : ""}</p>,
      confirmLabel: "撤销邀请",
      danger: true,
    });
    if (!ok) return;
    const done = await run(() => api.revokeInvite(invite.id));
    if (!done) return;
    toast.success("已撤销邀请");
    invites.reload();
  }

  function userMenu(user: UserDTO): (MenuItem | "separator")[] {
    const menu: (MenuItem | "separator")[] = [{ label: user.disabled ? "重新启用" : "停用账号…", danger: !user.disabled, onSelect: () => void toggleDisabled(user) }];
    menu.push({ label: "重置访问密钥…", onSelect: () => void resetKey(user) });
    if (user.totpEnabled) menu.push({ label: "关掉二次验证…", onSelect: () => void resetTotp(user) });
    return menu;
  }

  return (
    <>
      <PageHeader title="团队" subtitle="谁在维护这个站。账号靠访问密钥登录，没有密码。" />

      <Card title="账号">
        <Async res={users}>
          {(list) => (
            <div class="table-wrap">
              <table class="table">
                <thead>
                  <tr>
                    <th scope="col">名字</th>
                    <th scope="col">角色</th>
                    <th scope="col">二次验证</th>
                    <th scope="col">状态</th>
                    <th scope="col">最后登录</th>
                    <th scope="col">
                      <span class="sr-only">操作</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {list.map((user) => (
                    <tr key={user.id} class={user.disabled ? "is-muted" : undefined}>
                      <th scope="row" data-label="名字">
                        <span class="strong">{user.name}</span> {user.id === me.user.id ? <Badge tone="blue">你</Badge> : null}
                      </th>
                      <td data-label="角色">
                        <RoleBadge role={user.role} />
                      </td>
                      <td data-label="二次验证">{user.totpEnabled ? <Badge tone="green">已开启</Badge> : <span class="muted">未开启</span>}</td>
                      <td data-label="状态">{user.disabled ? <Badge tone="gray">已停用</Badge> : <Badge tone="green">正常</Badge>}</td>
                      <td data-label="最后登录">{user.lastLoginAt ? <TimeCell ms={user.lastLoginAt} /> : <span class="muted">从未登录</span>}</td>
                      <td class="cell-actions" data-label="">
                        {canManage && user.id !== me.user.id ? (
                          <div class="row-actions">
                            <button type="button" class="btn btn-sm" disabled={busy} onClick={() => setRoleFor(user)}>
                              改角色
                            </button>
                            <Menu label={`${user.name} 的更多操作`} items={userMenu(user)} />
                          </div>
                        ) : user.id === me.user.id ? (
                          <span class="muted small">改自己的设置去「我的账号」</span>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Async>
        {!canManage ? <p class="muted small">只有站长能改角色、停用账号、重置密钥。</p> : null}
      </Card>

      <Card
        title="邀请"
        actions={
          canInvite ? (
            <button type="button" class="btn btn-primary btn-sm" onClick={() => setInviting(true)}>
              <Icon name="plus" size={14} />
              邀请新成员
            </button>
          ) : undefined
        }
      >
        <Async res={invites}>
          {(list) =>
            list.length === 0 ? (
              <EmptyState title="还没有发出过邀请" hint="点右上角「邀请新成员」，把生成的链接发给对方。" />
            ) : (
              <div class="table-wrap">
                <table class="table table-compact">
                  <thead>
                    <tr>
                      <th scope="col">角色</th>
                      <th scope="col">备注</th>
                      <th scope="col">状态</th>
                      <th scope="col">有效期至</th>
                      <th scope="col">邀请人</th>
                      <th scope="col">使用者</th>
                      <th scope="col">
                        <span class="sr-only">操作</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {list.map((invite) => {
                      const state = inviteState(invite, Date.now());
                      return (
                        <tr key={invite.id}>
                          <td data-label="角色">
                            <Badge tone={invite.role === "admin" ? "green" : "gray"}>{INVITE_ROLE_NAMES[invite.role]}</Badge>
                          </td>
                          <td data-label="备注">{invite.note || <span class="muted">—</span>}</td>
                          <td data-label="状态">
                            <Badge tone={state === "active" ? "green" : state === "used" ? "blue" : "gray"}>{INVITE_STATE_NAMES[state]}</Badge>
                          </td>
                          <td data-label="有效期至">
                            <TimeCell ms={invite.expiresAt} />
                          </td>
                          <td data-label="邀请人">{invite.createdBy ?? <span class="muted">—</span>}</td>
                          <td data-label="使用者">{invite.usedBy ?? <span class="muted">—</span>}</td>
                          <td class="cell-actions" data-label="">
                            {canInvite && state !== "used" ? (
                              <button type="button" class="btn btn-sm btn-danger-ghost" disabled={busy} onClick={() => void revoke(invite)}>
                                撤销
                              </button>
                            ) : null}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )
          }
        </Async>
        <p class="muted small">邀请令牌只在创建的那一刻显示一次，这里看不到链接；忘了就撤销重新发一个。同时最多 20 个有效邀请。</p>
      </Card>

      {roleFor ? (
        <ChangeRoleDialog
          user={roleFor}
          onClose={() => setRoleFor(null)}
          onDone={() => {
            setRoleFor(null);
            users.reload();
          }}
        />
      ) : null}
      {inviting ? <InviteDialog canInviteAdmin={canManage} onClose={() => setInviting(false)} onCreated={() => invites.reload()} /> : null}
    </>
  );
}
