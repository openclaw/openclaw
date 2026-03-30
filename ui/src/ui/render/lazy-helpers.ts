/**
 * Lazy Loading Helpers
 * 
 * 懒加载工具函数
 */

import { html, nothing } from "lit";

interface LazyState<T> {
  mod: T | null;
  promise: Promise<T> | null;
}

// 全局更新回调
let _pendingUpdate: (() => void) | undefined;

export function setPendingUpdate(fn: (() => void) | undefined) {
  _pendingUpdate = fn;
}

/**
 * 创建懒加载模块 getter
 */
export function createLazy<T>(loader: () => Promise<T>): () => T | null {
  const s: LazyState<T> = { mod: null, promise: null };
  return () => {
    if (s.mod) {
      return s.mod;
    }
    if (!s.promise) {
      s.promise = loader().then((m) => {
        s.mod = m;
        _pendingUpdate?.();
        return m;
      });
    }
    return null;
  };
}

/**
 * 懒渲染
 */
export function lazyRender<M>(getter: () => M | null, render: (mod: M) => unknown) {
  const mod = getter();
  return mod ? render(mod) : nothing;
}