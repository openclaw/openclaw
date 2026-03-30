/**
 * Lazy Loading Strategy
 * 
 * 优化的懒加载策略：预加载、优先级、错误处理
 */

import { nothing } from 'lit';
import type { DirectiveResult } from 'lit/directive.js';

// ─────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────

interface LazyModule<T> {
  module: T | null;
  promise: Promise<T> | null;
  error: Error | null;
  loading: boolean;
  priority: 'high' | 'normal' | 'low';
}

type ModuleLoader<T> = () => Promise<T>;

// ─────────────────────────────────────────────────────────────
// Module Loading State
// ─────────────────────────────────────────────────────────────

const moduleCache = new Map<string, LazyModule<unknown>>();
let updateCallback: (() => void) | null = null;

export function setLazyUpdateCallback(cb: () => void) {
  updateCallback = cb;
}

function triggerUpdate() {
  updateCallback?.();
}

// ─────────────────────────────────────────────────────────────
// Priority-based Loading
// ─────────────────────────────────────────────────────────────

/**
 * 高优先级模块（立即加载）
 * - Chat（默认 tab）
 * - Config（常用）
 */
const HIGH_PRIORITY_MODULES = ['chat', 'config'];

/**
 * 普通优先级模块（按需加载）
 * - Sessions, Agents, Cron, etc.
 */
const NORMAL_PRIORITY_MODULES = [
  'sessions',
  'agents',
  'cron',
  'usage',
  'channels',
  'skills',
  'nodes',
  'instances',
];

/**
 * 低优先级模块（延迟加载）
 * - Debug, Logs
 */
const LOW_PRIORITY_MODULES = ['debug', 'logs'];

function getPriority(moduleName: string): 'high' | 'normal' | 'low' {
  if (HIGH_PRIORITY_MODULES.includes(moduleName)) return 'high';
  if (LOW_PRIORITY_MODULES.includes(moduleName)) return 'low';
  return 'normal';
}

// ─────────────────────────────────────────────────────────────
// Lazy Loading with Error Handling
// ─────────────────────────────────────────────────────────────

export interface LazyOptions {
  priority?: 'high' | 'normal' | 'low';
  preload?: boolean;
  retryCount?: number;
  retryDelay?: number;
}

/**
 * 创建懒加载模块
 */
export function createLazyModule<T>(
  key: string,
  loader: ModuleLoader<T>,
  options: LazyOptions = {}
): () => LazyModule<T> {
  const { priority = 'normal', preload = false, retryCount = 2, retryDelay = 1000 } = options;

  const initial: LazyModule<T> = {
    module: null,
    promise: null,
    error: null,
    loading: false,
    priority,
  };

  moduleCache.set(key, initial);

  // 预加载
  if (preload || priority === 'high') {
    requestIdleCallback(() => loadModule(key, loader, retryCount, retryDelay));
  }

  return () => moduleCache.get(key) as LazyModule<T>;
}

/**
 * 加载模块
 */
async function loadModule<T>(
  key: string,
  loader: ModuleLoader<T>,
  retryCount: number,
  retryDelay: number,
  attempt = 0
): Promise<void> {
  const entry = moduleCache.get(key);
  if (!entry || entry.module || entry.loading) return;

  entry.loading = true;
  entry.error = null;

  try {
    const module = await loader();
    entry.module = module;
    entry.loading = false;
    triggerUpdate();
  } catch (err) {
    if (attempt < retryCount) {
      // 重试
      await new Promise((resolve) => setTimeout(resolve, retryDelay));
      return loadModule(key, loader, retryCount, retryDelay, attempt + 1);
    }

    entry.error = err instanceof Error ? err : new Error(String(err));
    entry.loading = false;
    triggerUpdate();
  }
}

/**
 * 获取懒加载模块
 */
export function getLazyModule<T>(key: string): LazyModule<T> | undefined {
  return moduleCache.get(key) as LazyModule<T> | undefined;
}

/**
 * 预加载模块
 */
export function preloadModule(key: string): void {
  const entry = moduleCache.get(key);
  if (entry && !entry.module && !entry.loading) {
    // 触发加载（loader 由模块自己管理）
    triggerUpdate();
  }
}

/**
 * 预加载多个模块
 */
export function preloadModules(keys: string[]): void {
  keys.forEach((key) => preloadModule(key));
}

/**
 * 预加载高优先级模块
 */
export function preloadHighPriority(): void {
  preloadModules(HIGH_PRIORITY_MODULES);
}

/**
 * 清除模块缓存
 */
export function clearModuleCache(key?: string): void {
  if (key) {
    moduleCache.delete(key);
  } else {
    moduleCache.clear();
  }
}

// ─────────────────────────────────────────────────────────────
// Render Helper with Error Boundary
// ─────────────────────────────────────────────────────────────

import { html } from 'lit';

/**
 * 懒渲染，带错误处理
 */
export function lazyRender<T>(
  entry: LazyModule<T>,
  render: (module: T) => unknown,
  fallback?: unknown,
  errorRender?: (error: Error) => unknown
): unknown {
  if (entry.module) {
    try {
      return render(entry.module);
    } catch (err) {
      console.error('[LazyRender] Render error:', err);
      return (
        errorRender?.(err instanceof Error ? err : new Error(String(err))) ??
        renderError(err)
      );
    }
  }

  if (entry.error) {
    return errorRender?.(entry.error) ?? renderError(entry.error);
  }

  if (entry.loading) {
    return fallback ?? renderLoading();
  }

  return nothing;
}

/**
 * 渲染加载状态
 */
function renderLoading(): unknown {
  return html`
    <div class="lazy-loading">
      <div class="lazy-loading__spinner"></div>
      <span class="lazy-loading__text">Loading...</span>
    </div>
  `;
}

/**
 * 渲染错误状态
 */
function renderError(error: unknown): unknown {
  return html`
    <div class="lazy-error">
      <div class="lazy-error__icon">⚠️</div>
      <div class="lazy-error__message">
        ${error instanceof Error ? error.message : 'Failed to load module'}
      </div>
      <button
        class="lazy-error__retry"
        @click=${() => {
          // 触发重试
          triggerUpdate();
        }}
      >
        Retry
      </button>
    </div>
  `;
}

// ─────────────────────────────────────────────────────────────
// requestIdleCallback Polyfill
// ─────────────────────────────────────────────────────────────

const requestIdleCallback =
  typeof window !== 'undefined' && 'requestIdleCallback' in window
    ? window.requestIdleCallback
    : (cb: IdleRequestCallback) => setTimeout(() => cb({ didTimeout: false, timeRemaining: () => 50 } as IdleDeadline), 1);