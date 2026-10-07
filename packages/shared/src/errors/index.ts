/**
 * Application error hierarchy.
 *
 * Every error crossing a boundary (HTTP route, slash command, job) should be an
 * `AppError` so callers get a stable machine-readable `code`, a safe
 * `userMessage`, and an HTTP status without re-deriving them at each call site.
 */

/** Stable, machine-readable error codes. Never renumber or reuse a value. */
export const ErrorCode = {
  // 400 family
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  BAD_REQUEST: 'BAD_REQUEST',
  // 401 / 403
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  FORBIDDEN: 'FORBIDDEN',
  // 404 / 409
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  // 429
  RATE_LIMITED: 'RATE_LIMITED',
  // 5xx
  INTERNAL: 'INTERNAL',
  UPSTREAM_UNAVAILABLE: 'UPSTREAM_UNAVAILABLE',
  CONFIGURATION: 'CONFIGURATION',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

/** Serialisable shape returned to API clients. Never contains internal details. */
export interface SerializedError {
  readonly code: ErrorCode;
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export interface AppErrorOptions {
  /** Wrapped lower-level error, preserved for logs but never sent to clients. */
  readonly cause?: unknown;
  /** Structured, client-safe context (e.g. field-level validation issues). */
  readonly details?: Readonly<Record<string, unknown>>;
  /** Whether the caller may retry the same request unchanged. */
  readonly retryable?: boolean;
}

/**
 * Base class for all expected, handled failures.
 *
 * `expected: true` marks errors that are part of normal operation (a 404, a
 * failed validation) so logging can use `warn` instead of `error`.
 */
/**
 * Cross-bundle brand for {@link AppError}.
 *
 * `instanceof` compares class identity, which holds only while there is one
 * copy of this module. A bundler that emits an entry point per command — tsup
 * without `splitting` — gives each chunk its own `AppError`, so a
 * `ValidationError` thrown in `commands/music/resume` fails `instanceof
 * AppError` in `events/interaction-create` and is reported as an unexpected
 * 500 instead of the message the user should have seen. `Symbol.for` resolves
 * to the same key in every copy, so identity survives the duplication.
 */
const APP_ERROR: unique symbol = Symbol.for('@discord-music/shared/AppError');

export class AppError extends Error {
  readonly [APP_ERROR] = true;
  readonly code: ErrorCode;
  readonly statusCode: number;
  readonly details: Readonly<Record<string, unknown>> | undefined;
  readonly retryable: boolean;
  readonly expected: boolean = true;

  constructor(code: ErrorCode, statusCode: number, message: string, options: AppErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.code = code;
    this.statusCode = statusCode;
    this.details = options.details;
    this.retryable = options.retryable ?? statusCode >= 500;
    // Omit this constructor from the stack so traces point at the throw site.
    Error.captureStackTrace(this, new.target);
  }

  /** Client-safe JSON payload. */
  toJSON(): SerializedError {
    return this.details === undefined
      ? { code: this.code, message: this.message }
      : { code: this.code, message: this.message, details: this.details };
  }
}

export class ValidationError extends AppError {
  constructor(message = 'The submitted data is invalid.', options: AppErrorOptions = {}) {
    super(ErrorCode.VALIDATION_FAILED, 400, message, options);
  }
}

export class BadRequestError extends AppError {
  constructor(message = 'The request could not be processed.', options: AppErrorOptions = {}) {
    super(ErrorCode.BAD_REQUEST, 400, message, options);
  }
}

export class UnauthenticatedError extends AppError {
  constructor(message = 'You must be signed in to do that.', options: AppErrorOptions = {}) {
    super(ErrorCode.UNAUTHENTICATED, 401, message, options);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'You do not have permission to do that.', options: AppErrorOptions = {}) {
    super(ErrorCode.FORBIDDEN, 403, message, options);
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'The requested resource was not found.', options: AppErrorOptions = {}) {
    super(ErrorCode.NOT_FOUND, 404, message, options);
  }
}

export class ConflictError extends AppError {
  constructor(
    message = 'That action conflicts with the current state.',
    options: AppErrorOptions = {},
  ) {
    super(ErrorCode.CONFLICT, 409, message, options);
  }
}

export class RateLimitError extends AppError {
  /** Seconds the caller should wait before retrying. */
  readonly retryAfterSeconds: number;

  constructor(retryAfterSeconds: number, message = 'Too many requests. Please slow down.') {
    super(ErrorCode.RATE_LIMITED, 429, message, {
      retryable: true,
      details: { retryAfterSeconds },
    });
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export class UpstreamError extends AppError {
  constructor(message = 'An upstream service is unavailable.', options: AppErrorOptions = {}) {
    super(ErrorCode.UPSTREAM_UNAVAILABLE, 502, message, { retryable: true, ...options });
  }
}

/** Misconfiguration — missing env var, unreachable dependency at boot, etc. */
export class ConfigurationError extends AppError {
  override readonly expected = false;

  constructor(message: string, options: AppErrorOptions = {}) {
    super(ErrorCode.CONFIGURATION, 500, message, { retryable: false, ...options });
  }
}

/** Unexpected failure. The message is generic; real details stay in the logs. */
export class InternalError extends AppError {
  override readonly expected = false;

  constructor(message = 'Something went wrong on our end.', options: AppErrorOptions = {}) {
    super(ErrorCode.INTERNAL, 500, message, options);
  }
}

export function isAppError(value: unknown): value is AppError {
  return value instanceof Error && APP_ERROR in value;
}

/**
 * Coerce any thrown value into an `AppError`.
 *
 * Use at every boundary so `catch (error: unknown)` never leaks raw messages.
 */
export function toAppError(error: unknown): AppError {
  if (isAppError(error)) return error;
  if (error instanceof Error) return new InternalError(undefined, { cause: error });
  return new InternalError(undefined, { cause: new Error(String(error)) });
}

/** Classify only known failure codes; never expose arbitrary exception text. */
export function userErrorMessage(error: unknown): string {
  if (isAppError(error) && error.expected) return error.message;
  let current = error;
  for (let depth = 0; depth < 4 && current instanceof Error; depth++) {
    const code = (current as Error & { code?: unknown }).code;
    if (code === 'P1001' || code === 'P1002' || code === 'P1017')
      return 'The database is unavailable. Please try again shortly.';
    if (code === 50013 || code === 50001)
      return 'The bot is missing Discord permissions or channel access. Ask a server administrator to check its permissions.';
    if (current.name === 'TimeoutError' || current.name === 'AbortError')
      return 'The request timed out. Please try again shortly.';
    current = current.cause;
  }
  return 'An unexpected error prevented this action. Please try again; if it persists, contact the bot administrator.';
}
