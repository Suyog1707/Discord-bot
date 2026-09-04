/** Timer helpers shared by the music engine. */

/**
 * Resolve after `ms`.
 *
 * The timer is unrefed so a pending wait never holds the process open through
 * a shutdown — every caller is pacing optional work, not doing it.
 */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });
}
