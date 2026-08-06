/**
 * Remove keys whose value is `undefined`.
 *
 * Zod `.optional()` fields type as `T | undefined`, but with
 * `exactOptionalPropertyTypes` Prisma's inputs reject explicit `undefined`
 * values — "absent" and "present but undefined" are different things. This
 * converts the former into the latter at the service boundary.
 */
export function omitUndefined<T extends Record<string, unknown>>(
  value: T,
): { [K in keyof T]?: Exclude<T[K], undefined> } {
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined) result[key] = entry;
  }
  return result as { [K in keyof T]?: Exclude<T[K], undefined> };
}
