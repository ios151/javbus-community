// 后台显示封面用的代理。
//
// 为什么要它：JavBus 一类站点的封面靠 Referer 防盗链——不带 Referer、或者带的不是它自己的站，一律 403
// （2026-10-23 用 curl 实测：www / pics / images.javbus.com 都是这样，带 https://www.javbus.com/ 才给图；
// images.javbus.org 要带 https://www.javbus.org/ 或者干脆不带）。浏览器从后台页面加载封面时，Referer 只能是后台自己的地址
// （或者不带），所以必然加载失败。改成由 Worker 带上站点的 Referer 去取，再原样流回给浏览器。
//
// 边界：只按条目 id 代理库里那条的 src（不接受任意地址，不是开放代理），只给登录的维护者用；只回位图（SVG 能带脚本，不回）；
// 响应头照 GitHub camo（同类的图片代理）收紧，有人直接在浏览器里打开这个地址时也不会被当成网页执行。

import { MOBILE_UA, originOf } from "./checks";
import { HttpError } from "./util";
import { checkUrl } from "./validate";

const COVER_TIMEOUT_MS = 8000;
/** 封面一般几十 KB；上游声明的大小超过这个就不转。 */
export const MAX_COVER_BYTES = 5 * 1024 * 1024;

const COVER_HEADERS: Record<string, string> = {
  // 封面地址不变图就不变（地址改了，后台请求的地址里带的哈希也会变），让浏览器缓存一天，翻页回来不用再取
  "Cache-Control": "private, max-age=86400",
  "Content-Security-Policy": "default-src 'none'; img-src data:; style-src 'unsafe-inline'",
  "Cross-Origin-Resource-Policy": "same-origin",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
};

/** 依次试的 Referer：先用详情页所在的站（和自动检查一致），被拒（403）再用封面自己所在的站（封面和详情页不在同一个站的条目靠它）。 */
export function coverReferers(src: string, link: string): string[] {
  return [...new Set([originOf(link), originOf(src)].filter((referer) => referer !== ""))];
}

/** 能直接回给浏览器的图片类型：image/* 里去掉 SVG（能带脚本）。不是的返回 null。 */
export function rasterType(contentType: string | null): string | null {
  const type = (contentType ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  return type.startsWith("image/") && !type.includes("svg") ? type : null;
}

function unavailable(reason: string): HttpError {
  return new HttpError(502, "cover_unavailable", `封面取不到：${reason}`);
}

/** 带上合适的 Referer 去取封面，成功就把图片流原样转回去（不读进内存）；取不到抛 502。 */
export async function proxyCover(src: string, link: string, fetcher: typeof fetch = fetch): Promise<Response> {
  // 入库时校验过，这里再看一眼：只去公网的 http(s) 地址
  if (checkUrl(src) !== null) throw unavailable("封面地址不合格");
  let upstream: Response | null = null;
  try {
    for (const referer of coverReferers(src, link)) {
      upstream = await fetcher(src, {
        redirect: "follow",
        headers: { "User-Agent": MOBILE_UA, Accept: "image/*,*/*;q=0.8", Referer: referer },
        signal: AbortSignal.timeout(COVER_TIMEOUT_MS),
      });
      if (upstream.status !== 403) break;
      // 这个 Referer 被防盗链拒了：放掉正文，换下一个
      void upstream.body?.cancel().catch(() => undefined);
    }
  } catch (error) {
    throw unavailable(error instanceof Error && error.name === "TimeoutError" ? "超时" : "网络错误");
  }
  if (!upstream) throw unavailable("没有可用的地址");

  const type = rasterType(upstream.headers.get("content-type"));
  const problem = !upstream.ok
    ? `上游 HTTP ${upstream.status}`
    : Number(upstream.headers.get("content-length") ?? "0") > MAX_COVER_BYTES
      ? "图片太大"
      : null;
  if (problem !== null || type === null) {
    void upstream.body?.cancel().catch(() => undefined);
    throw unavailable(problem ?? "返回的不是图片");
  }
  // 不转发 Content-Length：上游要是压缩过，fetch 解压后长度就对不上了，让运行时按分块传
  const headers = new Headers(COVER_HEADERS);
  headers.set("Content-Type", type);
  return new Response(upstream.body, { status: 200, headers });
}
