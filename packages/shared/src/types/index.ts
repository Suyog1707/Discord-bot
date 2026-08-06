/** Shared structural types. Domain types arrive with their phases. */
import type { SerializedError } from '../errors/index.js';

/** Discriminated result type for operations that fail as data rather than throwing. */
export type Result<TValue, TError = SerializedError> =
  { readonly ok: true; readonly value: TValue } | { readonly ok: false; readonly error: TError };

export function ok<TValue>(value: TValue): Result<TValue, never> {
  return { ok: true, value };
}

export function err<TError>(error: TError): Result<never, TError> {
  return { ok: false, error };
}

/** Envelope every JSON API route returns (docs/API.md). */
export type ApiResponse<TData> =
  | { readonly success: true; readonly data: TData }
  | { readonly success: false; readonly error: SerializedError };

/** Page of results plus the metadata a client needs to render pagination. */
export interface Paginated<TItem> {
  readonly items: readonly TItem[];
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
  readonly totalPages: number;
  readonly hasNextPage: boolean;
}

/** Recursively mark every property optional. */
export type DeepPartial<T> = T extends object ? { [K in keyof T]?: DeepPartial<T[K]> } : T;

/** Require at least one key of `T` to be present. */
export type AtLeastOne<T, Keys extends keyof T = keyof T> = Partial<T> &
  { [K in Keys]: Required<Pick<T, K>> }[Keys];

/** Widen a literal union while keeping editor autocomplete. */
export type LooseAutocomplete<T extends string> = T | (string & {});
