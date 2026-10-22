-- 社区推荐服务的表结构。时间一律是毫秒级的 Unix 时间戳。
--
-- 几个表分别管什么：
--   users / app_keys / sessions / invites   维护者账号：访问密钥登录（不是密码），邀请链接加人，App 口令给脚本里的「作者通道」用
--   items                                   推荐条目（网友推荐 user / 精选 author），状态：待审 / 已上线 / 已拒绝 / 已隐藏
--   reports                                 用户举报（一个设备对一个条目只能举报一次）
--   banned                                  封禁：设备 / IP（都是哈希）/ 番号
--   settings / audit_log / check_runs       站点设置、操作日志、自动检查的运行记录
--   snapshots                               公开列表的快照（App 拉的 JSON 整份存一行，读列表只读一行）
--   rate_limits                             提交 / 举报 / 登录的频率限制计数

CREATE TABLE users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT    NOT NULL COLLATE NOCASE UNIQUE,
  role          TEXT    NOT NULL CHECK (role IN ('owner', 'admin', 'moderator')),
  key_hash      TEXT    NOT NULL UNIQUE,            -- 访问密钥的 SHA-256（密钥本身 256 位随机，不需要慢哈希）
  totp_secret   TEXT    NOT NULL DEFAULT '',        -- base32；空 = 没设置过
  totp_enabled  INTEGER NOT NULL DEFAULT 0,
  disabled      INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  created_by    INTEGER REFERENCES users (id) ON DELETE SET NULL,
  last_login_at INTEGER
);

CREATE TABLE app_keys (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  name         TEXT    NOT NULL,
  key_hash     TEXT    NOT NULL UNIQUE,
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked      INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE sessions (
  id_hash      TEXT    PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  ip_hash      TEXT    NOT NULL DEFAULT '',
  user_agent   TEXT    NOT NULL DEFAULT ''
);
CREATE INDEX sessions_expires ON sessions (expires_at);

CREATE TABLE invites (
  token_hash TEXT    PRIMARY KEY,
  role       TEXT    NOT NULL CHECK (role IN ('admin', 'moderator')),
  note       TEXT    NOT NULL DEFAULT '',
  created_by INTEGER REFERENCES users (id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_by    INTEGER REFERENCES users (id) ON DELETE SET NULL,
  used_at    INTEGER
);

CREATE TABLE items (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  channel       TEXT    NOT NULL CHECK (channel IN ('user', 'author')),
  code          TEXT    NOT NULL,                   -- 番号，原样存（脚本按原样比对角标），查重时不分大小写
  info          TEXT    NOT NULL,
  src           TEXT    NOT NULL DEFAULT '',        -- 封面地址
  link          TEXT    NOT NULL,                   -- 详情页地址
  status        TEXT    NOT NULL DEFAULT 'approved' CHECK (status IN ('pending', 'approved', 'rejected', 'hidden')),
  hidden_reason TEXT    NOT NULL DEFAULT '',        -- '' / manual / reports / check：为什么被隐藏
  note          TEXT    NOT NULL DEFAULT '',        -- 维护者的备注
  submitter     TEXT    NOT NULL DEFAULT '',        -- 提交者设备号的哈希；空 = 维护者建的 / 导入的
  ip_hash       TEXT    NOT NULL DEFAULT '',
  created_by    INTEGER REFERENCES users (id) ON DELETE SET NULL,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  reviewed_by   INTEGER REFERENCES users (id) ON DELETE SET NULL,
  reviewed_at   INTEGER,
  report_count  INTEGER NOT NULL DEFAULT 0,
  check_status  TEXT    NOT NULL DEFAULT 'unchecked' CHECK (check_status IN ('unchecked', 'ok', 'warn', 'dead')),
  check_detail  TEXT    NOT NULL DEFAULT '',
  check_fail    INTEGER NOT NULL DEFAULT 0,         -- 连续判成「失效」的次数
  checked_at    INTEGER
);
CREATE UNIQUE INDEX items_channel_code ON items (channel, code COLLATE NOCASE);
CREATE INDEX items_channel_status_created ON items (channel, status, created_at DESC, id DESC);
CREATE INDEX items_status_checked ON items (status, checked_at);
CREATE INDEX items_submitter ON items (submitter);

CREATE TABLE reports (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id     INTEGER NOT NULL REFERENCES items (id) ON DELETE CASCADE,
  reason      TEXT    NOT NULL DEFAULT '',          -- dead / inappropriate / duplicate / other
  detail      TEXT    NOT NULL DEFAULT '',
  reporter    TEXT    NOT NULL,                     -- 设备号的哈希；没带设备号时用 IP 哈希
  ip_hash     TEXT    NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL,
  status      TEXT    NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'dismissed')),
  resolved_by INTEGER REFERENCES users (id) ON DELETE SET NULL,
  resolved_at INTEGER,
  resolution  TEXT    NOT NULL DEFAULT ''
);
CREATE UNIQUE INDEX reports_item_reporter ON reports (item_id, reporter);
CREATE INDEX reports_status_created ON reports (status, created_at DESC);

CREATE TABLE banned (
  kind       TEXT    NOT NULL CHECK (kind IN ('device', 'ip', 'code')),
  value      TEXT    NOT NULL COLLATE NOCASE,
  reason     TEXT    NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  created_by INTEGER REFERENCES users (id) ON DELETE SET NULL,
  PRIMARY KEY (kind, value)
);

CREATE TABLE settings (
  key        TEXT    PRIMARY KEY,
  value      TEXT    NOT NULL,                      -- JSON
  updated_at INTEGER NOT NULL
);

CREATE TABLE audit_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  at          INTEGER NOT NULL,
  user_id     INTEGER REFERENCES users (id) ON DELETE SET NULL,
  actor       TEXT    NOT NULL,                     -- 维护者名字 / system（定时任务）/ app（脚本里的提交）
  action      TEXT    NOT NULL,
  target_type TEXT    NOT NULL DEFAULT '',
  target_id   TEXT    NOT NULL DEFAULT '',
  detail      TEXT    NOT NULL DEFAULT '',          -- JSON
  ip_hash     TEXT    NOT NULL DEFAULT ''
);
CREATE INDEX audit_at ON audit_log (at DESC, id DESC);
CREATE INDEX audit_action ON audit_log (action, at DESC);

CREATE TABLE check_runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at  INTEGER NOT NULL,
  finished_at INTEGER,
  trigger     TEXT    NOT NULL CHECK (trigger IN ('cron', 'manual')),
  user_id     INTEGER REFERENCES users (id) ON DELETE SET NULL,
  examined    INTEGER NOT NULL DEFAULT 0,
  ok          INTEGER NOT NULL DEFAULT 0,
  warn        INTEGER NOT NULL DEFAULT 0,
  dead        INTEGER NOT NULL DEFAULT 0,
  hidden      INTEGER NOT NULL DEFAULT 0,
  note        TEXT    NOT NULL DEFAULT ''
);

CREATE TABLE snapshots (
  channel    TEXT    PRIMARY KEY CHECK (channel IN ('user', 'author')),
  version    INTEGER NOT NULL,                          -- 每次重建 +1，当 ETag 用
  count      INTEGER NOT NULL,
  bytes      INTEGER NOT NULL,                          -- body 的 UTF-8 字节数：D1 单行上限 2 MB，收稿前据此判断「满了没有」
  body       TEXT    NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE rate_limits (
  key        TEXT    PRIMARY KEY,
  count      INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX rate_limits_expires ON rate_limits (expires_at);
