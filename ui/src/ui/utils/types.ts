/**
 * Type Utilities
 * 
 * 通用类型工具，减少类型冗余
 */

// ─────────────────────────────────────────────────────────────
// Common Utility Types
// ─────────────────────────────────────────────────────────────

/**
 * 深层部分类型
 */
export type DeepPartial<T> = T extends object
  ? {
      [P in keyof T]?: DeepPartial<T[P]>;
    }
  : T;

/**
 * 深层必需类型
 */
export type DeepRequired<T> = T extends object
  ? {
      [P in keyof T]-?: DeepRequired<T[P]>;
    }
  : T;

/**
 * 非空类型
 */
export type NonNullable<T> = T extends null | undefined ? never : T;

/**
 * 提取函数参数类型
 */
export type ExtractArgs<T> = T extends (...args: infer A) => any ? A : never;

/**
 * 提取函数返回类型
 */
export type ExtractReturn<T> = T extends (...args: any[]) => infer R ? R : never;

/**
 * 提取 Promise 值类型
 */
export type Awaited<T> = T extends Promise<infer U> ? U : T;

/**
 * 合并类型
 */
export type Merge<A, B> = Omit<A, keyof B> & B;

/**
 * 精确类型（防止扩展）
 */
export type Exact<T, Shape> = T extends Shape
  ? Exclude<keyof T, keyof Shape> extends never
    ? T
    : never
  : never;

// ─────────────────────────────────────────────────────────────
// State Types
// ─────────────────────────────────────────────────────────────

/**
 * 状态切片基础接口
 */
export interface StateSlice {
  loading: boolean;
  error: string | null;
}

/**
 * 分页状态
 */
export interface PaginationState {
  page: number;
  pageSize: number;
  total: number;
  hasMore: boolean;
}

/**
 * 过滤状态
 */
export interface FilterState<T = string> {
  query: string;
  filters: Record<string, T>;
}

/**
 * 排序状态
 */
export interface SortState<K = string> {
  column: K;
  dir: 'asc' | 'desc';
}

// ─────────────────────────────────────────────────────────────
// API Types
// ─────────────────────────────────────────────────────────────

/**
 * API 响应基础类型
 */
export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
  };
}

/**
 * 分页响应
 */
export interface PaginatedResponse<T> extends ApiResponse<T[]> {
  pagination: PaginationState;
}

/**
 * 加载状态
 */
export type LoadingState = 'idle' | 'loading' | 'success' | 'error';

/**
 * 异步状态
 */
export interface AsyncState<T> {
  data: T | null;
  loading: LoadingState;
  error: string | null;
}

// ─────────────────────────────────────────────────────────────
// Component Types
// ─────────────────────────────────────────────────────────────

/**
 * 组件属性基础类型
 */
export interface ComponentProps {
  class?: string;
  id?: string;
  'aria-label'?: string;
  'aria-describedby'?: string;
}

/**
 * 事件处理器类型
 */
export type EventHandler<E = Event> = (event: E) => void;

/**
 * 键盘事件处理器
 */
export type KeyboardEventHandler = EventHandler<KeyboardEvent>;

/**
 * 鼠标事件处理器
 */
export type MouseEventHandler = EventHandler<MouseEvent>;

// ─────────────────────────────────────────────────────────────
// Type Guards
// ─────────────────────────────────────────────────────────────

/**
 * 检查是否为字符串
 */
export function isString(value: unknown): value is string {
  return typeof value === 'string';
}

/**
 * 检查是否为数字
 */
export function isNumber(value: unknown): value is number {
  return typeof value === 'number' && !isNaN(value);
}

/**
 * 检查是否为布尔值
 */
export function isBoolean(value: unknown): value is boolean {
  return typeof value === 'boolean';
}

/**
 * 检查是否为对象
 */
export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 检查是否为数组
 */
export function isArray<T = unknown>(value: unknown): value is T[] {
  return Array.isArray(value);
}

/**
 * 检查是否为错误
 */
export function isError(value: unknown): value is Error {
  return value instanceof Error;
}

/**
 * 检查是否为 null 或 undefined
 */
export function isNullish(value: unknown): value is null | undefined {
  return value === null || value === undefined;
}

/**
 * 检查是否非空
 */
export function isNonNullable<T>(value: T): value is NonNullable<T> {
  return value !== null && value !== undefined;
}

// ─────────────────────────────────────────────────────────────
// Brand Types (Nominal Typing)
// ─────────────────────────────────────────────────────────────

/**
 * 品牌类型（用于创建名义类型）
 */
export type Brand<T, B> = T & { __brand: B };

/**
 * Session Key 类型
 */
export type SessionKey = Brand<string, 'SessionKey'>;

/**
 * Agent ID 类型
 */
export type AgentId = Brand<string, 'AgentId'>;

/**
 * Channel ID 类型
 */
export type ChannelId = Brand<string, 'ChannelId'>;

// ─────────────────────────────────────────────────────────────
// Result Type (for error handling)
// ─────────────────────────────────────────────────────────────

/**
 * 结果类型（函数式错误处理）
 */
export type Result<T, E = Error> =
  | { ok: true; value: T }
  | { ok: false; error: E };

/**
 * 创建成功结果
 */
export function Ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

/**
 * 创建失败结果
 */
export function Err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}

/**
 * 检查是否成功
 */
export function isOk<T, E>(result: Result<T, E>): result is { ok: true; value: T } {
  return result.ok;
}

/**
 * 检查是否失败
 */
export function isErr<T, E>(result: Result<T, E>): result is { ok: false; error: E } {
  return !result.ok;
}