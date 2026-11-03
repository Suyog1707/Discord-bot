# Playback quality

Set `PLAYBACK_PROVIDER_ORDER=youtube,soundcloud` in the VPS's private `.env`.
Existing explicit settings override the new default. Recreate bot containers
after changing environment variables; a restart alone does not replace them.

The resolver prefers lyrics/audio recordings, matches artist and duration,
rejects cutscenes and opening/ending sequences, and rejects unrequested
sped-up/slowed variants. Explicit media URLs deliberately preserve the selected
upload. Matching cannot inspect the audio or guarantee every upload is clean.

Lavalink buffers 10 seconds of decoded audio, uses a 1-second NAS buffer and
Opus quality 8 to reduce CPU pressure. These settings mitigate short stalls;
they cannot fix persistent upstream throttling, packet loss or an overloaded VPS.

If speed is wrong, check `/filter` and turn off nightcore/vaporwave/speed effects.
If a recording is quiet, first check the Discord user's local bot volume and
the bot's `/volume` setting. No automatic loudness normalization is implemented:
raising every recording's gain would clip already-loud songs.

For persistent pauses capture `docker stats --no-stream` and recent Lavalink
and affected player logs during playback, plus the selected song URL. Do not
include OAuth tokens or `.env` contents. Live listening and multiple concurrent
players on the VPS are required to confirm playback stability.

## SoundCloud lookups fail: "Did not detect any supported formats"

**Symptom.** Lavalink logs `FriendlyException: Something went wrong while
looking up the track. Caused by: java.lang.RuntimeException: Did not detect any
supported formats` for every `scsearch:` query, the bot's resolver logs
`fromSoundcloud: 0` on every resolution, and each Spotify playlist track pays
roughly 1.8-2.2 s for the doomed SoundCloud search.

**Cause.** Lavalink's SoundCloud source cannot find a supported stream format
for current SoundCloud tracks, so searches never yield a playable result.

**Fix.** `SOUNDCLOUD_ENABLED` defaults to `false`: the bot never sends a
`scsearch:` query and never waits on one, and YouTube resolution is unchanged.
Only set it to `true` after confirming `scsearch` works again (for example after
a Lavalink/lavaplayer update). `/play source:SoundCloud` with a text query is
refused with a message while it is off.

Direct SoundCloud links are still handed to Lavalink unchanged; if one fails
while SoundCloud is disabled, the user gets a clear message suggesting a YouTube
or Spotify link instead.

## Playback freezes, then plays fast to catch up

**Symptom.** Audio stalls for 1-2 s, then runs at roughly double speed until it
has caught up.

**Reading the log.** Lavalink reports frame counters about once a minute per
session, and the bot logs them under the `audio-health` module. A minute with
lost frames logs `Lavalink audio frames dropped` at `warn`; healthy minutes log
at `debug`. Ideal is 3000 `sent` frames per playing player per minute.

- `deficit > 0`: frames were neither sent nor nulled, so Lavalink's 20 ms audio
  sender fell behind (host CPU steal or a long GC pause). This is the freeze
  and burst. Check `lossPct`, `lavalinkLoad` and `systemLoad`.
- `nulled > 0`: the source had no audio ready, so the track's stream stalled.

**Cause and fix.** Sustained deficits alongside a high `st` column in `vmstat 1`
mean the VPS's shared CPU is being taken by the hypervisor; the real fix is
dedicated vCPUs. The compose file runs Lavalink with ZGC to remove GC pauses as
a contributing cause.
