/**
 * Performance Monitoring
 * 
 * 性能监控和优化工具
 */

// ─────────────────────────────────────────────────────────────
// Performance Metrics
// ─────────────────────────────────────────────────────────────

export interface PerformanceMetrics {
  // 渲染性能
  renderTime: number;
  renderCount: number;
  lastRenderDuration: number;

  // 内存
  memoryUsage?: number;

  // 网络
  networkRequests: number;
  networkTime: number;

  // 交互
  interactionLatency: number;
}

// ─────────────────────────────────────────────────────────────
// Performance Monitor
// ─────────────────────────────────────────────────────────────

class PerformanceMonitor {
  private metrics: PerformanceMetrics = {
    renderTime: 0,
    renderCount: 0,
    lastRenderDuration: 0,
    networkRequests: 0,
    networkTime: 0,
    interactionLatency: 0,
  };

  private renderStartTime = 0;

  /**
   * 开始渲染计时
   */
  startRender() {
    this.renderStartTime = performance.now();
  }

  /**
   * 结束渲染计时
   */
  endRender() {
    const duration = performance.now() - this.renderStartTime;
    this.metrics.lastRenderDuration = duration;
    this.metrics.renderTime += duration;
    this.metrics.renderCount++;
  }

  /**
   * 记录网络请求
   */
  recordNetworkRequest(duration: number) {
    this.metrics.networkRequests++;
    this.metrics.networkTime += duration;
  }

  /**
   * 记录交互延迟
   */
  recordInteractionLatency(latency: number) {
    this.metrics.interactionLatency = latency;
  }

  /**
   * 更新内存使用
   */
  updateMemoryUsage() {
    if ('memory' in performance && (performance as any).memory) {
      this.metrics.memoryUsage = (performance as any).memory.usedJSHeapSize;
    }
  }

  /**
   * 获取指标
   */
  getMetrics(): PerformanceMetrics {
    this.updateMemoryUsage();
    return { ...this.metrics };
  }

  /**
   * 重置指标
   */
  reset() {
    this.metrics = {
      renderTime: 0,
      renderCount: 0,
      lastRenderDuration: 0,
      networkRequests: 0,
      networkTime: 0,
      interactionLatency: 0,
    };
  }
}

export const performanceMonitor = new PerformanceMonitor();

// ─────────────────────────────────────────────────────────────
// Performance Helpers
// ─────────────────────────────────────────────────────────────

/**
 * 测量函数执行时间
 */
export async function measureAsync<T>(
  name: string,
  fn: () => Promise<T>
): Promise<T> {
  const start = performance.now();
  try {
    return await fn();
  } finally {
    const duration = performance.now() - start;
    console.debug(`[Perf] ${name}: ${duration.toFixed(2)}ms`);
  }
}

/**
 * 测量同步函数执行时间
 */
export function measureSync<T>(name: string, fn: () => T): T {
  const start = performance.now();
  try {
    return fn();
  } finally {
    const duration = performance.now() - start;
    console.debug(`[Perf] ${name}: ${duration.toFixed(2)}ms`);
  }
}

/**
 * 防抖
 */
export function debounce<T extends (...args: any[]) => any>(
  fn: T,
  delay: number
): (...args: Parameters<T>) => void {
  let timeoutId: ReturnType<typeof setTimeout>;
  return (...args: Parameters<T>) => {
    clearTimeout(timeoutId);
    timeoutId = setTimeout(() => fn(...args), delay);
  };
}

/**
 * 节流
 */
export function throttle<T extends (...args: any[]) => any>(
  fn: T,
  limit: number
): (...args: Parameters<T>) => void {
  let inThrottle = false;
  return (...args: Parameters<T>) => {
    if (!inThrottle) {
      fn(...args);
      inThrottle = true;
      setTimeout(() => (inThrottle = false), limit);
    }
  };
}

/**
 * RAF 节流
 */
export function rafThrottle<T extends (...args: any[]) => any>(
  fn: T
): (...args: Parameters<T>) => void {
  let rafId: number | null = null;
  return (...args: Parameters<T>) => {
    if (rafId === null) {
      rafId = requestAnimationFrame(() => {
        fn(...args);
        rafId = null;
      });
    }
  };
}

// ─────────────────────────────────────────────────────────────
// Critical CSS Extraction Hint
// ─────────────────────────────────────────────────────────────

/**
 * 提示浏览器预加载资源
 */
export function preloadResource(href: string, as: 'style' | 'script' | 'image' | 'font') {
  const link = document.createElement('link');
  link.rel = 'preload';
  link.href = href;
  link.as = as;
  document.head.appendChild(link);
}

/**
 * 提示浏览器预连接
 */
export function preconnect(origin: string) {
  const link = document.createElement('link');
  link.rel = 'preconnect';
  link.href = origin;
  document.head.appendChild(link);
}