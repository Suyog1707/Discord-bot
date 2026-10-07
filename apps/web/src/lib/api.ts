/**
 * Route-handler helpers.
 *
 * Every JSON endpoint under `/api` returns the same `ApiResponse` envelope and
 * routes its errors through `handleApiError`, so clients parse one shape and no
 * handler re-invents error mapping (docs/API.md, PROJECT_RULES.md).
 */
import { toAppError, userErrorMessage, type ApiResponse } from '@discord-music/shared';
import { NextResponse } from 'next/server';

import { getLogger } from './logger';

/**
 * Log without ever throwing.
 *
 * The logger reads validated configuration, so a misconfigured environment
 * makes `getLogger` itself throw. Called from the error path that would be
 * reporting exactly that failure, it would replace a precise
 * `ConfigurationError` response with an opaque, body-less 500. The fallback
 * keeps the diagnosis visible when structured logging is unavailable.
 */
function logSafely(level: 'warn' | 'error', payload: Record<string, unknown>): void {
  try {
    getLogger('api')[level](payload, 'API request failed');
  } catch {
    console.error('API request failed', payload);
  }
}

/** `{ success: true, data }` with the given status. */
export function apiSuccess<TData>(
  data: TData,
  init: { status?: number; headers?: HeadersInit } = {},
): NextResponse<ApiResponse<TData>> {
  const { status = 200, headers } = init;
  return NextResponse.json<ApiResponse<TData>>(
    { success: true, data },
    headers === undefined ? { status } : { status, headers },
  );
}

/**
 * Convert any thrown value into a logged, client-safe error response.
 *
 * Unexpected errors are logged at `error` with the full cause; expected ones
 * (validation, not-found) at `warn`. Either way the client only sees the
 * `AppError`'s public payload.
 */
export function handleApiError(error: unknown, route: string): NextResponse<ApiResponse<never>> {
  const appError = toAppError(error);

  logSafely(appError.expected ? 'warn' : 'error', { err: appError, route });

  const headers: Record<string, string> = {};
  if (appError.code === 'RATE_LIMITED') {
    const retryAfter = (appError.details as { retryAfterSeconds?: number } | undefined)
      ?.retryAfterSeconds;
    if (retryAfter !== undefined) headers['Retry-After'] = String(retryAfter);
  }

  return NextResponse.json<ApiResponse<never>>(
    {
      success: false,
      error: appError.expected
        ? appError.toJSON()
        : { code: appError.code, message: userErrorMessage(error) },
    },
    { status: appError.statusCode, headers },
  );
}

/**
 * Wrap a route handler so no unhandled rejection escapes as an opaque 500.
 *
 * @example
 * export const GET = withErrorHandling('GET /api/health', async () => apiSuccess({ ok: true }));
 */
export function withErrorHandling<TArgs extends unknown[]>(
  route: string,
  handler: (...args: TArgs) => Promise<NextResponse>,
): (...args: TArgs) => Promise<NextResponse> {
  return async (...args: TArgs) => {
    try {
      return await handler(...args);
    } catch (error) {
      return handleApiError(error, route);
    }
  };
}
