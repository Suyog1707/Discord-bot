/**
 * Stand-in for Next.js's `server-only` guard under Vitest.
 *
 * `server-only` is not a real dependency: Next resolves it in its own bundler
 * to a module that explodes if a client bundle ever pulls it in. Vitest has no
 * such alias, so every service module that imports it — which is all of them,
 * deliberately — would fail to resolve. Aliasing it to this empty module in
 * `vitest.config.ts` keeps the guard meaningful in the build (where it is
 * enforced) without making it untestable.
 */
export {};
