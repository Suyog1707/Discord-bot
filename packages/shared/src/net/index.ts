/**
 * Socket-error helpers.
 *
 * Node reports an unreachable host as an `AggregateError` holding one sub-error
 * per resolved address (IPv6 then IPv4). Logging it raw produces a wall of
 * duplicated stack frames that buries the one fact that matters — which
 * host:port refused. These helpers reduce it to that fact and classify whether
 * the peer is simply absent, which is an operator problem rather than a bug.
 */

type SocketError = Error & {
  code?: string;
  address?: string;
  port?: number;
  errors?: readonly unknown[];
};

/** Errors that mean "nothing is listening / cannot be reached", not "we broke". */
const UNREACHABLE_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ECONNABORTED',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
  'ETIMEDOUT',
]);

/**
 * Reduce a socket error to the fields that identify it.
 *
 * An `AggregateError` carries no `address`/`port`/`message` of its own — those
 * live on the individual attempts — so the first sub-error fills them in.
 */
export function summarizeSocketError(error: Error): Record<string, unknown> {
  const socketError = error as SocketError;
  const [firstAttempt] = (socketError.errors ?? []) as SocketError[];
  const detail = socketError.address === undefined ? firstAttempt : socketError;

  return {
    code: socketError.code ?? firstAttempt?.code ?? error.name,
    address: detail?.address,
    port: detail?.port,
    reason: error.message || firstAttempt?.message,
  };
}

/**
 * Whether the error means the remote is unreachable rather than misbehaving.
 *
 * Used to log an absent development dependency as a warning with a hint,
 * instead of an error with a stack trace nobody can act on.
 */
export function isUnreachableError(error: Error): boolean {
  const socketError = error as SocketError;
  const code = socketError.code ?? (socketError.errors as SocketError[] | undefined)?.[0]?.code;
  if (code !== undefined && UNREACHABLE_CODES.has(code)) return true;

  // `ws` reports a refused handshake with this message and no code.
  return error.message.includes('closed before a connection was established');
}
