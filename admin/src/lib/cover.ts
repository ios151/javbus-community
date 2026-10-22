// 封面走服务端代理（后端 src/lib/cover.ts）：JavBus 一类图床靠 Referer 防盗链，浏览器从后台页面直接加载一律 403。
//
// 地址里带上封面地址的短哈希：服务端让浏览器把封面缓存一天，封面地址改了以后哈希跟着变，不会一直显示旧图。

/** 某个条目的封面代理地址。 */
export function coverProxyUrl(itemId: number, src: string): string {
  return `/api/admin/items/${itemId}/cover?v=${fnv1a(src)}`;
}

/** FNV-1a 32 位，转成 36 进制：只用来区分「地址变没变」，不需要抗碰撞。 */
function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}
