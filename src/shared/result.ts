/**
 * Result —— 跨层边界的"错误即返回值"
 *
 * 设计约定：
 *  - 可预期的失败（网络、权限、校验）一律返回 Result，不抛异常；
 *  - 异常只保留给"程序错误"（bug），由全局兜底捕获。
 */
export type Result<T, E = AppError> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly error: E };

export const ok = <T>(data: T): Result<T, never> => ({ ok: true, data });
export const err = <E>(error: E): Result<never, E> => ({ ok: false, error });

/** 解包，失败时抛错。仅用于"此处失败即 bug"的场景，业务代码请勿使用 */
export function unwrap<T, E>(r: Result<T, E>): T {
  if (r.ok) return r.data;
  throw new Error(`unwrap() on error result: ${JSON.stringify(r.error)}`);
}

/** 稳定错误码枚举：UI 据此映射中文文案，避免把上游字符串直接抛给用户 */
export type ErrorCode =
  | 'UPSTREAM_UNAUTHORIZED'
  | 'UPSTREAM_RATE_LIMITED'
  | 'UPSTREAM_INSUFFICIENT_BALANCE'
  | 'UPSTREAM_CONTEXT_TOO_LONG'
  | 'UPSTREAM_TIMEOUT'
  | 'UPSTREAM_BAD_REQUEST'
  | 'UPSTREAM_SERVER_ERROR'
  | 'NETWORK_ERROR'
  | 'ABORTED'
  | 'FS_PATH_DENIED'
  /** 工作区编辑权限未开启 —— 与「用户点了拒绝」是两件事，不能共用一个码 */
  | 'FS_EDIT_DENIED'
  | 'FS_NOT_FOUND'
  | 'FS_CONFLICT'
  | 'FS_IO_ERROR'
  | 'TOOL_DENIED_BY_USER'
  | 'TOOL_INVALID_INPUT'
  | 'TOOL_TIMEOUT'
  | 'STORAGE_MIGRATION_FAILED'
  | 'STORAGE_ERROR'
  | 'VALIDATION_ERROR'
  | 'UNKNOWN';

export interface AppError {
  code: ErrorCode;
  /** 面向用户的中文文案 */
  message: string;
  /** 面向开发者的原始信息（不得包含密钥、文件内容等敏感数据） */
  detail?: unknown;
  /** 是否可安全重试（流式已产出内容后必须为 false） */
  retryable: boolean;
  cause?: string;
}

export const appError = (
  code: ErrorCode,
  message: string,
  extra?: Partial<Pick<AppError, 'detail' | 'retryable' | 'cause'>>,
): AppError => ({
  code,
  message,
  retryable: extra?.retryable ?? false,
  ...(extra?.detail !== undefined ? { detail: extra.detail } : {}),
  ...(extra?.cause !== undefined ? { cause: extra.cause } : {}),
});

/** 把任意 unknown 归一化为 AppError（禁止把原始异常直接上抛给 UI） */
export function toAppError(e: unknown, fallbackMessage = '发生未知错误'): AppError {
  if (e instanceof DOMException && e.name === 'AbortError') {
    return appError('ABORTED', '已取消');
  }
  if (e instanceof Error) {
    return appError('UNKNOWN', fallbackMessage, { detail: e.message, cause: e.name });
  }
  return appError('UNKNOWN', fallbackMessage, { detail: String(e) });
}


