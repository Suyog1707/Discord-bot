# Music System

Lavalink + Shoukaku. The system is split into two layers that never do each
other's job.

## The two questions

Every request is resolved by asking two things, in order:

1. **What exact song is this?** — the **metadata layer**.
2. **Which playable upload most accurately IS that song?** — the **playback
   layer**.

Collapsing those into one question is what used to put movie scenes, trailers
and reaction videos into voice channels. A film scene is an excellent *search
result* for a soundtrack query; it is simply not the song. Separating identity
from playback is what makes that distinction expressible.

## Metadata layer — identify only

| Provider | Role | ISRC? |
| --- | --- | --- |
| Spotify | Primary catalogue. The only one that can answer with an album, artist or playlist. | Yes (API path) |
| Deezer | Second. Asked before Apple Music because it exposes ISRCs. | Yes |
| Apple Music | Third, via the keyless iTunes Search API. | No |

They produce a `CanonicalTrack` (`apps/bot/src/music/canonical-track.ts`):
title, primary artist, all artists, album, duration, ISRC, release date,
metadata provider, provider id and canonical URL.

None of them can stream audio — Spotify and Apple Music are DRM-protected, and
Deezer's LavaSrc source needs a decryption key this deployment does not have.
That is an upstream fact, not a limitation of this bot. The listener still sees
the catalogue's identity: title, artist, artwork and URL all stay the metadata
provider's, whichever provider ends up supplying the audio.

## Playback layer — stream only

Priority (configurable via `PLAYBACK_PROVIDER_ORDER`):

1. **SoundCloud** — primary.
2. **YouTube** — fallback, for coverage.
3. **HTTP / direct URLs** — unchanged; a URL bypasses resolution entirely.

SoundCloud goes first because its catalogue is *only music*. Everything in it
was published as audio, so its worst realistic wrong answer is a bootleg remix.
YouTube's index also contains the film the song is from, the trailer for that
film, and every reaction to both. Asking the quiet catalogue first means the
noisy one is only consulted for tracks the quiet one genuinely lacks — and it is
consulted under stricter rules when it is.

## Resolution flow

```
free text
   ↓
Spotify search ─── album/artist/playlist? → Spotify pipeline
   ↓ (no match)
Deezer → Apple Music
   ↓ (no match)
the query itself, at a reduced confidence threshold
   ↓
CanonicalTrack
   ↓
SoundCloud: multiple candidates → veto → score → rank
   ├── confident match → PLAY
   └── no acceptable match
        ↓
   YouTube: multiple candidates → veto → score → rank
        ├── confident match → PLAY
        └── no acceptable match → "No reliable playable version was found."
```

A URL (`https://…`) skips the whole diagram and goes straight to Lavalink. That
is what keeps YouTube links, SoundCloud links, Apple Music links (through
LavaSrc) and direct HTTP audio working exactly as before.

Nothing below the confidence threshold is ever played. A wrong song is a worse
outcome than an honest miss, and a much harder one for a listener to diagnose.

## How candidates are judged

`apps/bot/src/music/candidate-matcher.ts`, weights in `match-config.ts`.

Three mechanisms, in increasing order of how much they know:

1. **Vetoes** — shapes that are never a music release: livestreams, trailers,
   reactions, full movies, interviews, scenes, clips. Removed before scoring, so
   no combination of title and runtime can rehabilitate them. A candidate is
   exempt when the catalogue's own metadata contains the same word, so a track
   genuinely called "Love Scene" is never rejected for its own name.
2. **Scoring** — weighted evidence: ISRC (decisive; a conflict is a veto), title
   similarity, artist similarity, duration proximity, source attribution,
   version agreement, album.
3. **Structural rejection** — the case keyword lists cannot catch: a film
   excerpt with a clean title. Nothing in its text gives it away, so it is caught
   by the *combination* of weak signals — a clips-shaped uploader, a runtime
   outside tolerance, no attribution to the artist, a soft junk phrase. Any one
   is noise; three at once is not a song.

**Version handling.** An unrequested remix / live take / cover / sped-up edit is
penalised heavily. A version the *user typed* ("song x remix") is not: the
request joins the wanted set, the matching variant earns a bonus, and a
candidate lacking it takes the heavier `variantRequestedMissing` penalty —
weighted to overturn even a Topic upload of the original.

**Attribution.** "`<Artist>` - Topic" and VEVO are YouTube's own attribution
markers. On SoundCloud the uploader *is* the artist far more often, so that
signal carries more weight there. Label recognition is token-based and extensible
through `MATCH_OFFICIAL_CHANNELS` rather than a hard-coded roster of companies.

## Diagnosing a bad match

Every resolution emits a structured trace (`resolution` field). It reads:

```
[MusicResolver]
Track: Blinding Lights
Artist: The Weeknd
ISRC: USUM71900028
Duration: 200s (via spotify)

SoundCloud candidates: 8 (2 queries)
  rejected: nightcorezone — Blinding Lights (Sped Up) — duration: 150s vs 200s
  best: someuser — Blinding Lights
  score: 44 (…)
  decision: BELOW-THRESHOLD

YouTube candidates: 10 (1 queries)
  best: The Weeknd - Topic — Blinding Lights (Official Audio)
  score: 131 (+30 duration-exact +30 title-exact …)
  decision: PLAY

Decision: PLAY from youtube
```

Levels: a track that resolved on the primary provider logs at `debug` (a
thousand-track playlist must not narrate itself). Falling through to the fallback
provider, or failing outright, logs at `info` with the readable trace attached —
those are the two things anyone comes looking for.

## Configuration

See `.env.example` under **TRACK RESOLUTION**: `PLAYBACK_PROVIDER_ORDER`,
`MATCH_DURATION_TOLERANCE_MS`, `MATCH_SOUNDCLOUD_MIN_SCORE`,
`MATCH_YOUTUBE_MIN_SCORE`, `MATCH_OFFICIAL_CHANNELS`.

## Caching

Accepted resolutions are memoised by canonical identity — the ISRC alone where
one exists, so two catalogues describing the same master share one entry.
Rejected and low-confidence results are never cached: caching a bad match would
make it permanent, and re-running the search is cheap by comparison.
