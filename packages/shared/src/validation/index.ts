/**
 * Reusable Zod primitives and parsing helpers.
 *
 * PROJECT_RULES.md requires validation everywhere; centralising the primitives
 * keeps a snowflake or a volume defined exactly once.
 */
import { z } from 'zod';

import { LIMITS, LOOP_MODES, MUSIC_SOURCES, SNOWFLAKE_PATTERN } from '../constants/index.js';
import { ValidationError } from '../errors/index.js';

/** A Discord snowflake ID (user, guild, channel, message). */
export const snowflakeSchema = z
  .string()
  .regex(SNOWFLAKE_PATTERN, 'Must be a valid Discord ID.')
  .brand<'Snowflake'>();

export type Snowflake = z.infer<typeof snowflakeSchema>;

export const musicSourceSchema = z.enum(MUSIC_SOURCES);
export const loopModeSchema = z.enum(LOOP_MODES);

export const volumeSchema = z.number().int().min(LIMITS.VOLUME_MIN).max(LIMITS.VOLUME_MAX);

/** Standard cursor-free pagination input for list endpoints. */
export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce
    .number()
    .int()
    .min(1)
    .max(LIMITS.PAGE_SIZE_MAX)
    .default(LIMITS.PAGE_SIZE_DEFAULT),
});

export type PaginationInput = z.input<typeof paginationSchema>;
export type Pagination = z.output<typeof paginationSchema>;

/** Trimmed, non-empty string with an explicit maximum length. */
export function nonEmptyString(max: number, label = 'Value') {
  return z
    .string()
    .trim()
    .min(1, `${label} is required.`)
    .max(max, `${label} must be at most ${String(max)} characters.`);
}

/** Flatten a Zod error into `{ "path.to.field": ["message", ...] }`. */
export function formatZodError(error: z.ZodError): Record<string, string[]> {
  const fieldErrors: Record<string, string[]> = {};
  for (const issue of error.issues) {
    const key = issue.path.length > 0 ? issue.path.join('.') : '_root';
    (fieldErrors[key] ??= []).push(issue.message);
  }
  return fieldErrors;
}

/**
 * Parse `input` or throw a `ValidationError` carrying field-level details.
 *
 * Prefer this over `schema.parse` at boundaries so failures serialise
 * consistently for both HTTP responses and Discord replies.
 */
export function parseOrThrow<TSchema extends z.ZodType>(
  schema: TSchema,
  input: unknown,
  message = 'The submitted data is invalid.',
): z.output<TSchema> {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new ValidationError(message, {
      cause: result.error,
      details: { fields: formatZodError(result.error) },
    });
  }
  return result.data;
}

export { z };
