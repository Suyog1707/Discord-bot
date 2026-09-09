/**
 * Register slash commands with Discord.
 *
 *   pnpm --filter @discord-music/bot run commands:deploy   # register
 *   pnpm --filter @discord-music/bot run commands:clear    # remove all
 *
 * When `BOT_DEV_GUILD_ID` is set, commands are registered to that guild only —
 * guild commands propagate instantly, global commands can take up to an hour.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ConfigurationError } from '@discord-music/shared';
import { REST, Routes } from 'discord.js';

import { getEnv, isDevelopment } from '../config/env.js';
import { CommandRegistry } from '../core/command-registry.js';
import { getLogger } from '../lib/logger.js';

const logger = getLogger('deploy-commands');
const moduleDirectory = dirname(fileURLToPath(import.meta.url));

/**
 * Refuse to deploy to a guild the bot is not a member of.
 *
 * A mistyped `BOT_DEV_GUILD_ID` otherwise fails with a raw Discord 400 (or,
 * for a plausible-looking id, silently registers commands where nobody will
 * ever see them) — which presents as "slash commands do not appear" with no
 * hint of the cause. Membership is the one check that catches both.
 */
async function assertBotIsMember(rest: REST, guildId: string): Promise<void> {
  const guilds = (await rest.get(Routes.userGuilds())) as readonly { id: string; name: string }[];
  const match = guilds.find((guild) => guild.id === guildId);
  if (match !== undefined) {
    logger.info({ guildId, guild: match.name }, 'Target guild verified');
    return;
  }

  const memberOf =
    guilds.length === 0
      ? 'The bot is not a member of any server — invite it first.'
      : `The bot is a member of: ${guilds.map((guild) => `${guild.name} (${guild.id})`).join(', ')}.`;
  throw new ConfigurationError(
    `BOT_DEV_GUILD_ID=${guildId} is not a server the bot belongs to. ${memberOf} ` +
      'Check the value for typos, or invite the bot to that server and re-run.',
  );
}

async function main(): Promise<void> {
  const env = getEnv();
  const clear = process.argv.includes('--clear');
  const devGuildId = env.BOT_DEV_GUILD_ID;

  /**
   * Only one application may own the commands.
   *
   * Discord lists a command once per application that registered it, so
   * deploying to a second one puts a second `/play` in the picker with no way
   * for anybody to tell which bot each belongs to. Players are headless by
   * design — they load no command modules at runtime — but this script reads
   * whatever credentials are in scope, so running it from a player's
   * environment, or with a player's token pasted into `.env`, is all it takes.
   *
   * `--clear` is allowed through: removing commands from an application that
   * should not have had them is exactly the repair for having done this once.
   */
  if (env.BOT_ROLE !== 'primary' && !clear) {
    throw new ConfigurationError(
      `Refusing to deploy commands as "${env.BOT_LABEL}" (BOT_ROLE=${env.BOT_ROLE}). ` +
        'Only the primary application registers commands — a second one would put a ' +
        "duplicate of every command in the picker. Deploy with the primary's " +
        'BOT_TOKEN and BOT_CLIENT_ID, or pass --clear to remove commands from this one.',
    );
  }

  const registry = new CommandRegistry();
  if (!clear) {
    await registry.loadFrom(join(moduleDirectory, '..', 'commands'));
    if (registry.size === 0) {
      logger.warn('No commands found; nothing to deploy.');
      return;
    }
  }

  const body = clear ? [] : registry.toDeploymentPayload({ includeDevOnly: isDevelopment() });
  const rest = new REST({ version: '10' }).setToken(env.BOT_TOKEN);

  if (devGuildId !== undefined) {
    await assertBotIsMember(rest, devGuildId);
  }

  const route =
    devGuildId === undefined
      ? Routes.applicationCommands(env.BOT_CLIENT_ID)
      : Routes.applicationGuildCommands(env.BOT_CLIENT_ID, devGuildId);

  const scope = devGuildId === undefined ? 'global' : `guild ${devGuildId}`;
  logger.info({ scope, count: body.length }, clear ? 'Clearing commands' : 'Deploying commands');

  const result = (await rest.put(route, { body })) as unknown[];

  logger.info({ scope, count: result.length }, 'Command deployment complete');
}

try {
  await main();
} catch (error) {
  logger.error({ err: error }, 'Command deployment failed');
  process.exitCode = 1;
}
