// 错误体系：AppError class + 8 静态工厂 + toResponse()
// 对应 Rust crates/server/src/error.rs，行为 1:1 复刻。
//
// 翻译决策：
// - thiserror::Error 枚举 → ES class（每个变体用静态工厂方法构造）
// - IntoResponse::into_response → instance method toResponse()
// - tracing::error! / tracing::warn! → console.error / console.warn（CLAUDE.md 禁 println!/eprintln!，console.* 是 TS 等价物）
// - serde_json::json! → 普通 JS 对象字面量
// - Internal 自动 console.error 且 message 替换为「服务器内部错误」（不泄露原始 m）
// - ServiceUnavailable code='PB_UNAVAILABLE'（error.rs:50-83 1:1）

/** 错误详情（对应 Rust ErrorDetail） */
export interface ErrorDetail {
  code: string;
  message: string;
}

/** 统一 API 响应结构（对应 Rust ApiResponse<T>） */
export interface ApiResponse<T> {
  data: T | null;
  error: ErrorDetail | null;
}

/** 构造成功响应 */
export function apiOk<T>(data: T): ApiResponse<T> {
  return { data, error: null };
}

/**
 * 应用错误。对应 Rust enum AppError。
 * 每个变体映射到一组 (httpStatus, code, message) 规则。
 */
export class AppError extends Error {
  /** HTTP 状态码 */
  readonly status: number;
  /** 业务错误码（如 NOT_FOUND / PB_UNAVAILABLE） */
  readonly code: string;
  /** 对外暴露的 message（Internal 已被替换为「服务器内部错误」） */
  readonly publicMessage: string;

  private constructor(
    status: number,
    code: string,
    publicMessage: string,
    rawMessage: string,
  ) {
    super(rawMessage);
    this.name = "AppError";
    this.status = status;
    this.code = code;
    this.publicMessage = publicMessage;
  }

  /** 资源不存在: {msg} */
  static NotFound(msg: string): AppError {
    return new AppError(404, "NOT_FOUND", msg, msg);
  }

  /** 请求参数错误: {msg} */
  static BadRequest(msg: string): AppError {
    return new AppError(400, "BAD_REQUEST", msg, msg);
  }

  /** 资源冲突: {msg} */
  static Conflict(msg: string): AppError {
    return new AppError(409, "CONFLICT", msg, msg);
  }

  /** 请求体过大: {msg} */
  static PayloadTooLarge(msg: string): AppError {
    return new AppError(413, "PAYLOAD_TOO_LARGE", msg, msg);
  }

  /** 未授权: {msg} */
  static Unauthorized(msg: string): AppError {
    return new AppError(401, "UNAUTHORIZED", msg, msg);
  }

  /** 禁止访问: {msg} */
  static Forbidden(msg: string): AppError {
    return new AppError(403, "FORBIDDEN", msg, msg);
  }

  /** 内部错误: {msg} —— 自动 console.error 且 message 替换为「服务器内部错误」 */
  static Internal(msg: string): AppError {
    console.error(`内部错误: ${msg}`);
    return new AppError(500, "INTERNAL_ERROR", "服务器内部错误", msg);
  }

  /** 服务暂不可用: {msg} —— code 为 PB_UNAVAILABLE，并 console.warn 提示 PocketBase 后端不可用 */
  static ServiceUnavailable(msg: string): AppError {
    console.warn(`PocketBase 后端不可用: ${msg}`);
    return new AppError(503, "PB_UNAVAILABLE", msg, msg);
  }

  /**
   * 从既有 AppError 复制 status/code，构造新 message（保留同种类）。
   *
   * 用于 bundle 上传在循环中遇到错误时，把「已写入 X 个文件」信息附在 message 里。
   * Internal 不走此路径（已 sanitize）。
   */
  static fromKind(src: AppError, message: string): AppError {
    return new AppError(src.status, src.code, message, message);
  }

  /**
   * 转换为 Web 标准 Response（对应 Rust IntoResponse::into_response）。
   * body 结构：{ data: null, error: { code, message, request_id? } }
   *
   * request_id 可选注入（来自 trace middleware），便于 agent 报 bug 时关联
   * 平台日志。
   */
  toResponse(requestId?: string): Response {
    const err: ErrorDetail & { request_id?: string } = {
      code: this.code,
      message: this.publicMessage,
    };
    if (requestId !== undefined) {
      err.request_id = requestId;
    }
    const body: ApiResponse<null> = {
      data: null,
      error: err,
    };
    return Response.json(body, { status: this.status });
  }
}
