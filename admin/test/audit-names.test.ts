import { describe, expect, it } from "vitest";

import { ACTION_GROUPS, ALL_ACTIONS, actionLabel, actorLabel, summarizeDetail } from "../src/lib/audit-names";

// docs/api.md 末尾「操作日志里的动作名」的完整列表：后端新增动作时，这里和文档一起补，漏了测试会提醒
const DOCUMENTED_ACTIONS = [
  "user.setup", "user.login", "user.join", "user.update", "user.reset_key", "user.reset_totp", "user.rotate_key", "user.totp_enable", "user.totp_disable",
  "invite.create", "invite.revoke", "appkey.create", "appkey.revoke",
  "item.submit", "item.create", "item.edit", "item.approve", "item.reject", "item.hide", "item.delete", "item.self_delete", "item.import", "item.auto_hide_reports", "item.expire_pending",
  "report.hide", "report.dismiss", "report.delete",
  "check.run", "check.visibility",
  "settings.update", "ban.add", "ban.remove",
];

describe("动作名翻译", () => {
  it("文档里列出的每个动作都有中文名，且不是原样返回", () => {
    for (const action of DOCUMENTED_ACTIONS) {
      expect(ALL_ACTIONS, action).toContain(action);
      expect(actionLabel(action), action).not.toBe(action);
    }
  });

  it("筛选下拉里的动作 = 文档里的动作（不多不少，不重复）", () => {
    expect(ALL_ACTIONS).toHaveLength(DOCUMENTED_ACTIONS.length);
    expect(new Set(ALL_ACTIONS).size).toBe(ALL_ACTIONS.length);
    expect([...ALL_ACTIONS].sort()).toEqual([...DOCUMENTED_ACTIONS].sort());
    expect(ACTION_GROUPS.every((group) => group.actions.length > 0)).toBe(true);
  });

  it("没见过的动作原样显示，不会让页面坏掉", () => {
    expect(actionLabel("future.action")).toBe("future.action");
  });

  it("操作人：system / app 翻成中文，其余原样", () => {
    expect(actorLabel("system")).toContain("系统");
    expect(actorLabel("app")).toContain("App");
    expect(actorLabel("老王")).toBe("老王");
  });
});

describe("summarizeDetail：把 detail 概括成一句话", () => {
  it("批量通过 / 拒绝 / 隐藏 / 删除：数量 + 前几个番号", () => {
    expect(summarizeDetail("item.approve", { count: 5, to: "approved", codes: ["A-1", "B-2", "C-3", "D-4", "E-5"] })).toBe("5 个条目：A-1、B-2、C-3 等");
    expect(summarizeDetail("item.delete", { count: 1, codes: ["A-1"] })).toBe("1 个条目：A-1");
    expect(summarizeDetail("item.hide", { count: 2 })).toBe("2 个条目");
  });

  it("编辑 / 改设置：列出改了哪些项", () => {
    expect(summarizeDetail("item.edit", { src: ["a", "b"], note: ["", "x"] })).toBe("改了：src、note");
    expect(summarizeDetail("settings.update", { maintenance: [false, true] })).toBe("改了：maintenance");
  });

  it("导入 / 检查 / 封禁 / 新增", () => {
    expect(summarizeDetail("item.import", { received: 500, inserted: 480, skipped: 20, status: "approved" })).toBe("收到 500，新增 480，跳过 20");
    expect(summarizeDetail("check.run", { examined: 10, ok: 8, warn: 1, dead: 1, hidden: 0 })).toBe("查了 10：正常 8、存疑 1、失效 1、自动隐藏 0");
    expect(summarizeDetail("ban.add", { reason: "刷屏", purged: 3 })).toBe("同时清理了 3 个条目");
    expect(summarizeDetail("ban.add", { reason: "刷屏", purged: 0 })).toBe("");
    expect(summarizeDetail("item.create", { channel: "author", status: "pending" })).toBe("作者精选，待审");
  });

  it("detail 为空 / 不是对象 / 认不出的形状 → 空串", () => {
    expect(summarizeDetail("item.approve", null)).toBe("");
    expect(summarizeDetail("item.approve", "字符串")).toBe("");
    expect(summarizeDetail("user.login", {})).toBe("");
    expect(summarizeDetail("item.edit", {})).toBe("");
  });
});
