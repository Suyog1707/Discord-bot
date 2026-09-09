/**
 * How a command's acknowledgement is shown, decided without discord.js.
 *
 * Discord invalidates an interaction that is not acknowledged within three
 * seconds, and the acknowledgement fixes its visibility for good — a reply
 * deferred privately can never become public later. So whoever acknowledges
 * has to know, before doing any work, whether this particular invocation is
 * public or ephemeral.
 *
 * That used to be the bot, which had a live `ChatInputCommandInteraction` to
 * read. It is now the command router, which has raw JSON and no discord.js at
 * all. Hence a *declarative* spec: a value that can be published, serialised
 * and evaluated against a subcommand name, rather than a function only the bot
 * can call.
 *
 * The two sides must agree exactly. If the router defers privately and the bot
 * believes the reply is public, `rejectGuard` deletes a placeholder that is not
 * there and Discord answers 404 — so the mode the router actually sent travels
 * with the interaction rather than being recomputed on arrival.
 */
import { z } from 'zod';

import { REDIS_NAMESPACE, redisKey } from '../constants/index.js';

/** Visibility of the deferred acknowledgement Discord shows while a command runs. */
export const deferralModeSchema = z.enum(['public', 'ephemeral']);
export type DeferralMode = z.infer<typeof deferralModeSchema>;

/**
 * Applied when a command declares nothing.
 *
 * Ephemeral, because it is what all but a handful of commands want and because
 * the safe choice must be the one you get for free — the alternative was
 * thirty-one commands silently racing the acknowledgement deadline.
 */
export const DEFAULT_DEFERRAL: DeferralMode = 'ephemeral';

/**
 * One command's visibility rule.
 *
 * Either one mode for the whole command, or a mode per subcommand — which is
 * the only variation any command actually needs, and is data rather than code
 * so the router can read it.
 */
export const deferralSpecSchema = z.union([
  deferralModeSchema,
  z.object({
    bySubcommand: z.record(z.string(), deferralModeSchema),
    otherwise: deferralModeSchema,
  }),
]);

export type DeferralSpec = z.infer<typeof deferralSpecSchema>;

/**
 * Resolve one invocation's visibility.
 *
 * @param subcommand The invoked subcommand, or null when the command has none.
 */
export function resolveDeferral(
  spec: DeferralSpec | undefined,
  subcommand: string | null,
): DeferralMode {
  if (spec === undefined) return DEFAULT_DEFERRAL;
  if (typeof spec === 'string') return spec;
  if (subcommand === null) return spec.otherwise;

  // `Object.hasOwn` rather than a bare lookup: a subcommand literally named
  // `toString` or `__proto__` would otherwise resolve to something off the
  // prototype chain and fail the enum check in a confusing place.
  return Object.hasOwn(spec.bySubcommand, subcommand)
    ? (spec.bySubcommand[subcommand] ?? spec.otherwise)
    : spec.otherwise;
}

/** Every command's spec, as the bot publishes it and the router reads it. */
export const deferralManifestSchema = z.record(z.string(), deferralSpecSchema);
export type DeferralManifest = z.infer<typeof deferralManifestSchema>;

/**
 * Where the manifest lives.
 *
 * Published by the primary on startup rather than shared as an import,
 * because the router cannot import from `apps/bot` — the command modules pull
 * in discord.js, Lavalink and Prisma. A manifest that is missing or stale
 * costs the default, which is the safe mode, so a cold Redis degrades to
 * "everything is ephemeral" rather than to broken commands.
 */
export const DEFERRAL_MANIFEST_KEY = redisKey(REDIS_NAMESPACE.CACHE, 'deferral-manifest');

/** Long enough to survive a bot restart; refreshed on every startup. */
export const DEFERRAL_MANIFEST_TTL_SECONDS = 24 * 60 * 60;

export function decodeDeferralManifest(raw: string): DeferralManifest | null {
  try {
    const result = deferralManifestSchema.safeParse(JSON.parse(raw));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}
