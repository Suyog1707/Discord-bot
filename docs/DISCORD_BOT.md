# Discord Bot

Slash commands, events, voice handling, queue, logging.

## Interaction delivery

With the Interactions Endpoint URL cleared (the recommended mode, see
`DEPLOYMENT.md`), slash commands arrive on the main bot's gateway. Main
acknowledges immediately, routes each command to the right bot's Redis queue
(its own included) and that bot's interaction subscriber runs it. Components
tagged for another bot are handed to that bot the same way. Without Redis, main
runs commands locally.
