// 后台的封面代理：带上站点的 Referer 去取封面（防盗链），只给登录的维护者、只代理库里条目自己的封面。
import { http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it } from "vitest";

import type { ItemDTO } from "../shared/types";
import { coverReferers, MAX_COVER_BYTES, proxyCover, rasterType } from "../src/lib/cover";
import { api, makeItem, parse, resetDb, seedUser, type Admin } from "./helpers";
import { network } from "./network";

beforeEach(resetDb);

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);

interface Seen {
  url: string;
  referer: string | null;
  userAgent: string | null;
}

/** www.javbus.com 的封面：只认 https://www.javbus.com/ 这个 Referer（和真站一样，别的一律 403）。 */
function mockJavbusCovers(response: { status?: number; type?: string; body?: BodyInit } = {}): Seen[] {
  const seen: Seen[] = [];
  network.use(
    http.get("https://www.javbus.com/pics/*", ({ request }) => {
      const referer = request.headers.get("referer");
      seen.push({ url: request.url, referer, userAgent: request.headers.get("user-agent") });
      if (referer !== "https://www.javbus.com/") return new HttpResponse("hotlink", { status: 403, headers: { "content-type": "text/html" } });
      return new HttpResponse(response.body ?? JPEG, { status: response.status ?? 200, headers: { "content-type": response.type ?? "image/jpeg" } });
    }),
  );
  return seen;
}

async function addItem(admin: Admin, extra: Record<string, unknown> = {}): Promise<number> {
  const res = await admin.post("/items", { channel: "user", ...makeItem(1), ...extra });
  expect(res.status).toBe(201);
  return (await parse<ItemDTO>(res)).id;
}

describe("GET /api/admin/items/:id/cover", () => {
  it("带上详情页所在站的 Referer 去取，图片原样流回，可以缓存、响应头收紧", async () => {
    const boss = await seedUser("boss");
    const id = await addItem(boss);
    const seen = mockJavbusCovers();

    const res = await boss.get(`/items/${id}/cover`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/jpeg");
    expect(res.headers.get("cache-control")).toBe("private, max-age=86400"); // 没被后台统一的 no-store 盖掉
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(JPEG);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.referer).toBe("https://www.javbus.com/");
    expect(seen[0]?.userAgent).toContain("iPhone");
  });

  it("封面和详情页不在同一个站：详情页的站被 403 以后，换封面自己所在的站再试一次", async () => {
    const boss = await seedUser("boss");
    const id = await addItem(boss, { link: "https://www.javbus.org/ABC-001" });
    const seen = mockJavbusCovers();

    const res = await boss.get(`/items/${id}/cover`);
    expect(res.status).toBe(200);
    expect(seen.map((s) => s.referer)).toEqual(["https://www.javbus.org/", "https://www.javbus.com/"]);
  });

  it("协管也能看；没登录 → 401，而且不会去取封面", async () => {
    const boss = await seedUser("boss");
    const id = await addItem(boss);
    const mod = await seedUser("mod", "moderator");
    const seen = mockJavbusCovers();

    expect((await mod.get(`/items/${id}/cover`)).status).toBe(200);
    expect((await api(`/api/admin/items/${id}/cover`)).status).toBe(401);
    expect(seen).toHaveLength(1);
  });

  it("没有这个条目 → 404；条目没有封面 → 404 no_cover", async () => {
    const boss = await seedUser("boss");
    const id = await addItem(boss, { src: "" });

    expect((await boss.get(`/items/${id + 100}/cover`)).status).toBe(404);
    const res = await boss.get(`/items/${id}/cover`);
    expect(res.status).toBe(404);
    expect(await parse(res)).toMatchObject({ error: { code: "no_cover" } });
  });

  it("上游给的不是图片 → 502，不把网页内容转回来", async () => {
    const boss = await seedUser("boss");
    const id = await addItem(boss);
    mockJavbusCovers({ type: "text/html", body: "<script>alert(1)</script>" });

    const res = await boss.get(`/items/${id}/cover`);
    expect(res.status).toBe(502);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await parse(res)).toMatchObject({ error: { code: "cover_unavailable" } });
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("其它后台接口照旧不缓存", async () => {
    const boss = await seedUser("boss");
    expect((await boss.get("/items")).headers.get("cache-control")).toBe("no-store");
  });
});

describe("proxyCover 的边界", () => {
  const src = "https://www.javbus.com/pics/thumb/abc1.jpg";
  const link = "https://www.javbus.com/ABC-001";
  const respond =
    (body: BodyInit | null, init: ResponseInit): typeof fetch =>
    async () =>
      new Response(body, init);

  it("SVG（能带脚本）、上游 404、声明的大小超过上限、超时、网络错误 → 都是 502", async () => {
    const cases: [typeof fetch, string][] = [
      [respond("<svg/>", { headers: { "content-type": "image/svg+xml" } }), "不是图片"],
      [respond("gone", { status: 404, headers: { "content-type": "text/html" } }), "HTTP 404"],
      [respond("x", { headers: { "content-type": "image/jpeg", "content-length": String(MAX_COVER_BYTES + 1) } }), "太大"],
      [
        async () => {
          throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
        },
        "超时",
      ],
      [
        async () => {
          throw new Error("connection reset");
        },
        "网络错误",
      ],
    ];
    for (const [fetcher, reason] of cases) {
      await expect(proxyCover(src, link, fetcher)).rejects.toMatchObject({ status: 502, message: expect.stringContaining(reason) });
    }
  });

  it("所有 Referer 都被 403：502，而且只试两次", async () => {
    let calls = 0;
    const fetcher: typeof fetch = async () => {
      calls++;
      return new Response("hotlink", { status: 403 });
    };
    await expect(proxyCover(src, "https://www.javbus.org/ABC-001", fetcher)).rejects.toMatchObject({ status: 502, message: expect.stringContaining("HTTP 403") });
    expect(calls).toBe(2);
  });

  it("库里的地址万一不合格（内网 / 非 http）就不去取", async () => {
    let calls = 0;
    const fetcher: typeof fetch = async () => {
      calls++;
      return new Response(JPEG, { headers: { "content-type": "image/jpeg" } });
    };
    for (const bad of ["http://127.0.0.1/a.jpg", "file:///etc/passwd", "https://intranet/a.jpg"]) {
      await expect(proxyCover(bad, link, fetcher)).rejects.toMatchObject({ status: 502 });
    }
    expect(calls).toBe(0);
  });

  it("coverReferers：先详情页的站、再封面的站，同一个站只试一次", () => {
    expect(coverReferers(src, link)).toEqual(["https://www.javbus.com/"]);
    expect(coverReferers("https://images.javbus.org/thumb/x.jpg", "https://www.javbus.org/X")).toEqual(["https://www.javbus.org/", "https://images.javbus.org/"]);
    expect(coverReferers(src, "not a url")).toEqual(["https://www.javbus.com/"]);
  });

  it("rasterType：只认位图，去掉参数、不分大小写", () => {
    expect(rasterType("image/jpeg")).toBe("image/jpeg");
    expect(rasterType("Image/WEBP; charset=binary")).toBe("image/webp");
    expect(rasterType("image/svg+xml")).toBeNull();
    expect(rasterType("text/html")).toBeNull();
    expect(rasterType(null)).toBeNull();
  });
});
