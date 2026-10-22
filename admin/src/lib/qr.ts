// 二维码：用 qrcode-generator 算出点阵，再合并成一行行的「深色横条」，由组件画成 <svg><rect/></svg>。
// 不走它自带的 createSvgTag / createImgTag（那些返回 HTML 字符串，得用 innerHTML 才能塞进页面）。

import qrcode from "qrcode-generator";

export type QrLevel = "L" | "M" | "Q" | "H";

/** 文本 → 点阵（true = 深色模块）。 */
export function qrMatrix(text: string, level: QrLevel = "M"): boolean[][] {
  // qrcode-generator 默认按单字节写入，超出 Latin-1 的字符会被截坏；遇到就先做百分号编码（otpauth 地址本来就是纯 ASCII）
  const safe = /[^\x00-\xff]/.test(text) ? encodeURI(text) : text;
  const qr = qrcode(0, level); // 0 = 按内容长度自动选版本
  qr.addData(safe);
  qr.make();
  const size = qr.getModuleCount();
  return Array.from({ length: size }, (_, row) => Array.from({ length: size }, (_, col) => qr.isDark(row, col)));
}

export interface Run {
  x: number;
  y: number;
  /** 横向连续的深色模块数。 */
  w: number;
}

/** 点阵 → 每行连续的深色横条（比一个模块一个 rect 少得多）。 */
export function darkRuns(matrix: readonly (readonly boolean[])[]): Run[] {
  const runs: Run[] = [];
  matrix.forEach((row, y) => {
    let start = -1;
    for (let x = 0; x <= row.length; x++) {
      const dark = x < row.length && row[x] === true;
      if (dark && start < 0) start = x;
      if (!dark && start >= 0) {
        runs.push({ x: start, y, w: x - start });
        start = -1;
      }
    }
  });
  return runs;
}
