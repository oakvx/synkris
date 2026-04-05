import type { ApiErrorPayload, ApiErrorSource } from "@whatsapp-ai/shared";

type HttpErrorOptions = {
  code?: string;
  source?: ApiErrorSource;
  retryable?: boolean;
  details?: unknown;
  traceId?: string | null;
};

export class HttpError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly source: ApiErrorSource;
  readonly retryable: boolean;
  readonly details?: unknown;
  readonly traceId: string | null;

  constructor(statusCode: number, message: string, options: HttpErrorOptions = {}) {
    super(message);
    this.name = "HttpError";
    this.statusCode = statusCode;
    this.code = options.code ?? "HTTP_ERROR";
    this.source = options.source ?? "api";
    this.retryable = options.retryable ?? statusCode >= 500;
    this.details = options.details;
    this.traceId = options.traceId ?? null;
  }

  toPayload(traceId = this.traceId): ApiErrorPayload {
    return {
      code: this.code,
      message: this.message,
      source: this.source,
      retryable: this.retryable,
      statusCode: this.statusCode,
      details: this.details,
      traceId,
    };
  }
}

export function isHttpError(error: unknown): error is HttpError {
  return error instanceof HttpError;
}
