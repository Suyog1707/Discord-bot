import { describe, expect, it } from 'vitest';

import { redisKey, REDIS_NAMESPACE } from '../constants/index.js';
import { ValidationError } from '../errors/index.js';
import { formatZodError, paginationSchema, parseOrThrow, snowflakeSchema, z } from './index.js';

describe('snowflakeSchema', () => {
  it('accepts a 17–20 digit ID', () => {
    expect(snowflakeSchema.parse('123456789012345678')).toBe('123456789012345678');
  });

  it.each(['123', '', 'abcdefghijklmnopqr', '1234567890123456789012'])('rejects %j', (input) => {
    expect(snowflakeSchema.safeParse(input).success).toBe(false);
  });
});

describe('paginationSchema', () => {
  it('applies defaults', () => {
    expect(paginationSchema.parse({})).toEqual({ page: 1, pageSize: 20 });
  });

  it('coerces query-string values', () => {
    expect(paginationSchema.parse({ page: '3', pageSize: '50' })).toEqual({
      page: 3,
      pageSize: 50,
    });
  });

  it('rejects a pageSize above the maximum', () => {
    expect(paginationSchema.safeParse({ pageSize: 1000 }).success).toBe(false);
  });
});

describe('parseOrThrow', () => {
  const schema = z.object({ name: z.string().min(1), age: z.number().int() });

  it('returns parsed data on success', () => {
    expect(parseOrThrow(schema, { name: 'Ada', age: 36 })).toEqual({ name: 'Ada', age: 36 });
  });

  it('throws a ValidationError carrying field-level details', () => {
    try {
      parseOrThrow(schema, { name: '', age: 1.5 });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      const details = (error as ValidationError).details as { fields: Record<string, string[]> };
      expect(Object.keys(details.fields)).toEqual(expect.arrayContaining(['name', 'age']));
      expect((error as ValidationError).statusCode).toBe(400);
    }
  });
});

describe('formatZodError', () => {
  it('groups messages by dotted path', () => {
    const schema = z.object({ user: z.object({ email: z.email() }) });
    const result = schema.safeParse({ user: { email: 'nope' } });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(formatZodError(result.error)).toHaveProperty('user.email');
    }
  });
});

describe('redisKey', () => {
  it('builds a namespaced key', () => {
    expect(redisKey(REDIS_NAMESPACE.RATE_LIMIT, 'ip', '1.2.3.4')).toBe('dmp:ratelimit:ip:1.2.3.4');
  });
});
