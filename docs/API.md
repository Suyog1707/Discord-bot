# API

All endpoints live under `/api`, require a session cookie (Discord OAuth via
`/api/auth/*`), and return one envelope:

```json
{ "success": true,  "data": { } }
{ "success": false, "error": { "code": "NOT_FOUND", "message": "…" } }
```

Errors carry stable codes (`VALIDATION_FAILED`, `UNAUTHENTICATED`, `FORBIDDEN`,
`NOT_FOUND`, `CONFLICT`, `RATE_LIMITED`, `UPSTREAM_UNAVAILABLE`, `INTERNAL`).
Every route is rate-limited per user; 429 responses include `Retry-After`.

## Endpoints

| Method           | Path                                | Description                                                                                         |
| ---------------- | ----------------------------------- | --------------------------------------------------------------------------------------------------- |
| GET              | `/api/user`                         | Profile and playlist count                                                                          |
| GET              | `/api/server`                       | Manageable servers with bot presence                                                                |
| GET              | `/api/server/:guildId`              | Settings + persisted queue snapshot                                                                 |
| PATCH            | `/api/server/:guildId/settings`     | Update guild settings                                                                               |
| GET              | `/api/server/:guildId/analytics`    | 30-day listening analytics                                                                          |
| GET              | `/api/server/:guildId/events`       | Live player state (SSE stream)                                                                      |
| POST             | `/api/player/:guildId`              | Live control: `{action: pause\|resume\|skip\|stop\|shuffle}` or `{action: "volume", volume: 0-200}` |
| GET              | `/api/music/:guildId/history`       | Recent plays                                                                                        |
| GET/POST         | `/api/user/dislikes`                | List (paged) / add "not like" tracks                                                                |
| POST             | `/api/user/dislikes/remove`         | Un-reject many tracks at once                                                                       |
| DELETE           | `/api/user/dislikes/:trackKey`      | Un-reject one track (key URL-encoded)                                                               |
| GET/POST         | `/api/playlist`                     | List / create playlists                                                                             |
| GET/PATCH/DELETE | `/api/playlist/:id`                 | Read / rename+visibility / delete                                                                   |
| POST             | `/api/playlist/:id/tracks`          | Append a track                                                                                      |
| DELETE           | `/api/playlist/:id/tracks/:trackId` | Remove a track                                                                                      |
| GET/DELETE       | `/api/settings/sessions`            | List sessions / revoke all others                                                                   |
| DELETE           | `/api/settings/sessions/:id`        | Revoke one session                                                                                  |
| GET              | `/api/health`                       | Liveness + dependency status (no auth)                                                              |

Guild-scoped routes require the caller to have Manage Server on that guild
(verified against Discord) _and_ the bot to be present.

`POST /api/player/*` relays to the bot over Redis pub/sub; without Redis (or a
running bot) it returns `UPSTREAM_UNAVAILABLE`.

`/api/user/dislikes` is the listener's own preference, so it needs no Manage
Server. `POST` takes `{ title, author, isrc?, trackKey?, guildId?, skipIfPlaying? }`
and, when `guildId` is given, also relays a `dislike` command to that guild's
live player; `DELETE` accepts `?guildId=` to relay `undislike`. The relay is
best-effort — the stored row is the dislike, and autoplay honours it on its next
pass whether or not a player was listening.

`GET /api/user/dislikes` is paged: `?limit=` (1..100, default 50, clamped
rather than rejected) and `?cursor=` (the previous page's `nextCursor`). It
answers `{ items, nextCursor, total? }`, newest first; `nextCursor` is `null` on
the last page, and `total` is returned only when no cursor was sent — it exists
to show the distance to the cap, not to be recounted on every page. A cursor
whose row has since been deleted, or one belonging to somebody else, is treated
as stale: the first page comes back rather than an error.

`POST /api/user/dislikes/remove` takes `{ trackKeys: string[] (1..100),
guildId? }` and answers `{ removed }` — how many of the caller's own rows went
away. Keys that were never theirs, or already gone, count as nothing removed,
so a resubmitted purge is safe. With `guildId`, removals of ten keys or fewer
are relayed to the live player; a larger purge is not, because the planner
re-reads dislikes from the database on its next pass anyway.

A listener may hold at most 500 dislikes (`DISLIKES_MAX_PER_USER`). That cap is
deliberate — an abuse guard in the same spirit as the playlist and favourites
limits. Adds past it fail with a validation error; nothing is silently evicted,
and pagination plus bulk removal is how the list is kept under it.

`GET /api/server/:guildId/events` is a Server-Sent Events stream: every message
is a `data:` line holding one full `PlayerEvent` snapshot, plus a `: ping`
comment every 25s to keep intermediaries from closing an idle connection. On
connect the route subscribes first, then replays the snapshot the bot retains in
Redis (`dmp:player:state:<guildId>`, 6h TTL, deleted on disconnect), so a tab
opened mid-song — or reconnecting — shows the real state immediately instead of
waiting for the next event. Because every event is a complete snapshot, a
duplicate delivered in that window is harmless; nothing is sent when no state is
retained and the page keeps its server-rendered fallback.
