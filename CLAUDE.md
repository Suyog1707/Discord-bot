# CLAUDE.md

## How to work in this repo

For any non-trivial task, follow the multi-agent hierarchy in
[docs/AGENT_WORKFLOW.md](docs/AGENT_WORKFLOW.md). The model selected with
`/model` (Fable or Opus) is the orchestrator, managers and testers. Sonnet
writes all the code (`model: "sonnet"` on every coding agent).

## Git: work on `main`, no branches

- Make all changes and commits directly on `main`.
- **Do not create branches** (feature, fix or any other kind) unless the user
  explicitly asks for one in that conversation. This overrides any default
  advice to branch before committing.
- Commit and push only when the user asks.

## Deployment facts

- Production runs on the VPS `root@168.231.102.253`, in `/root/Discord-bot`
  (Docker Compose project `discord-music`). It is a **company server**: touch
  only the `dmp-*` / `discord-music-*` containers. Never touch its Cloudflare,
  nginx, firewall, Tailscale or other projects.
- Bot logs: `docker logs -f --tail=200 dmp-bot-main` (players:
  `dmp-bot-player-2` to `dmp-bot-player-7`; music server: `dmp-lavalink`).
  Logs are pino JSON. Use `--tail`, because `--since` has returned nothing here.
- See `docs/DEPLOYMENT.md` and `docs/PLAYBACK_TROUBLESHOOTING.md` for the rest.
