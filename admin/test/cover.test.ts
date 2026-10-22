import { describe, expect, it } from "vitest";

import { coverProxyUrl } from "../src/lib/cover";

describe("coverProxyUrl：封面代理地址", () => {
  const src = "https://www.javbus.com/pics/thumb/abc1.jpg";

  it("指向这个条目的代理接口，带上封面地址的短哈希", () => {
    expect(coverProxyUrl(42, src)).toMatch(/^\/api\/admin\/items\/42\/cover\?v=[0-9a-z]+$/);
  });

  it("同一个地址每次一样（浏览器缓存才用得上），地址改了哈希就变", () => {
    expect(coverProxyUrl(1, src)).toBe(coverProxyUrl(1, src));
    expect(coverProxyUrl(1, src)).not.toBe(coverProxyUrl(1, src.replace("abc1", "abc2")));
  });
});
