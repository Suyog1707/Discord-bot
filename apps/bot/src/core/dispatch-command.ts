/**
 * Running one slash command, however it got here.
 *
 * A command used to arrive exactly one way: as a gateway event on the bot that
 * registered it. It now arrives two ways — that, and off a Redis queue after
 * the command router picked this bot for the caller's voice channel — and both
 * have to behave identically. Not "similarly": the ordering below is load
 * bearing in ways that are invisible until it is wrong.
 *
 * So it lives in one function that neither path may fork. The routed path
 * differs in exactly one respect, that the acknowledgement has already been
 * sent, and even that is expressed by the interaction saying so rather than by
 * a flag this function branches on.
 */
import { isAppError, toAppError } from '@discord-music/shared';
import type { ChatInputCommandInteraction } from 'discord.js';

import type { Logger } from '../lib/logger.js';

import type { BotClient } from './bot-client.js';
import { resolveDeferral, subcommandOf } from './command.js';
import { runGuards } from './guards.js';
import {
  acknowledge,
  claimInteraction,
  rejectGuard,
  replyWithError,
} from './interaction-response.js';

export async function dispatchChatInputCommand(
  client: BotClient,
  interaction: ChatInputCommandInteraction,
  logger: Logger,
): Promise<void> {
  // Exactly one handler owns an interaction. A duplicate id means the same
  // event was delivered or dispatched twice — the second attempt could only
  // ever fail with 40060/10062, so it is dropped and reported instead of being
  // allowed to race the first.
  if (!claimInteraction(interaction.id)) {
    logger.error(
      {
        interactionId: interaction.id,
        command: interaction.commandName,
        instanceId: client.instanceId,
        pid: process.pid,
      },
      'Duplicate dispatch for the same interaction id — dropping. ' +
        'This means duplicate listeners or a second bot process sharing the token.',
    );
    return;
  }

  const command = client.commands.get(interaction.commandName);

  const commandLogger = logger.child({
    command: interaction.commandName,
    guildId: interaction.guildId ?? undefined,
    userId: interaction.user.id,
    interactionId: interaction.id,
  });

  if (!command) {
    // Usually a stale registration — the command was removed but not redeployed.
    commandLogger.warn('Received unknown command');
    await replyWithError(interaction, 'That command is no longer available.', commandLogger);
    return;
  }

  const startedAt = Date.now();
  // How long the interaction had already been alive when it reached us. A
  // value close to Discord's three-second budget is the signal that the
  // acknowledgement is at risk, whatever the eventual outcome. On a routed
  // command this includes the hop through the router, so read it alongside
  // `routeLatencyMs` rather than on its own.
  const receivedAgeMs = startedAt - interaction.createdTimestamp;

  // Acknowledge before anything else: every line below this point — guards
  // included — performs remote I/O, and none of it may run inside Discord's
  // three-second window. Commands opt out of nothing; they only choose
  // whether the placeholder is public.
  //
  // On a routed command the router has already done this, and `acknowledge`
  // sees an interaction that is deferred and returns immediately. That is why
  // the routed path can share this code rather than branch around it.
  const deferral = resolveDeferral(command.deferral, subcommandOf(interaction));

  const alive = await acknowledge(interaction, deferral, commandLogger);
  if (!alive) return;
  commandLogger.debug(
    { ackMs: Date.now() - startedAt, receivedAgeMs, deferral },
    'Interaction acknowledged',
  );

  // Guards cover guild-only, permissions, cooldowns and the DJ role.
  const guardStartedAt = Date.now();
  try {
    const guard = await runGuards(client, command, interaction);
    if (!guard.allowed) {
      await rejectGuard(
        interaction,
        guard.message ?? 'You cannot use that right now.',
        commandLogger,
      );
      return;
    }
  } catch (error) {
    // A guard that *errors* (e.g. settings lookup with the DB down) must not
    // dead-end the interaction with silence.
    commandLogger.error({ err: error }, 'Guard evaluation failed');
    await replyWithError(
      interaction,
      'Something went wrong checking permissions. Try again.',
      commandLogger,
    );
    return;
  }
  const guardMs = Date.now() - guardStartedAt;

  try {
    await command.execute({ interaction, logger: commandLogger });
    commandLogger.info(
      { durationMs: Date.now() - startedAt, guardMs, receivedAgeMs },
      'Command executed',
    );
  } catch (error) {
    const appError = toAppError(error);

    // Expected failures (bad input, not found) are warnings, not incidents.
    const level = appError.expected ? 'warn' : 'error';
    commandLogger[level](
      {
        err: appError,
        durationMs: Date.now() - startedAt,
        guardMs,
        receivedAgeMs,
        acknowledged: interaction.deferred || interaction.replied,
      },
      'Command failed',
    );

    // replyWithError never throws: a dead interaction is logged and dropped
    // rather than retried into a second Unknown interaction.
    await replyWithError(
      interaction,
      isAppError(appError) && appError.expected
        ? appError.message
        : 'Something went wrong while running that command. Please try again.',
      commandLogger,
    );
  }
}
