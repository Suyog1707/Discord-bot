# Environment Variables

See .env.example for all required variables.

## Track resolution

| Variable                  | Default              | Purpose                                                                                                                                                                                                                   |
| ------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PLAYBACK_PROVIDER_ORDER` | `youtube,soundcloud` | Provider priority. A `soundcloud` entry is ignored unless `SOUNDCLOUD_ENABLED=true`.                                                                                                                                      |
| `SOUNDCLOUD_ENABLED`      | `false`              | Allow the bot to search SoundCloud. Off because every `scsearch:` lookup failed in production with "Did not detect any supported formats". Direct SoundCloud links still go to Lavalink. See PLAYBACK_TROUBLESHOOTING.md. |
