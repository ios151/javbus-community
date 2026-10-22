import { describe, expect, it } from "vitest";

import type { ReportDTO } from "../../shared/types";
import { groupReports } from "../src/lib/report-groups";

let nextId = 1;

/** 没单独给 ipHash 的，就用 reporter 当 ipHash：一个举报人 = 一个 IP（下面专门测「同一个 IP 的不同设备」）。 */
function report(extra: Partial<ReportDTO>): ReportDTO {
  const base = reportBase(extra);
  return { ...base, ipHash: extra.ipHash ?? base.reporter };
}

function reportBase(extra: Partial<ReportDTO>): ReportDTO {
  return {
    id: nextId++,
    itemId: 1,
    code: "ABC-001",
    channel: "user",
    itemStatus: "approved",
    info: "ABC-001 | 2026-10-22",
    src: "https://img.example.com/1.jpg",
    reason: "dead",
    detail: "",
    reporter: "aaaaaaaaaaaaaaaa",
    ipHash: "",
    createdAt: 1_000,
    status: "open",
    resolvedBy: null,
    resolvedAt: null,
    resolution: "",
    ...extra,
  };
}

describe("groupReports：同一个条目的举报合并", () => {
  it("没有举报 → 空数组", () => {
    expect(groupReports([])).toEqual([]);
  });

  it("同一个条目的多条合并成一组：举报人数、各原因计数、条目信息", () => {
    const groups = groupReports([
      report({ reporter: "r1", reason: "dead", createdAt: 1_000 }),
      report({ reporter: "r2", reason: "dead", createdAt: 3_000 }),
      report({ reporter: "r3", reason: "inappropriate", createdAt: 2_000 }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ itemId: 1, code: "ABC-001", channel: "user", itemStatus: "approved", reporters: 3, firstAt: 1_000, latestAt: 3_000 });
    expect(groups[0]?.reasons).toEqual([
      { reason: "dead", count: 2 },
      { reason: "inappropriate", count: 1 },
    ]);
  });

  it("举报人数按 IP 去重：同一个 IP 的几个设备号只算一个人（设备号是 App 自己报的，谁都能编）", () => {
    const groups = groupReports([
      report({ reporter: "dev1", ipHash: "ip-a" }),
      report({ reporter: "dev2", ipHash: "ip-a" }),
      report({ reporter: "dev3", ipHash: "ip-a" }),
      report({ reporter: "dev4", ipHash: "ip-b" }),
    ]);
    expect(groups[0]?.reporters).toBe(2);
  });

  it("举报人数按举报人去重", () => {
    const groups = groupReports([report({ reporter: "same" }), report({ reporter: "same", reason: "other" }), report({ reporter: "other" })]);
    expect(groups[0]?.reporters).toBe(2);
  });

  it("原因同数时按固定顺序（已失效 → 内容不当 → 重复 → 其他）", () => {
    const groups = groupReports([report({ reporter: "a", reason: "other" }), report({ reporter: "b", reason: "duplicate" }), report({ reporter: "c", reason: "dead" }), report({ reporter: "d", reason: "inappropriate" })]);
    expect(groups[0]?.reasons.map((r) => r.reason)).toEqual(["dead", "inappropriate", "duplicate", "other"]);
  });

  it("只收有详情文字的（去掉首尾空白），新的在前", () => {
    const groups = groupReports([
      report({ reporter: "a", detail: "  打不开  ", createdAt: 1_000 }),
      report({ reporter: "b", detail: "", createdAt: 2_000 }),
      report({ reporter: "c", detail: "   ", createdAt: 3_000 }),
      report({ reporter: "d", detail: "图片是空的", reason: "other", createdAt: 4_000 }),
    ]);
    expect(groups[0]?.details.map((d) => d.text)).toEqual(["图片是空的", "打不开"]);
    expect(groups[0]?.details[0]).toMatchObject({ reason: "other", at: 4_000 });
  });

  it("多个条目：举报人数多的在前，同数的最近被举报的在前", () => {
    const groups = groupReports([
      report({ itemId: 1, code: "A-1", reporter: "a", createdAt: 1_000 }),
      report({ itemId: 2, code: "B-2", reporter: "a", createdAt: 5_000 }),
      report({ itemId: 3, code: "C-3", reporter: "a", createdAt: 2_000 }),
      report({ itemId: 3, code: "C-3", reporter: "b", createdAt: 2_500 }),
    ]);
    expect(groups.map((g) => g.code)).toEqual(["C-3", "B-2", "A-1"]);
  });

  it("不改入参", () => {
    const input = [report({ reporter: "a", detail: "x" }), report({ reporter: "b", detail: "y", createdAt: 9_000 })];
    const copy = structuredClone(input);
    groupReports(input);
    expect(input).toEqual(copy);
  });
});
