// 几个小而独立的纯逻辑模块放在一个文件里测：邀请、封禁页、集合工具、本地偏好、二次验证输入。

import { describe, expect, it } from "vitest";

import type { InviteDTO } from "../../shared/types";
import { BAN_KINDS, parseBanPrefill, validateBanValue } from "../src/lib/bans";
import { chunk, toggled } from "../src/lib/collections";
import { INVITE_STATE_NAMES, inviteLink, inviteState } from "../src/lib/invite";
import { readBool, writeBool, type KeyValueStorage } from "../src/lib/storage";
import { groupSecret, isTotpCode, normalizeTotpCode } from "../src/lib/totp";

describe("邀请", () => {
  it("邀请链接 = 站点地址 + /#/join?token=…", () => {
    expect(inviteLink("https://rec.example.com", "jci_AbC-123_x")).toBe("https://rec.example.com/#/join?token=jci_AbC-123_x");
    expect(inviteLink("http://localhost:8787", "jci_a b")).toBe("http://localhost:8787/#/join?token=jci_a%20b");
  });

  it("状态：已使用 > 已过期 > 有效", () => {
    const now = 10_000;
    const invite = (patch: Partial<Pick<InviteDTO, "used" | "expiresAt">>) => ({ used: false, expiresAt: now + 1, ...patch });
    expect(inviteState(invite({}), now)).toBe("active");
    expect(inviteState(invite({ expiresAt: now }), now)).toBe("expired");
    expect(inviteState(invite({ expiresAt: now - 1 }), now)).toBe("expired");
    expect(inviteState(invite({ used: true }), now)).toBe("used");
    expect(inviteState(invite({ used: true, expiresAt: now - 1 }), now)).toBe("used");
    expect(INVITE_STATE_NAMES).toEqual({ active: "有效", used: "已使用", expired: "已过期" });
  });
});

describe("封禁页", () => {
  const hash = "3fa9c2d41b7e08a5";

  it("设备 / IP 要 16 位十六进制（大小写都认）", () => {
    for (const kind of ["device", "ip"] as const) {
      expect(validateBanValue(kind, hash)).toBeNull();
      expect(validateBanValue(kind, hash.toUpperCase())).toBeNull();
      expect(validateBanValue(kind, ` ${hash} `)).toBeNull();
      expect(validateBanValue(kind, "3fa9")).not.toBeNull();
      expect(validateBanValue(kind, "zzzzzzzzzzzzzzzz")).not.toBeNull();
      expect(validateBanValue(kind, "")).not.toBeNull();
    }
  });

  it("番号：字母数字开头，可以带 . _ -", () => {
    expect(validateBanValue("code", "FC2-PPV-1234567")).toBeNull();
    expect(validateBanValue("code", "010120_001")).toBeNull();
    expect(validateBanValue("code", "bad code")).not.toBeNull();
    expect(validateBanValue("code", "-ABC")).not.toBeNull();
    expect(validateBanValue("code", "")).not.toBeNull();
  });

  it("预填：#/bans?kind=device&value=…&ip=…", () => {
    expect(parseBanPrefill({ kind: "device", value: hash, ip: "0123456789ABCDEF" })).toEqual({ kind: "device", value: hash, ip: "0123456789abcdef" });
    expect(parseBanPrefill({ kind: "ip", value: hash })).toEqual({ kind: "ip", value: hash, ip: "" });
  });

  it("预填：不认识的类型退回设备，不合格式的 ip 丢掉，什么都没有就是空表单", () => {
    expect(parseBanPrefill({ kind: "nope", value: "x", ip: "短" })).toEqual({ kind: "device", value: "x", ip: "" });
    expect(parseBanPrefill({})).toEqual({ kind: "device", value: "", ip: "" });
    expect(BAN_KINDS).toEqual(["device", "ip", "code"]);
  });
});

describe("集合工具", () => {
  it("chunk：按上限切段", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([], 3)).toEqual([]);
    expect(chunk([1, 2, 3], 10)).toEqual([[1, 2, 3]]);
    expect(chunk([1, 2, 3], 0)).toEqual([[1], [2], [3]]); // 非法的段长按 1 处理，不死循环
  });

  it("toggled：返回新集合，不改原集合", () => {
    const original = new Set([1, 2]);
    expect([...toggled(original, 3, true)]).toEqual([1, 2, 3]);
    expect([...toggled(original, 1, false)]).toEqual([2]);
    expect([...original]).toEqual([1, 2]);
  });
});

describe("本地偏好（遮挡封面开关）", () => {
  function fakeStorage(initial: Record<string, string> = {}): KeyValueStorage & { data: Record<string, string> } {
    const data = { ...initial };
    return {
      data,
      getItem: (key) => data[key] ?? null,
      setItem: (key, value) => {
        data[key] = value;
      },
    };
  }

  it("没存过 → 用默认值", () => {
    expect(readBool(fakeStorage(), "k", true)).toBe(true);
    expect(readBool(fakeStorage(), "k", false)).toBe(false);
  });

  it("存过 1 / 0 → 读回来；乱写的值当没存过", () => {
    expect(readBool(fakeStorage({ k: "1" }), "k", false)).toBe(true);
    expect(readBool(fakeStorage({ k: "0" }), "k", true)).toBe(false);
    expect(readBool(fakeStorage({ k: "垃圾" }), "k", true)).toBe(true);
  });

  it("写了能读回来", () => {
    const storage = fakeStorage();
    writeBool(storage, "k", false);
    expect(storage.data.k).toBe("0");
    expect(readBool(storage, "k", true)).toBe(false);
    writeBool(storage, "k", true);
    expect(readBool(storage, "k", false)).toBe(true);
  });

  it("localStorage 不可用 / 读写抛错（隐私模式）时不抛出", () => {
    const broken: KeyValueStorage = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    };
    expect(readBool(broken, "k", true)).toBe(true);
    expect(() => writeBool(broken, "k", false)).not.toThrow();
    expect(readBool(undefined, "k", true)).toBe(true);
    expect(() => writeBool(undefined, "k", true)).not.toThrow();
  });
});

describe("二次验证输入", () => {
  it("验证码：去掉空格和横杠；必须是 6 位数字", () => {
    expect(normalizeTotpCode(" 123 456 ")).toBe("123456");
    expect(normalizeTotpCode("123-456")).toBe("123456");
    expect(isTotpCode("123 456")).toBe(true);
    expect(isTotpCode("12345")).toBe(false);
    expect(isTotpCode("1234567")).toBe(false);
    expect(isTotpCode("12345a")).toBe(false);
    expect(isTotpCode("")).toBe(false);
  });

  it("密钥每 4 位一组，方便手输时对照", () => {
    expect(groupSecret("ABCDEFGHIJKLMNOP")).toBe("ABCD EFGH IJKL MNOP");
    expect(groupSecret("ABCDEFG")).toBe("ABCD EFG");
    expect(groupSecret("ABCD")).toBe("ABCD");
    expect(groupSecret("")).toBe("");
  });
});
