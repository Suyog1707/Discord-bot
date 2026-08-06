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

import { REST, Routes } from 'discord.js';

import { getEnv, isDevelopment } from '../config/env.js';
import { CommandRegistry } from '../core/command-registry.js';
import { getLogger } from '../lib/logger.js';

const logger = getLogger('deploy-commands');
const moduleDirectory = dirname(fileURLToPath(import.meta.url));

async function main(): Promise<void> {
  const env = getEnv();
  const clear = process.argv.includes('--clear');
  const devGuildId = env.BOT_DEV_GUILD_ID;

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
