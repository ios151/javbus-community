// 二维码：点阵由 lib/qr.ts 算好，这里画成 <svg><rect/></svg>（不用 innerHTML）。
// 固定白底黑块 + 四格留白：手机扫码要对比度，深色模式下也不能反色。

import { useMemo } from "preact/hooks";

import { darkRuns, qrMatrix } from "../lib/qr";

const QUIET_ZONE = 4;

export function QrCode({ text, size = 200, label }: { text: string; size?: number; label: string }) {
  const matrix = useMemo(() => qrMatrix(text), [text]);
  const runs = useMemo(() => darkRuns(matrix), [matrix]);
  const span = matrix.length + QUIET_ZONE * 2;
  return (
    <svg class="qr" width={size} height={size} viewBox={`0 0 ${span} ${span}`} role="img" aria-label={label} shape-rendering="crispEdges">
      <rect width={span} height={span} fill="#ffffff" />
      {runs.map((run) => (
        <rect key={`${run.x}-${run.y}`} x={run.x + QUIET_ZONE} y={run.y + QUIET_ZONE} width={run.w} height={1} fill="#000000" />
      ))}
    </svg>
  );
}
