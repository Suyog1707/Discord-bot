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
