// 通用 hooks：异步加载数据、防抖、量元素宽度、带忙碌状态的操作。

import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import type { Ref } from "preact";

import { errorMessage } from "../lib/errors";
import { toast } from "./toast";

export interface Resource<T> {
  data: T | undefined;
  error: unknown;
  loading: boolean;
  /** 重新加载。旧数据先留着，新数据到了再换，页面不闪。 */
  reload: () => void;
  /** 本地改一下已加载的数据（操作成功后不想整页重载时用）。 */
  mutate: (updater: (data: T) => T) => void;
}

/**
 * 加载数据：deps 变了（筛选条件、页码……）就重新加载。
 * 只认最后一次请求的结果——快速切换筛选时，先发后到的旧响应不会盖掉新的。
 */
export function useResource<T>(load: () => Promise<T>, deps: readonly unknown[]): Resource<T> {
  const [state, setState] = useState<{ data: T | undefined; error: unknown; loading: boolean }>({ data: undefined, error: undefined, loading: true });
  const [tick, setTick] = useState(0);
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    let alive = true;
    setState((s) => ({ ...s, error: undefined, loading: true }));
    loadRef.current().then(
      (data) => {
        if (alive) setState({ data, error: undefined, loading: false });
      },
      (error: unknown) => {
        if (alive) setState((s) => ({ data: s.data, error, loading: false }));
      },
    );
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  const mutate = useCallback((updater: (data: T) => T) => {
    setState((s) => (s.data === undefined ? s : { ...s, data: updater(s.data) }));
  }, []);
  return { data: state.data, error: state.error, loading: state.loading, reload, mutate };
}

/** 值稳定 ms 毫秒后才更新（搜索框用）。 */
export function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}

/** 量一个元素的宽度（随窗口变化更新），画自适应宽度的图表用。 */
export function useElementWidth<E extends HTMLElement>(): [Ref<E>, number] {
  const ref = useRef<E>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    setWidth(Math.floor(element.getBoundingClientRect().width));
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) setWidth(Math.floor(entry.contentRect.width));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

/**
 * 包一个会改数据的操作：执行期间 busy = true，出错自动弹 toast（用接口返回的中文 message），返回结果（出错返回 undefined）。
 */
export function useBusy(): { busy: boolean; run: <T>(work: () => Promise<T>) => Promise<T | undefined> } {
  const [busy, setBusy] = useState(false);
  const run = useCallback(async <T,>(work: () => Promise<T>): Promise<T | undefined> => {
    setBusy(true);
    try {
      return await work();
    } catch (error) {
      toast.error(errorMessage(error));
      return undefined;
    } finally {
      setBusy(false);
    }
  }, []);
  return { busy, run };
}

/**
 * 表单提交：和 useBusy 的区别是出错不弹 toast，而是把错误留给表单自己显示在字段旁边
 * （比如服务端 422 说「封面地址：不是公网网站的地址」，就该贴在表单里，而不是一闪而过的提示）。
 */
export function useFormSubmit(): {
  busy: boolean;
  error: unknown;
  submit: <T>(work: () => Promise<T>) => Promise<T | undefined>;
  clearError: () => void;
} {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(undefined);
  const submit = useCallback(async <T,>(work: () => Promise<T>): Promise<T | undefined> => {
    setBusy(true);
    setError(undefined);
    try {
      return await work();
    } catch (caught) {
      setError(caught);
      return undefined;
    } finally {
      setBusy(false);
    }
  }, []);
  const clearError = useCallback(() => setError(undefined), []);
  return { busy, error, submit, clearError };
}

/** 页面标题。 */
export function useDocumentTitle(title: string): void {
  useEffect(() => {
    document.title = title;
  }, [title]);
}

/** 有未完成的操作 / 未保存的内容时，关闭或刷新页面前让浏览器提示一下。 */
export function useLeaveGuard(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    const handler = (event: BeforeUnloadEvent): void => {
      event.preventDefault();
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [active]);
}
