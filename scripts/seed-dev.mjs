#!/usr/bin/env node
// 本地开发用的种子数据：往本地跑着的 Worker 里造一批各种状态的条目 / 举报 / 邀请 / 封禁，方便在后台里肉眼验证各个页面。
//
// 怎么跑（Windows + Git Bash 也行）：
//   1. npm run db:migrate:local         # 建本地库（只需要第一次）
//   2. npm run build:admin              # 构建后台页面
//   3. npx wrangler dev --port 8787     # 起本地服务（要有 .dev.vars：SETUP_TOKEN="dev-setup-token"）
//   4. node scripts/seed-dev.mjs        # 另开一个终端，跑这个脚本
//   然后在浏览器里打开 http://localhost:8787/ ，用脚本保存的访问密钥登录（见下面「访问密钥」）。
//
// 可选参数 / 环境变量：
//   --base http://127.0.0.1:8787   服务地址（也可以用环境变量 JC_BASE）。默认就是这个：用 127.0.0.1 而不是 localhost，
//                                  因为 Node 的 fetch 会先试 IPv6 的 ::1，而 wrangler dev 只监听 127.0.0.1
//   --show-key                     把三个账号的访问密钥直接打印出来（默认只写进文件，不打印）
//   SETUP_TOKEN                    安装口令，默认 dev-setup-token（要和 .dev.vars 里的一致）
//   JC_KEY                         站长账号已经建好、本地又没有密钥文件时，用它登录
//
// 访问密钥：脚本会把站长、管理员、协管三个账号的访问密钥存进 .wrangler/dev-keys.json
// （.wrangler/ 已经在 .gitignore 里，只是本地开发文件）。想重来一遍：停掉 wrangler dev，删掉 .wrangler/state，重新迁移。
//
// 脚本可以重复跑：已经存在的条目 / 账号会被跳过（番号查重、名字查重），不会越跑越多。
// 注意：造「待审」条目时会临时关掉「网友推荐直接上线」，造完立刻恢复。
// 检查那一步会让本地 Worker 真的去访问 example.com 之类的网站，需要能上外网；连不上只会得到「存疑」，不影响别的。

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ———— 参数 ————

const args = process.argv.slice(2);
function option(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}
// 默认用 127.0.0.1 而不是 localhost：Node 的 fetch 会先试 IPv6 的 ::1，而 wrangler dev 只监听 127.0.0.1，用 localhost 会连不上
const BASE = (option("--base") ?? process.env.JC_BASE ?? "http://127.0.0.1:8787").replace(/\/+$/, "");
/** 给人看的地址（浏览器里用 localhost 打开更顺手）。 */
const SHOWN_BASE = BASE.replace("//127.0.0.1", "//localhost");
const SHOW_KEY = args.includes("--show-key");
const SETUP_TOKEN = process.env.SETUP_TOKEN ?? "dev-setup-token";
const KEY_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".wrangler", "dev-keys.json");

// ———— 小工具 ————

function fail(message) {
  console.error(`\n✗ ${message}`);
  process.exit(1);
}

/** 带 cookie 的后台请求。session = 要带的 cookie（name=value）。 */
async function adminRequest(session, method, route, body) {
  const headers = { "X-JC-Admin": "1", Accept: "application/json" };
  if (session) headers.Cookie = session;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(`${BASE}/api/admin${route}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  if (!response.ok) {
    const error = new Error(`${method} ${route} → ${response.status} ${data?.error?.code ?? ""} ${data?.error?.message ?? text.slice(0, 120)}`);
    error.status = response.status;
    error.code = data?.error?.code;
    throw error;
  }
  return { data, response };
}

/** 从登录 / 安装 / 加入的响应里取出会话 cookie。 */
function sessionOf(response) {
  const cookies = typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : [response.headers.get("set-cookie") ?? ""];
  for (const cookie of cookies) {
    const match = /(jc_session=[^;]+)/.exec(cookie);
    if (match) return match[1];
  }
  return "";
}

/**
 * 给每个「人」（设备号）编一个 IP。服务端的限频、举报计数都按「不同的 IP」算，IP 取自 Cloudflare 边缘写的 CF-Connecting-IP 头；
 * 本地没有边缘，请求里没有这个头，所有人都会被算成同一个 IP（举报永远凑不够阈值）。所以脚本自己带上，用文档专用的 198.51.100.x 地址段。
 */
function ipOf(who) {
  let sum = 0;
  for (const ch of who) sum += ch.charCodeAt(0);
  return `198.51.100.${1 + (sum % 250)}`;
}

function publicHeaders(device) {
  return { "Content-Type": "application/json", "X-Device-Id": device, "CF-Connecting-IP": ipOf(device) };
}

/** 走公开接口提交（像 App 一样，带设备号）。返回响应正文里的返回码。 */
async function submit(channel, device, item) {
  const response = await fetch(`${BASE}/api/v1/upload/${channel}`, {
    method: "POST",
    headers: publicHeaders(device),
    body: JSON.stringify({ mode: "upload", av: item }),
  });
  return (await response.text()).trim();
}

async function report(channel, device, code, reason, detail) {
  const response = await fetch(`${BASE}/api/v1/report`, {
    method: "POST",
    headers: publicHeaders(device),
    body: JSON.stringify({ channel, code, reason, detail }),
  });
  return (await response.text()).trim();
}

/** 容忍「已存在」之类的预期错误，其它错误照常抛。 */
async function tolerate(codes, work) {
  try {
    return await work();
  } catch (error) {
    if (error.code && codes.includes(error.code)) return undefined;
    throw error;
  }
}

function step(title) {
  console.log(`\n▸ ${title}`);
}

// ———— 造数据用的素材 ————

const COVER = (seed) => `https://picsum.photos/seed/jc-${seed}/300/400`;
const today = new Date().toISOString().slice(0, 10);

/** 一条正常的条目。link 带个查询串：example.com 根路径返回 200，带查询串也一样，所以检查会判「正常」。 */
function item(code, extra = {}) {
  return { code, info: `${code} | ${today} | 种子数据`, src: COVER(code), link: `https://example.com/?c=${code}`, ...extra };
}

// ———— 开始 ————

async function main() {
  console.log(`服务地址：${BASE}`);

  // 0. 连得上吗
  let status;
  try {
    status = (await adminRequest(undefined, "GET", "/setup-status")).data;
  } catch (error) {
    if (error.status === undefined) fail(`连不上 ${BASE}。先在另一个终端运行：npx wrangler dev --port 8787（并且已经 npm run build:admin）。端口不是 8787 的话用 --base 指定`);
    throw error;
  }

  // 1. 站长：没建过就用安装口令建；建过就用保存的密钥登录
  step("站长账号");
  const keys = await readFile(KEY_FILE, "utf8").then(JSON.parse, () => ({}));
  let session;
  if (status.needsSetup) {
    if (!status.tokenConfigured) fail("服务端没有配置 SETUP_TOKEN：在项目根目录建 .dev.vars，写一行 SETUP_TOKEN=\"dev-setup-token\"，重启 wrangler dev");
    const { data, response } = await adminRequest(undefined, "POST", "/setup", { token: SETUP_TOKEN, name: "dev-owner" });
    session = sessionOf(response);
    keys.owner = { name: "dev-owner", key: data.accessKey };
    console.log("  已创建站长 dev-owner");
  } else {
    const key = process.env.JC_KEY ?? keys.owner?.key;
    if (!key) fail("站长账号已经存在，但本地没有保存它的访问密钥：用环境变量 JC_KEY 传进来，或者删掉 .wrangler/state 重新来过");
    const { response } = await adminRequest(undefined, "POST", "/login", { key });
    session = sessionOf(response);
    keys.owner = keys.owner ?? { name: "(已有的站长)", key };
    console.log("  站长已存在，已用保存的密钥登录");
  }
  if (!session) fail("没拿到会话 cookie");
  const admin = (method, route, body) => adminRequest(session, method, route, body).then((r) => r.data);

  // 2. 作者精选：维护者直接新增（已上线 / 待审）
  step("作者精选里的条目（维护者新增）");
  for (let n = 1; n <= 8; n++) {
    const code = `AUTH-${String(n).padStart(3, "0")}`;
    await tolerate(["exists"], () => admin("POST", "/items", { channel: "author", ...item(code, { info: `${code} | 作者精选 | ${today}` }) }));
  }
  for (let n = 9; n <= 10; n++) {
    const code = `AUTH-${String(n).padStart(3, "0")}`;
    await tolerate(["exists"], () => admin("POST", "/items", { channel: "author", status: "pending", note: "等复核再上线", ...item(code) }));
  }
  console.log("  作者精选：8 条已上线 + 2 条待审");

  // 3. 网友推荐：批量导入 60 条（够翻几页），再用公开接口像 App 一样提交几条
  step("网友推荐里的条目（导入 60 条 + App 提交）");
  const bulk = Array.from({ length: 60 }, (_, i) => item(`USR-${String(i + 1).padStart(3, "0")}`));
  const imported = await admin("POST", "/items/import", { channel: "user", status: "approved", items: bulk, order: { base: Date.now(), offset: 0 } });
  console.log(`  导入：收到 ${imported.received}，新增 ${imported.inserted}，跳过 ${imported.skipped}`);

  const settingsBefore = (await admin("GET", "/settings")).settings;
  const restore = settingsBefore.autoApproveUser;
  await admin("PUT", "/settings", { autoApproveUser: false });
  const results = [];
  try {
    // 关了「直接上线」：这几条先进待审
    for (const [i, device] of ["seed-device-pending-01", "seed-device-pending-01", "seed-device-pending-02", "seed-device-pending-02", "seed-device-pending-03"].entries()) {
      const code = `PEND-${String(i + 1).padStart(3, "0")}`;
      results.push(`${code}:${await submit("user", device, item(code, { info: `${code} | 等审核 | ${today}` }))}`);
    }
    // 让「检查」有东西可判：一条链接 404（失效）、一条域名连不上（存疑）、一条封面不是图片（存疑）
    results.push(`PEND-DEAD:${await submit("user", "seed-device-pending-03", item("PEND-DEAD", { info: "PEND-DEAD | 详情页 404 | 待审", link: "https://example.com/gone/PEND-DEAD" }))}`);
    results.push(`PEND-WARN:${await submit("user", "seed-device-pending-03", item("PEND-WARN", { info: "PEND-WARN | 域名连不上 | 待审", link: "https://seed-no-such-host.invalid/PEND-WARN" }))}`);
  } finally {
    await admin("PUT", "/settings", { autoApproveUser: restore });
  }
  // 恢复「直接上线」之后再提交几条（这些带设备哈希，条目管理里能看到「提交者」）
  for (const [i, device] of ["seed-device-live-01", "seed-device-live-01", "seed-device-live-02", "seed-device-live-02", "seed-device-live-02"].entries()) {
    const code = `LIVE-${String(i + 1).padStart(3, "0")}`;
    results.push(`${code}:${await submit("user", device, item(code, { info: `${code} | App 提交 | ${today}` }))}`);
  }
  // 几条会被判成失效 / 存疑的已上线条目
  results.push(`LIVE-DEAD:${await submit("user", "seed-device-live-03", item("LIVE-DEAD", { info: "LIVE-DEAD | 详情页 404 | 已上线", link: "https://example.com/gone/LIVE-DEAD" }))}`);
  results.push(`LIVE-WARN:${await submit("user", "seed-device-live-03", item("LIVE-WARN", { info: "LIVE-WARN | 封面是网页 | 已上线", src: "https://example.com/?cover=html" }))}`);
  results.push(`LIVE-HOST:${await submit("user", "seed-device-live-03", item("LIVE-HOST", { info: "LIVE-HOST | 域名连不上 | 已上线", link: "https://seed-no-such-host.invalid/LIVE-HOST" }))}`);
  console.log(`  App 提交结果（succeed = 已上线，PD = 进待审，RE = 已存在，RL = 被限频）：\n  ${results.join("  ")}`);

  // 4. 手动改几个状态：隐藏 / 拒绝
  step("几个已隐藏 / 已拒绝的条目");
  const list = (await admin("GET", "/items?channel=user&pageSize=100&sort=old")).items;
  const byCode = (code) => list.find((entry) => entry.code === code);
  const hide = ["USR-001", "USR-002"].map(byCode).filter(Boolean).map((entry) => entry.id);
  const reject = [byCode("PEND-005")].filter(Boolean).map((entry) => entry.id);
  if (hide.length > 0) await admin("POST", "/items/status", { ids: hide, status: "hidden" });
  if (reject.length > 0) await admin("POST", "/items/status", { ids: reject, status: "rejected" });
  console.log(`  隐藏 ${hide.length} 条，拒绝 ${reject.length} 条`);

  // 5. 举报：几个条目被不同的人举报
  step("举报");
  const reportPlan = [
    // 3 个不同 IP 的人举报同一条网友推荐 → 够阈值（默认 3），自动隐藏；作者精选（AUTH-003）不会自动隐藏，只进待复核
    ["user", "USR-010", [["seed-reporter-1", "dead", "详情页打不开了"], ["seed-reporter-2", "dead", ""], ["seed-reporter-3", "inappropriate", "封面不合适"]]],
    ["user", "USR-011", [["seed-reporter-1", "dead", "图片是空的"], ["seed-reporter-4", "other", "标题和内容对不上"]]],
    ["user", "USR-012", [["seed-reporter-2", "duplicate", "和 USR-011 是同一部"]]],
    ["author", "AUTH-003", [["seed-reporter-3", "inappropriate", ""], ["seed-reporter-4", "inappropriate", "不该放在精选里"]]],
  ];
  for (const [channel, code, reporters] of reportPlan) {
    const outcome = [];
    for (const [device, reason, detail] of reporters) outcome.push(await report(channel, device, code, reason, detail));
    console.log(`  ${code}：${outcome.join(" ")}`);
  }

  // 6. 封禁：先造个「刷屏的设备」提交几条，再封掉并清理；另外封一个番号
  step("封禁");
  const spamDevice = "seed-device-spammer";
  for (let n = 1; n <= 3; n++) await submit("user", spamDevice, item(`SPAM-${String(n).padStart(3, "0")}`, { info: `SPAM-00${n} | 刷屏 | ${today}` }));
  const spamItems = (await admin("GET", "/items?q=SPAM-&pageSize=20")).items.filter((entry) => entry.submitter);
  const spamHash = spamItems[0]?.submitter;
  if (spamHash) {
    await tolerate([], () => admin("POST", "/bans", { kind: "device", value: spamHash, reason: "刷屏（种子数据）", purge: true }));
    console.log(`  已封禁刷屏设备 ${spamHash} 并清理了它的条目`);
  } else {
    console.log("  （没找到刷屏设备的条目，跳过设备封禁；可能是被限频了）");
  }
  await tolerate([], () => admin("POST", "/bans", { kind: "code", value: "BLOCKED-001", reason: "不收这个番号（种子数据）", purge: false }));
  console.log("  已封禁番号 BLOCKED-001");

  // 7. 团队：邀请 + 用邀请加入两个账号（管理员、协管），这样能用不同角色验证权限
  step("团队与邀请");
  const invites = await admin("GET", "/invites");
  if (invites.length >= 3) {
    console.log(`  已经有 ${invites.length} 个邀请，不再重复创建`);
  } else {
    const moderator = await admin("POST", "/invites", { role: "moderator", note: "小李（审核协管）", days: 7 });
    const adminInvite = await admin("POST", "/invites", { role: "admin", note: "老张（管理员）", days: 3 });
    const spare = await admin("POST", "/invites", { role: "moderator", note: "备用邀请，还没人用", days: 14 });
    const revoked = await admin("POST", "/invites", { role: "moderator", note: "这个会被撤销", days: 1 });
    await admin("DELETE", `/invites/${revoked.invite.id}`);
    for (const [invite, name, slot] of [[moderator, "seed-mod", "moderator"], [adminInvite, "seed-admin", "admin"]]) {
      const joined = await tolerate(["name_taken", "invalid_invite"], () => adminRequest(undefined, "POST", "/join", { token: invite.token, name }));
      if (joined) keys[slot] = { name, key: joined.data.accessKey };
    }
    console.log("  已创建邀请（其中 2 个已用掉，加入了 seed-mod / seed-admin；1 个撤销；1 个还有效）");
    console.log(`  还有效的邀请链接：${SHOWN_BASE}/#/join?token=${encodeURIComponent(spare.token)}`);
  }

  // 8. 我的账号：建一个 App 口令
  step("App 口令");
  const appKeys = await admin("GET", "/me/app-keys");
  if (appKeys.length === 0) {
    await admin("POST", "/me/app-keys", { name: "种子数据的 iPhone" });
    console.log("  已创建一个 App 口令（明文不会存、不打印）");
  } else {
    console.log("  已经有 App 口令了");
  }

  // 9. 检查：对特意造的几条跑一遍，让「正常 / 存疑 / 失效」都有
  step("自动检查（让本地 Worker 去访问 example.com 等网站，要几秒到几十秒）");
  const fresh = (await admin("GET", "/items?pageSize=100&sort=new")).items;
  const picked = ["LIVE-001", "LIVE-002", "LIVE-DEAD", "LIVE-WARN", "LIVE-HOST", "PEND-DEAD", "PEND-WARN", "AUTH-001", "AUTH-002"]
    .map((code) => fresh.find((entry) => entry.code === code))
    .filter(Boolean)
    .map((entry) => entry.id);
  if (picked.length > 0) {
    const checked = await admin("POST", "/checks/run", { itemIds: picked, limit: picked.length });
    const run = checked.run;
    console.log(run ? `  查了 ${run.examined} 个：正常 ${run.ok}、存疑 ${run.warn}、失效 ${run.dead}` : "  没有可查的条目");
  }

  // 收尾
  await mkdir(path.dirname(KEY_FILE), { recursive: true });
  await writeFile(KEY_FILE, `${JSON.stringify(keys, null, 2)}\n`, "utf8");
  const stats = await admin("GET", "/stats");
  console.log("\n✓ 完成");
  console.log(`  概览：网友推荐 ${JSON.stringify(stats.channels.user)}；作者精选 ${JSON.stringify(stats.channels.author)}；未处理举报 ${stats.openReports}`);
  console.log(`  后台地址：${SHOWN_BASE}/`);
  console.log(`  访问密钥已保存到 ${path.relative(process.cwd(), KEY_FILE)}（站长 / 管理员 / 协管各一个，用来验证不同角色看到的菜单）`);
  if (SHOW_KEY) {
    for (const [role, entry] of Object.entries(keys)) console.log(`    ${role}（${entry.name}）：${entry.key}`);
  } else {
    console.log("  想直接看密钥：加 --show-key 再跑一遍，或者打开上面那个文件");
  }
}

main().catch((error) => {
  console.error(`\n✗ 出错了：${error.message}`);
  process.exit(1);
});
