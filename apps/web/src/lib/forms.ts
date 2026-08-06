/**
 * FormData extraction helpers for server actions.
 *
 * `FormData.get` returns `File | string | null`; naive `String(...)` would
 * stringify a File as `[object File]`. These helpers make the string/number
 * cases explicit and total.
 */
export function formString(formData: FormData, field: string): string {
  const value = formData.get(field);
  return typeof value === 'string' ? value : '';
}

export function formNumber(formData: FormData, field: string): number {
  const raw = formString(formData, field).trim();
  return raw === '' ? Number.NaN : Number(raw);
}
