export class AppError extends Error {
  constructor(code, message = code, status = 500, type = "api_error") {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.status = status;
    this.type = type;
  }
}

export function errorFromUnknown(error, fallbackCode = "internal_error") {
  if (error instanceof AppError) return error;
  const message = error instanceof Error ? error.message : String(error || "Unexpected error");
  return new AppError(fallbackCode, message, 500, "api_error");
}

export function openAiError(error) {
  const appError = errorFromUnknown(error);
  return {
    error: {
      message: appError.message,
      type: appError.type,
      code: appError.code,
      status: appError.status
    }
  };
}

export function hardStopStatus(status) {
  return status === 401 || status === 403 || status === 429;
}

export function isRateLimitLikeError(error) {
  const appError = errorFromUnknown(error);
  const code = String(appError.code || "").toLowerCase();
  return appError.status === 429 || [
    "resource_exhausted",
    "rate_limited",
    "upstream_rate_limited",
    "hard_stop_http_429"
  ].includes(code);
}

export function rateLimitError(message = "Grok Bot upstream rate limit exceeded; retry later") {
  return new AppError("upstream_rate_limited", message, 429, "rate_limit_error");
}
