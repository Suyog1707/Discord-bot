import { describe, expect, it } from 'vitest';

import {
  AppError,
  ConfigurationError,
  ErrorCode,
  InternalError,
  NotFoundError,
  RateLimitError,
  isAppError,
  toAppError,
} from './index.js';

describe('AppError', () => {
  it('exposes code, status and a client-safe payload', () => {
    const error = new NotFoundError('Playlist not found.');

    expect(error.code).toBe(ErrorCode.NOT_FOUND);
    expect(error.statusCode).toBe(404);
    expect(error.name).toBe('NotFoundError');
    expect(error.toJSON()).toEqual({
      code: ErrorCode.NOT_FOUND,
      message: 'Playlist not found.',
    });
  });

  it('omits `details` from JSON when none were supplied', () => {
    expect(new NotFoundError().toJSON()).not.toHaveProperty('details');
  });

  it('includes structured details when supplied', () => {
    const error = new AppError(ErrorCode.VALIDATION_FAILED, 400, 'Invalid.', {
      details: { fields: { name: ['Required'] } },
    });

    expect(error.toJSON().details).toEqual({ fields: { name: ['Required'] } });
  });

  it('defaults `retryable` from the status code', () => {
    expect(new NotFoundError().retryable).toBe(false);
    expect(new InternalError().retryable).toBe(true);
  });

  it('marks 4xx as expected and configuration failures as unexpected', () => {
    expect(new NotFoundError().expected).toBe(true);
    expect(new ConfigurationError('Missing BOT_TOKEN').expected).toBe(false);
  });

  it('preserves the wrapped cause', () => {
    const cause = new Error('socket hang up');
    expect(new InternalError('boom', { cause }).cause).toBe(cause);
  });
});

describe('RateLimitError', () => {
  it('carries retryAfterSeconds in details', () => {
    const error = new RateLimitError(30);

    expect(error.statusCode).toBe(429);
    expect(error.retryAfterSeconds).toBe(30);
    expect(error.toJSON().details).toEqual({ retryAfterSeconds: 30 });
  });
});

describe('toAppError', () => {
  it('returns AppError instances unchanged', () => {
    const error = new NotFoundError();
    expect(toAppError(error)).toBe(error);
  });

  it('wraps plain Errors without leaking their message', () => {
    const wrapped = toAppError(new Error('connection string: postgres://secret'));

    expect(isAppError(wrapped)).toBe(true);
    expect(wrapped.code).toBe(ErrorCode.INTERNAL);
    expect(wrapped.message).not.toContain('secret');
  });

  it('wraps non-Error throwables', () => {
    const wrapped = toAppError('just a string');

    expect(wrapped).toBeInstanceOf(InternalError);
    expect((wrapped.cause as Error).message).toBe('just a string');
  });
});
