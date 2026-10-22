// 极简的全局状态：一个值 + 订阅。够用了（登录态、toast、弹窗队列、路由、侧边栏数字），不需要引入状态管理库。

import { useEffect, useState } from "preact/hooks";

export interface Store<T> {
  get(): T;
  set(next: T | ((previous: T) => T)): void;
  subscribe(listener: () => void): () => void;
}

export function createStore<T>(initial: T): Store<T> {
  let state = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => state,
    set(next) {
      const value = typeof next === "function" ? (next as (previous: T) => T)(state) : next;
      if (Object.is(value, state)) return;
      state = value;
      for (const listener of [...listeners]) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/** 组件里读一个 store，值变了自动重渲染。 */
export function useStore<T>(store: Store<T>): T {
  const [value, setValue] = useState<T>(() => store.get());
  useEffect(() => {
    // 渲染到订阅之间值可能已经变了，补读一次
    setValue(store.get());
    return store.subscribe(() => setValue(store.get()));
  }, [store]);
  return value;
}
