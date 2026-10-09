/** Auth.js wraps the actual exception in cause.err, which the standard pino
 * serializer drops. Emit an allowlisted diagnostic, never response bodies,
 * tokens, request URLs or raw exception messages. */
export function authDiagnostics(error: unknown): Record<string, unknown> {
  const causes: Record<string, string>[] = [];
  let current = error;
  for (let depth = 0; depth < 5 && current !== null && typeof current === 'object'; depth++) {
    const value = current as Record<string, unknown>;
    const diagnostic: Record<string, string> = {};
    for (const key of ['name', 'type', 'code']) {
      const field = value[key];
      if (typeof field === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,79}$/u.test(field))
        diagnostic[key] = field;
    }
    const message = typeof value.message === 'string' ? value.message : '';
    const property =
      /"(access_token|token_type|expires_in|refresh_token|scope|id_token|sub)" property/u.exec(
        message,
      )?.[1];
    if (property) {
      diagnostic.property = property;
      diagnostic.category = 'OAuth response property missing or invalid';
    } else if (/no authorization code in/iu.test(message))
      diagnostic.category = 'OAuth callback missing authorization code';
    else if (/invalid_client/iu.test(message))
      diagnostic.category = 'Discord client credentials rejected';
    else if (/invalid_grant/iu.test(message))
      diagnostic.category = 'Discord authorization code rejected or redirect URI mismatch';
    else if (/state|pkce|nonce/iu.test(message))
      diagnostic.category = 'OAuth state or verification cookie failure';
    else if (/unknown argument|unknown field|does not exist/iu.test(message))
      diagnostic.category = 'Database schema or adapter mismatch';
    else if (/unique constraint/iu.test(message))
      diagnostic.category = 'Database identity uniqueness conflict';
    else if (/connect|fetch failed|timeout|timed out/iu.test(message))
      diagnostic.category = 'Database or upstream connectivity failure';
    causes.push(diagnostic);
    const cause = value.cause;
    current = cause !== null && typeof cause === 'object' && 'err' in cause ? cause.err : cause;
  }
  return { causes };
}
