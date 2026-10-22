// 「复制」相关的两个小组件：带反馈的复制按钮、点一下就复制的文字（番号、哈希）。

import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";

import { copyText } from "../lib/clipboard";
import { Icon } from "./icons";
import { toast } from "./toast";

/** 复制并给出反馈；返回复制成功与否。 */
function useCopy(text: string): { copied: boolean; copy: () => Promise<void> } {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  async function copy(): Promise<void> {
    const ok = await copyText(text);
    if (!ok) {
      toast.error("复制失败了，请手动选中后复制");
      return;
    }
    setCopied(true);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setCopied(false), 1800);
  }
  return { copied, copy };
}

export function CopyButton({ text, label = "复制" }: { text: string; label?: string }) {
  const { copied, copy } = useCopy(text);
  return (
    <button type="button" class="btn btn-sm" onClick={() => void copy()}>
      <Icon name={copied ? "check" : "copy"} size={14} />
      {copied ? "已复制" : label}
    </button>
  );
}

/** 点击即复制的文字（用 <button> 做，键盘也能操作）。 */
export function CopyText({ text, title, className, children }: { text: string; title?: string; className?: string; children?: ComponentChildren }) {
  const { copied, copy } = useCopy(text);
  return (
    <button type="button" class={`copy-text ${className ?? ""}`} title={title ?? "点击复制"} onClick={() => void copy()}>
      {copied ? "已复制 ✓" : (children ?? text)}
    </button>
  );
}
