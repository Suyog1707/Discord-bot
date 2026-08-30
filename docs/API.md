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
| POST             | `/api/player/:guildId`              | Live control: `{action: pause\|resume\|skip\|stop\|shuffle}` or `{action: "volume", volume: 0-200}` |
| GET              | `/api/music/:guildId/history`       | Recent plays                                                                                        |
| GET/POST         | `/api/user/dislikes`                | List / add "not like" tracks                                                                        |
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
