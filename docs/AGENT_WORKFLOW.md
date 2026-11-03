# Multi-agent workflow

How Claude Code sessions in this repo split work between models. Every
non-trivial task (a feature, a fix touching more than a couple of files, a
"check everything" pass) follows this hierarchy. Small one-file changes and
read-only questions are exempt: the orchestrator just does them.

## The rule in one line

**Sonnet writes all the code. The model selected with `/model` orchestrates,
manages and tests.**

## Which model runs which level

The hierarchy follows the model selected for the main session:

| Selected with `/model` | Orchestrator | Managers | Testers | Coders         |
| ---------------------- | ------------ | -------- | ------- | -------------- |
| Fable 5.1              | Fable        | Fable    | Fable   | **Sonnet 5.5** |
| Opus 5.5               | Opus         | Opus     | Opus    | **Sonnet 5.5** |

In practice: start managers and testers **without** a `model` override, so
they inherit the session's model. Start coders with **`model: "sonnet"`**,
always. If the session runs on any other model, the orchestrator says so and
still sends all coding to Sonnet.

## Hierarchy

```
Orchestrator            the selected model      (the main session)
  │
  ├── Manager agents    the selected model      (one per work area)
  │     │
  │     ├── Testing agents   the selected model (one per manager)
  │     │     │
  │     │     └── Coding agents   Sonnet 5.5    (one per change)
  │     │
  │     └── ...
  └── ...
```

| Level        | Model          | Agent tool `model` | Owns                                                                                                                                     | Never does                                 |
| ------------ | -------------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| Orchestrator | selected model | (main session)     | Diagnosis, the plan, splitting work into areas, final integration, deploy, the report to the user                                        | Write feature code                         |
| Manager      | selected model | omit (inherits)    | One area (e.g. "gateway routing", "Lavalink/SoundCloud"): breaks it into changes, sets acceptance criteria, reviews results              | Write code                                 |
| Testing      | selected model | omit (inherits)    | Writes the test plan and failing tests first, then verifies the coder's work: unit tests, typecheck, lint, and live checks when relevant | Write production code                      |
| Coding       | Sonnet 5.5     | `sonnet`           | Implements one scoped change until the testing agent's tests pass                                                                        | Change scope, deploy, touch infrastructure |

## Flow

1. **Orchestrator** investigates (logs, code, measurements) and writes the
   plan: the root cause, the work areas, and what "done" means for each.
2. Orchestrator starts **one manager per independent area, in parallel**.
   Areas that touch the same files go to the same manager, so agents never
   edit the same file concurrently. Use `isolation: "worktree"` when two
   managers might overlap.
3. Each **manager** hands its area to a **testing agent** with acceptance
   criteria.
4. The **testing agent** writes the tests first, then starts a **Sonnet coding
   agent** with:
   - the exact files and functions to change,
   - the tests that must pass,
   - the commands to run (`pnpm --filter <pkg> test`, `typecheck`, `lint`).
5. The coding agent implements and runs the tests. The testing agent verifies
   independently, and sends it back with the concrete failure until everything
   is green.
6. The manager reviews the diff against the acceptance criteria and reports
   to the orchestrator: what changed, which tests prove it, any open risks.
7. The **orchestrator** integrates, runs the full suite
   (`pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm test:system`), deploys
   only when the user says so, and reports to the user.

## Briefing rules (every level)

A sub-agent knows only what its prompt says. Every brief includes:

- **Goal** and **why** (the root cause or evidence, e.g. log lines).
- **Scope**: the files allowed to change, and what is out of scope.
- **Done means**: the specific tests and commands that must pass.
- **What has been ruled out already**, so it does not get re-investigated.
- **Constraints** (below).

Results come back as: what changed (files), test output, open questions.
Never "it should work". If something wasn't run, say so.

## Constraints every agent inherits

- **Git: everything happens on `main`.** No agent creates a branch unless the
  user explicitly asks for one. Commits go straight to `main`.
- **The VPS (`root@168.231.102.253`) is a company server.** Touch only the
  `discord-music` stack in `/root/Discord-bot` (containers named `dmp-*` and
  `discord-music-*`). Never change its Cloudflare tunnel, nginx, firewall,
  Tailscale or any other project's containers.
- Read-only commands on the VPS (logs, `docker ps`, `docker stats`) are fine.
  Restarts and redeploys happen only after the user approves them.
- Only the orchestrator commits, pushes or deploys, and only when asked.
- Follow `docs/CODING_STANDARDS.md` and `docs/TESTING.md`.

## Sizing

- Keep a run under about 10 agents unless the user asks for more.
- One manager per independent area. One coding agent per change; don't hand
  one coder two unrelated changes.
- If a level cannot start its own sub-agents (nested agent depth is limited),
  the level above runs that layer directly with the same models. For example,
  the orchestrator starts the testing agent and the Sonnet coder itself, and
  plays the manager role.
- A multi-agent `Workflow` script may be used for this hierarchy. The user has
  opted in to multi-agent orchestration for this repo.
