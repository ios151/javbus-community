import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";

import { api, parse, resetDb } from "./helpers";

describe("环境冒烟", () => {
  beforeEach(resetDb);

  it("迁移已应用，Worker 能响应", async () => {
    const tables = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'sqlite_%' ORDER BY name").all<{ name: string }>();
    expect(tables.results.map((t) => t.name)).toEqual(
      expect.arrayContaining(["users", "items", "reports", "snapshots", "rate_limits", "check_runs", "audit_log", "settings", "banned", "invites", "app_keys", "sessions"]),
    );
    const response = await api("/api/v1/health");
    expect(response.status).toBe(200);
    expect(await parse<{ ok: boolean }>(response)).toMatchObject({ ok: true });
  });

  it("空库读列表是 []，带 ETag", async () => {
    const response = await api("/api/v1/rec/user");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([]);
    expect(response.headers.get("ETag")).toBe('W/"user-0"');
    expect(response.headers.get("Content-Type")).toContain("application/json");
  });
});
