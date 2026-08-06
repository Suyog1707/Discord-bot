/**
 * Redirect-target sanitisation.
 *
 * `callbackUrl` arrives from the query string, so it is attacker-controlled.
 * Browsers treat `\` as `/` when resolving special-scheme URLs (WHATWG URL
 * "relative slash state"), which makes `/\evil.com` an open redirect even
 * though it "starts with a single slash". Control characters enable header
 * and parser confusion. Only clean same-origin paths survive.
 */

const FALLBACK = '/dashboard';

/** Allow only a same-origin absolute path: `/…`, no `//`, no `\`, no controls. */
export function safeCallbackUrl(raw: string | undefined, fallback: string = FALLBACK): string {
  if (raw === undefined || raw === '') return fallback;
  if (!raw.startsWith('/')) return fallback;
  if (raw.startsWith('//')) return fallback;
  if (raw.includes('\\')) return fallback;
  // Control characters (0x00-0x1f, 0x7f) enable parser confusion; reject outright.
  // eslint-disable-next-line no-control-regex -- matching control chars is the point here.
  if (/[\u0000-\u001F\u007F]/u.test(raw)) return fallback;
  return raw;
}
