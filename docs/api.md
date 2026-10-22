# 接口文档

所有接口都在 `/api` 下，分两组：

- **公开接口 `/api/v1`**：给 App（Scripting 脚本）用，不需要登录。
- **后台接口 `/api/admin`**：给管理后台用，需要登录（会话 cookie）。

类型定义以 [`shared/types.ts`](../shared/types.ts) 为准，Worker 和后台前端都从那里 import。

---

## 公开接口 `/api/v1`

### `GET /health`

`{ "ok": true, "time": 1790000000000 }`。数据库连不上时是 500。

### `GET /meta`

脚本里「测试连接」读的（`MetaDTO`）：

```json
{ "name": "JavBus 社区推荐", "version": "1.0.0", "maintenance": false, "autoApprove": true, "channels": { "user": 120, "author": 35 } }
```

### `GET /rec/{user|author}`

公开列表：`user` = 网友推荐，`author` = 作者精选。返回 JSON 数组，**只有四个字段**，最新上线的在最前：

```json
[{ "code": "ABC-123", "info": "ABC-123 | 2026-10-22", "src": "https://…/cover.jpg", "link": "https://…/ABC-123" }]
```

响应头：

| 头 | 说明 |
| --- | --- |
| `ETag: W/"user-17"` | 快照版本，列表每变一次 +1 |
| `Cache-Control: no-cache` | 每次都向服务端确认；没变就只回 `304`（不带正文），App 刷新能立刻看到新条目 |
| `X-Total-Count` | 条数 |

带 `If-None-Match`（可以是多个、可以带 `W/` 前缀、可以是 `*`）且没变，回 `304`。允许任意网页跨域读取。

### `POST /upload/{user|author}`

**和原作者的 Google Apps Script 兼容**：请求体 `{ "av": …, "mode": "upload" | "del", "pw"?: string }`，响应是**纯文本返回码**。

- 上传：`av` 是整条记录 `{ code, info?, src?, link }`；
- 撤销：`av` 只是番号字符串；
- `pw`：维护者在后台「我的账号」里生成的 **App 口令**（`jca_…`）。

请求头 `X-Device-Id`（可选）：脚本随机生成并存在本地的设备号，8–64 位 `[A-Za-z0-9_-]`。服务端只存它的加盐哈希；用来按设备限频、识别「自己提交的」（用于自助撤销）。不合格式的当没带。

返回码（HTTP 状态码随之变化，App 只读响应正文）：

| 正文 | HTTP | 含义 |
| --- | --- | --- |
| `succeed` | 200 | 成功 |
| `PD` | 202 | 已收下，等维护者审核后公开（后台关了「网友推荐直接上线」时） |
| `FE` | 400 | 格式错误（番号 / 地址不合格、含屏蔽词、地址不在允许名单、请求体不是 JSON 或超过 8 KB……） |
| `NA` | 401 | 没有权限：作者频道没给口令 / 口令不对；撤销时不是你提交的 / 超过了自助撤销期限 |
| `BN` | 403 | 设备 / IP / 番号被封禁 |
| `NF` | 404 | 没有这一条（撤销时） |
| `RE` | 409 | 已经在列表里（番号查重不分大小写；待审 / 已隐藏的也算） |
| `RL` | 429 | 太频繁：按设备 / IP（IPv6 按 /64）的提交频率限制，或每天总闸（所有人加起来每天最多收多少条，只数真正要入库的）；口令连续试错也会触发 |
| `FULL` | 507 | 这份列表装满了 |
| `OFF` | 503 | 维护模式，暂停收稿 |

规则：

- **作者频道**（`author`）上传 / 撤销都必须带有效口令。
- **网友频道**（`user`）上传不需要口令。带了有效口令 = 维护者提交：直接上线，不受限频 / 屏蔽词 / 网站名单 / 维护模式限制。
- **撤销**：带口令 = 维护者删除（任一频道）；不带口令只能撤销**自己（同一个设备）在期限内提交的、还在线或待审的网友推荐**（期限在后台设置，默认 7 天）。
- 之前被**拒绝**的番号允许重新提交（原地覆盖成新的）；被**隐藏**的不允许（RE）。

### `POST /report`

举报一个已上线的条目。请求体 `{ "channel": "user" | "author", "code": "ABC-123", "reason"?: "dead" | "inappropriate" | "duplicate" | "other", "detail"?: string }`，带 `X-Device-Id`。

返回码同上：`succeed`（也包括「你已经举报过」，不暴露）、`FE`、`NF`（条目不存在或已不在线）、`BN`、`RL`。

同一个人（设备号；没带设备号时按 IP）对同一个条目只算一次。**举报数按「不同的 IP」算**（IPv6 按 /64）：设备号是 App 自己报的、谁都能编，换几个设备号不算多个人。
举报数到阈值（默认 3）后，**网友推荐**的条目自动隐藏、进后台待复核；**作者精选不自动隐藏**，只进待复核、举报数照常显示。

---

## 后台接口 `/api/admin`

约定：

- 请求体和响应都是 JSON（`GET /export` 是文件下载）。
- 登录靠 cookie `jc_session`（`HttpOnly`、`SameSite=Strict`，本地 http 开发时不带 `Secure`）。
- **所有改数据的请求（非 GET）必须带请求头 `X-JC-Admin: 1`**，带了 `Origin` 的还必须和本站同源，否则 `403 csrf`。
- 响应带 `Cache-Control: no-store`。
- 出错统一是 `{ "error": { "code": "…", "message": "给人看的中文", "details"?: … } }`。

常见错误码：

| HTTP | code | 说明 |
| --- | --- | --- |
| 400 | `bad_json` / `bad_body` / `bad_id` | 请求体不是 JSON / 不是对象 / id 不对 |
| 401 | `unauthorized` | 没登录 / 会话过期 / 账号被停用 |
| 401 | `invalid_key` / `totp_required` / `totp_invalid` | 登录失败三种情形；`totp_invalid` 在已登录时开启 / 关闭二次验证（`/me/totp/enable`、`/me/totp/disable`）填错验证码也会返回——客户端只应把 `unauthorized` 当成掉线 |
| 403 | `forbidden` / `csrf` / `disabled` | 权限不够 / 缺 `X-JC-Admin` 头 / 账号停用 |
| 404 | `not_found` | 没有这个资源 |
| 409 | `exists` / `list_full` / `self` / `last_owner` … | 冲突 |
| 413 | `too_large` | 请求体太大 |
| 422 | `invalid_*` | 参数不合法；`invalid_settings` 的 `details.fields` 是 `{ 设置项: 原因 }` |
| 429 | `rate_limited` | 尝试太频繁 |

### 不需要登录

| 接口 | 说明 |
| --- | --- |
| `GET /setup-status` | `SetupStatusDTO`：`needsSetup`（还没有任何账号）、`tokenConfigured`（服务端配置了 `SETUP_TOKEN`）、`siteName` |
| `POST /setup` `{ token, name }` | 首次安装：凭服务端的 `SETUP_TOKEN` 创建站长。成功返回 `LoginResultDTO`（**`accessKey` 只此一次**）并直接登录。创建后永久关闭（409 `already_setup`）。按 IP 限频 10 次 / 小时 |
| `POST /login` `{ key, totp? }` | 凭访问密钥登录。开了二次验证的账号第一次不带 `totp` 会得到 `401 totp_required`，带上 6 位验证码再试。按 IP 限频 30 次 / 10 分钟；验证码 10 分钟内最多试 5 次（先占名额再校验，输对清零） |
| `POST /logout` | 退出，作废会话 |
| `GET /invite?token=…` | `InviteInfoDTO`：邀请是否有效、角色、备注 |
| `POST /join` `{ token, name }` | 凭邀请令牌创建账号（角色由邀请决定），返回 `LoginResultDTO`（含 `accessKey`）并直接登录。令牌一次有效 |

名字：2–24 个字，只能用文字、数字和 `_ . -`，不分大小写、不能重复；会先做 NFKC 规整（全角字母 → 普通字母）；不能含看不见的字符；`system`、`app` 是保留名。

### 我的账号

| 接口 | 说明 |
| --- | --- |
| `GET /me` | `MeDTO`：`user` + `permissions`（权限列表，前端据此显示 / 隐藏功能） |
| `POST /me/rotate-key` | 换访问密钥，返回 `{ accessKey }`；旧密钥作废，除当前以外的会话被踢下线 |
| `POST /me/totp/start` | 开始设置二次验证，返回 `{ secret, uri }`（`uri` 是 `otpauth://`，可以画成二维码） |
| `POST /me/totp/enable` `{ code }` | 输入验证器里的验证码，确认开启 |
| `POST /me/totp/disable` `{ code }` | 输入验证码，关闭 |
| `GET /me/app-keys` | 我的 App 口令列表（`AppKeyDTO[]`，不含明文） |
| `POST /me/app-keys` `{ name }` | 新建口令，`201` + `{ key, appKey }`（**明文 `key` 只此一次**）。最多同时 10 个有效 |
| `DELETE /me/app-keys/:id` | 撤销 |

### 条目

| 接口 | 权限 | 说明 |
| --- | --- | --- |
| `GET /items` | 登录 | 查询参数：`channel`、`status`（`pending/approved/rejected/hidden`）、`check`（`unchecked/ok/warn/dead`）、`reported=1`、`q`（番号或 info 里的文字，`%` `_` 按字面量）、`sort`（`new/old/updated/checked/reports`）、`page`、`pageSize`（≤100）。返回 `Paged<ItemDTO>` |
| `GET /items/:id` | 登录 | `ItemDTO` |
| `GET /items/:id/cover` | 登录 | 这个条目的封面图（后台页面显示封面用）。服务端带上详情页所在站的 `Referer` 去取（防盗链；被 403 再换封面自己所在的站试一次），把图片流原样转回：只回位图（SVG 不回），`Cache-Control: private, max-age=86400`，响应头带 `default-src 'none'` 的 CSP。没有这个条目 / 没有封面 `404`（`no_cover`），取不到 `502 cover_unavailable`。只代理库里条目自己的 `src`，不接受任意地址。`<img>` 发的是 GET，不需要 `X-JC-Admin` |
| `POST /items` | `items.moderate` | `{ channel, code, info?, src?, link, status?: "approved" \| "pending", note? }`，`201` + `ItemDTO`。不受屏蔽词 / 网站名单限制；重复 `409 exists`；列表满 `409 list_full` |
| `PATCH /items/:id` | `items.moderate` | 可改 `code / info / src / link / note / channel`（改频道 = 移到另一份列表）。改了地址会清掉检查结果 |
| `POST /items/status` | `items.moderate` | `{ ids: number[≤100], status: "approved" \| "rejected" \| "hidden" }` → `{ changed }`。隐藏 / 拒绝会把该条目没处理的举报一并标成已处理。通过时列表满 `409 list_full` |
| `POST /items/delete` | `items.moderate` | `{ ids }` → `{ deleted }`，连同举报一起删 |
| `POST /items/import` | `transfer` | `{ channel, status?: "approved" \| "pending", items: [...], order?: { base, offset } }`，**一次最多 1000 条**（更大的文件由前端分批）。宽松校验：`info` 过长截断，不查屏蔽词 / 网站名单；已存在的跳过。数组顺序 = 上线后的显示顺序（第一条排最前）。<br>**分批导入时必须带 `order`**，否则批次之间的先后会反（每批以「导入那一刻」为基准，后导的批次时间更晚、整批排到前面）：整个文件用同一个 `base`（开始导入时的毫秒时间戳，必须在一天以内、不能在未来），`offset` 是这一批前面有多少条（用原文件里的位置，不是去重后的）。带了 `order` 以后发送顺序和重试都不影响最终顺序。不合法 → `422 invalid_import`。返回 `ImportResultDTO` |
| `POST /items/import/fetch` | `transfer` | `{ url }`：服务端代为下载一份远程 JSON 列表（只收 https 公网地址，≤4 MB，10 秒超时），返回 `{ items, invalid }`。**只做最便宜的结构检查**（是对象、有字符串的 `code` 和 `link`；不合格的计入 `invalid`），`items` 是原样的条目——真正的校验（番号格式、地址、截断过长的 info）在分批调 `/items/import` 时做：免费版每次调用只有 10 毫秒 CPU，一个请求里把两万条都校验一遍放不下。导入原作者在 GitLab 上的两份列表用 |
| `GET /export` | `transfer` | 可选 `channel`、`status`。下载 JSON 文件 `{ app, version, exportedAt, truncated, items: [{ channel, code, info, src, link, status, note, createdAt }] }`，**单次最多 6000 条**（超过的 `truncated` 为 `true`，按频道 / 状态分开导出）；JSON 在 SQL 里拼好，不占 Worker 的 CPU；可以原样导回去 |

### 举报

| 接口 | 权限 | 说明 |
| --- | --- | --- |
| `GET /reports` | `reports.resolve` | `status`（`open/resolved/dismissed`，不传 = 全部）、`page`、`pageSize`。`Paged<ReportDTO>`（带条目的番号 / 状态 / 标题 / 封面；`reporter` 是设备号的 16 位哈希，`ipHash` 是 IP 的 16 位哈希——「举报人数」按 `ipHash` 去重算，同一个 `ipHash` 下换设备号只算一个人） |
| `POST /reports/resolve` | `reports.resolve` | `{ itemId, action: "hide" \| "dismiss" \| "delete" }`：对这个条目的**全部**未处理举报统一处理。`hide` 隐藏条目；`dismiss` 驳回举报（条目是被举报自动隐藏的就同时恢复上线）；`delete` 删除条目 |

### 自动检查

| 接口 | 权限 | 说明 |
| --- | --- | --- |
| `GET /checks` | `checks.run` | `{ runs: CheckRunDTO[]（最近 30 次，新的在前）, remaining }`，`remaining` = 按「复查间隔」还有多少个条目到期没查 |
| `POST /checks/run` | `checks.run` | 手动查一批，返回 `{ run, remaining }`（没有可查的 `run` 为 `null`）。三种用法：<br>• 空 `{}`：查最久没查的一批（数量 = 设置里的「每次检查几个条目」，可用 `limit` 临时改）；<br>• `{ itemIds }`：查指定的几条（≤25，待审的也行）；<br>• `{ olderThan: 毫秒时间戳 }`（需 `checks.runAll`）：只查「这个时刻之后还没查过」的。**「全部检查」**就是前端记下开始时刻，反复调用直到 `remaining` 为 0 |

检查规则（定时任务和手动一样）：封面和详情页地址各请求一次，**404 / 410 = 失效**，**2xx = 正常**（封面还要求返回的是图片），**其余（403 / 429 / 5xx / 超时 / 网络错误 / 封面返回了网页）= 存疑**，只做标记。
**详情页被站点的年龄验证页挡住**（JavBus 一类站点：没有验证 cookie 时所有详情页都跳到 `/doc/driver-verify` 并返回 200）= **没法检查**：这一项不参与判定，只看封面；一项都没法判断（只剩被挡住的链接，或没有可查的地址）时记成「没查成」（`checkStatus` 是 `unchecked`，`checkDetail` 写明原因）——不是「正常」：不会清零失效计数，也不会触发自动恢复。
一批最多 **25** 个条目（`limit` 填再大也封顶；指定 `itemIds` 时有几个查几个，不被设置里的批量截断）；子请求额度用完时没发出去的条目这次不算查过。
自动隐藏有三道保险：① 连续失效达到阈值（默认 3 次）才隐藏；② 「连续」要隔得开：两次失效之间至少隔半个复查间隔才都算数；③ 一批里几乎全判成失效（≥ 5 条且 ≥ 80%）整批改判存疑、不累计（手动指定 `itemIds` 时不做这条）。因失效被隐藏的，恢复正常后自动放回来。

### 设置

| 接口 | 权限 | 说明 |
| --- | --- | --- |
| `GET /settings` | 登录 | `{ settings }`（`Settings`） |
| `PUT /settings` | `settings.write` | 可以只带要改的几项；不合法的一次性全报（`422 invalid_settings`，`details.fields`）；整批都不生效。取值范围见 `SETTING_FIELDS` |

### 团队

| 接口 | 权限 | 说明 |
| --- | --- | --- |
| `GET /users` | `users.read` | `UserDTO[]` |
| `PATCH /users/:id` | `users.manage` | `{ role?, disabled? }`。不能改自己；停用会踢下线并让对方的 App 口令失效；改角色 / 停用会作废他发出去还没用的邀请；至少留一位启用中的站长（「还有别的站长」写在同一条 UPDATE 里判断，两位站长同时互降也不会一个都不剩，`409 last_owner`） |
| `POST /users/:id/reset-key` | `users.manage` | 重置访问密钥，返回 `{ accessKey }`（只此一次），对方会话全部踢下线、**他的 App 口令全部撤销**（账号被盗期间攻击者生成的口令不能留着） |
| `POST /users/:id/reset-totp` | `users.manage` | 关掉对方的二次验证（对方丢了验证器时） |
| `GET /invites` | `users.read` | `InviteDTO[]`（最近 100 个） |
| `POST /invites` | `users.inviteModerator` | `{ role: "admin" \| "moderator", note?, days?: 1–30（默认 7） }` → `201` + `{ token, invite }`（**`token` 只此一次**，邀请链接是 `/#/join?token=…`）。邀请管理员需要 `users.manage`。同时最多 20 个有效邀请 |
| `DELETE /invites/:id` | `users.inviteModerator` | 撤销没用过的邀请；`:id` 是 `InviteDTO.id` |

### 概览、日志、封禁

| 接口 | 权限 | 说明 |
| --- | --- | --- |
| `GET /stats` | 登录 | `StatsDTO`：各频道各状态数量、检查结果统计（只算已上线的）、未处理举报的条目数、最近 30 天（UTC 日期）每天新增数、最近一次检查、维护者数 |
| `GET /audit` | `audit.read` | `action`、`actor`（不分大小写）、`page`、`pageSize`。`Paged<AuditDTO>`，新的在前；`total` 最多显示 10000（没有筛选时 COUNT 要扫全表）。App 里的匿名提交不记日志，只记维护者的操作、自助撤销和系统动作 |
| `GET /bans` | `bans.manage` | `BanDTO[]` |
| `POST /bans` | `bans.manage` | `{ kind: "device" \| "ip" \| "code", value, reason?, purge?: boolean }`。`device` / `ip` 的 `value` 是条目里看到的 16 位哈希（`ItemDTO.submitter` / `ipHash`）；`code` 是番号。`purge` = 顺手清掉对方已有的条目（已上线 → 隐藏，待审 → 拒绝）。`201` + `{ ok, purged }` |
| `DELETE /bans/:kind/:value` | `bans.manage` | 解封 |

### 权限

三个角色，权限逐级包含（矩阵在 `shared/types.ts` 的 `can()`，前端用同一份）：

| 权限 | 协管 | 管理员 | 站长 |
| --- | :-: | :-: | :-: |
| `items.moderate` 审核条目（新增 / 编辑 / 通过 / 拒绝 / 隐藏 / 删除） | ✓ | ✓ | ✓ |
| `reports.resolve` 处理举报 | ✓ | ✓ | ✓ |
| `checks.run` 手动检查一批 / 指定条目 | ✓ | ✓ | ✓ |
| `audit.read` 看操作日志 | ✓ | ✓ | ✓ |
| `checks.runAll` 全部检查 | | ✓ | ✓ |
| `bans.manage` 封禁 | | ✓ | ✓ |
| `settings.write` 改站点设置 | | ✓ | ✓ |
| `transfer` 导入 / 导出 | | ✓ | ✓ |
| `users.read` 看账号和邀请 | | ✓ | ✓ |
| `users.inviteModerator` 邀请协管 | | ✓ | ✓ |
| `users.manage` 管理所有账号（邀请管理员、改角色、停用、重置密钥） | | | ✓ |

### 操作日志里的动作名

`user.setup` `user.login` `user.join` `user.update` `user.reset_key` `user.reset_totp` `user.rotate_key` `user.totp_enable` `user.totp_disable`
`invite.create` `invite.revoke` `appkey.create` `appkey.revoke`
`item.submit`（App 提交）`item.create` `item.edit` `item.approve` `item.reject` `item.hide` `item.delete` `item.self_delete`（提交者自助撤销）`item.import` `item.auto_hide_reports` `item.expire_pending`
`report.hide` `report.dismiss` `report.delete`
`check.run` `check.visibility`（自动隐藏 / 恢复）
`settings.update` `ban.add` `ban.remove`

`actor` 是维护者名字；`system` = 定时任务 / 自动规则；`app` = 脚本里的提交。
