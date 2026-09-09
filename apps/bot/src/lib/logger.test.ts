/**
 * The lazy logger has to be two things at once, and one of them was quietly
 * broken.
 *
 * It must not build a real logger at import time — modules call `getLogger` at
 * module scope, and constructing one reads validated configuration, so an
 * eager version would make every unit test need a populated `.env`.
 *
 * And it must behave like the logger it stands in for. It did not: the proxy
 * handed `child` back unbound, so `this` was the proxy rather than the pino
 * instance and every binding passed to it was dropped. Command logs carried no
 * command name, no guild and no user for as long as that was true — the module
 * tag survived only because it is applied inside the resolver, on a real
 * logger, which is what made the loss so easy to miss.
 *
 * Asserted through `bindings()` rather than by capturing output: pino writes
 * to the file descriptor directly, and what matters is what the record would
 * carry, not how it is serialised.
 */
import { describe, expect, it } from 'vitest';

import { getLogger } from './logger.js';

describe('getLogger', () => {
  it('tags records with the module', () => {
    expect(getLogger('commands').bindings()).toMatchObject({ module: 'commands' });
  });

  it('carries a child’s bindings alongside the module', () => {
    // The regression: this used to return `{ module }` and nothing else.
    const child = getLogger('commands').child({
      command: 'play',
      guildId: 'guild-1',
      userId: 'user-1',
    });

    expect(child.bindings()).toMatchObject({
      module: 'commands',
      command: 'play',
      guildId: 'guild-1',
      userId: 'user-1',
    });
  });

  it('keeps bindings through a second generation', () => {
    // The routed path nests: the subscriber adds `routed`, then the dispatcher
    // adds the command. Both have to survive to answer "which bot ran what".
    const child = getLogger('routed-commands')
      .child({ routed: true, routeLatencyMs: 40 })
      .child({ command: 'skip' });

    expect(child.bindings()).toMatchObject({
      module: 'routed-commands',
      routed: true,
      routeLatencyMs: 40,
      command: 'skip',
    });
  });

  it('gives each module its own tag rather than sharing one logger', () => {
    expect(getLogger('music').bindings()).toMatchObject({ module: 'music' });
    expect(getLogger('guards').bindings()).toMatchObject({ module: 'guards' });
  });
});
