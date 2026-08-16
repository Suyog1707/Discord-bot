# Autoplay Smart Shuffle — Diagnosis and Rebuild

Status: diagnosis complete (Fable + Opus root-cause pass), implementation in progress.
Everything lands directly on `main`.

## Diagnosis — actual root causes found in the code

The repeated-song bug is not an AI-quality problem. It is a state problem: the
pipeline has anti-repeat *scoring*, but the data those scores key on is never
present, and there is no hard exclusion state at all.

### RC1 — Anti-repeat keys on `candidate.identifier`, which candidates never have
`scoring.ts` (novelty at 157, recencyPenalty at 178, skipPenalty at 189) all
require `candidate.identifier` to match `recent.identifiers` (YouTube video
ids). Last.fm candidates carry only `title` + `artist` — no identifier — so
`playedIndex` is always `-1`: a song the guild heard ten minutes ago scores as
fully novel with zero recency penalty. Only the artist penalty (max 0.25, soft)
ever fires. **This alone explains most repeats.**

### RC2 — Nothing excludes the queue, the current track, or the buffer
No layer receives the queue contents. `pickAutoplayTracks`
(music-manager.ts:780) passes only DB history; the recommender, the scorer and
the YouTube-mix fallback are all blind to what is currently playing, what is
already queued, and what the prefetch buffer has already handed out. All
protection is soft scoring — there is no hard exclusion anywhere.

### RC3 — Post-resolution identity is never checked against anything
Candidates are deduped pre-resolution, but two different Last.fm names resolve
to the *same* YouTube video. `#resolveAll` (recommender.ts:450) dedupes by
resolved identifier only *within its own batch* — never against history, the
queue, or previous batches.

### RC4 — The buffer regenerates with no memory of what it served
`AutoplayEngine` refills from the same seeds and near-identical context
(history only updates when tracks END), reproducing the same ranked list it
already served. A refill in flight while `take()` drains overwrites the buffer
wholesale (autoplay.ts:156) with tracks that may include the ones just served.
There is no reservation between "selected" and "queued".

### RC5 — The prefetch buffer almost never actually serves (seed-key mismatch)
`prefetch` on track start uses ONE seed (the current track,
music-manager.ts:366); `take` uses the top history entries. `seedKeyOf` hashes
the first two seeds, so the two call sites produce different keys and `#drain`
discards the prefetched buffer as "stale" nearly every time — autoplay then
generates synchronously on the playback path, defeating the prefetch design.

### RC6 — History write race at the exact moment autoplay runs
`recordHistory` is fire-and-forget (guild-player.ts:494) and `#tryAutoplay`
runs immediately after — `recentHistory()` often misses the just-finished
track, the single most likely song to be re-recommended.

### RC7 — Current-song similarity dominates candidate generation
For autoplay (`continuationIntent`: no mood/genre/language), the only candidate
sources are seed similar-tracks and seed similar-artists. The taste profile
shapes scoring but contributes zero candidates: no favourite-artist source, no
profile-tag source, no discovery source. The pool itself is an
artist-neighbourhood loop around whatever just played.

### RC8 — Inconsistent identity keys across stages
Candidate dedup uses `title.toLowerCase()` (recommender.ts:345); scoring uses
`normaliseTrackTitle`; resolution compares raw YouTube titles ("Song (Official
Video)") against Last.fm titles ("Song"). No single canonical identity exists,
and dash-suffix noise ("Song - Official Video") and remaster tags are not
normalised at all.

### RC9 — No session state, no fatigue, no sequencing, no learning
`selectDiverse` is static within one batch; across batches nothing remembers
per-artist counts. There is no session profile distinct from the long-term
profile, no artist/song/album fatigue, no sequence-level selection, no
recommendation-outcome tracking, and no metrics.

## Architecture of the fix

New per-guild session state (Redis, in-memory fallback), a canonical identity
layer used at every stage, hard exclusions before ranking AND after resolution,
atomic reservations, multi-source candidates, fatigue-driven sequence
selection, optional LLM reranking that can only reorder an already-filtered
list (structurally unable to resurrect an excluded song), and outcome metrics.

Pipeline: generate (multi-source) → canonical identity → dedupe → HARD
exclusions (playing/queued/reserved/recent/blocked) → deterministic scoring →
shortlist → tag enrichment → rescore → AI rerank (optional, validated) →
sequence-aware diverse selection → atomic reservation → bounded resolution →
post-resolution exclusion+dedupe → queue → outcome tracking.

Note: spec said MongoDB; this repo's store is PostgreSQL/Prisma (Supabase) —
long-term state lives there, fast session state in Redis, exactly as the spec
intends by "Redis fast / DB durable".

## Tasks

### Diagnosis
- [x] Inspect current autoplay end to end
- [x] Identify duplicate root causes (RC1–RC8)
- [x] Identify race conditions (RC4, RC6)
- [x] Identify queue/reservation gaps (RC2)
- [x] Opus root-cause pass
- [x] Reproduce repeated-song mechanism in tests (scoring suite pins the
      identifier-vs-key mismatch; probe reproduces the fixed behaviour live)

### Track identity
- [x] Canonical song identity (`identity.ts`)
- [x] Noise stripping (Official Video / dash suffixes / remaster)
- [x] Variant preservation (remix/live/acoustic stay distinct)
- [x] Provider-ID handling in exclusion sets

### State
- [x] Session store (`session.ts`): recently played / queued / reserved as
      SEPARATE states
- [x] Atomic reservations (Redis SET NX + memory fallback)
- [x] Artist fatigue (adaptive decay, not a fixed rule)
- [x] Song cooldown (hard exclusion window)
- [x] Album fatigue — decided against: NONE of the sources in this stack
      (Last.fm similar/top-tracks, Lavalink YouTube results, SongHistory)
      carries album metadata, so an album layer would run on guesses. Album
      runs are prevented indirectly: artist fatigue + tag saturation make four
      consecutive tracks from one record impossible in practice. Revisit if a
      source with real album data is added.
- [x] Redis-loss fallback (memory mirror; bot never breaks)

### Candidate generation
- [x] Multi-source: seed similarity, taste artists, profile tags, discovery
      (similar-of-favourites), history resurfacing after cooldown
- [x] Candidate dedup on canonical identity
- [x] Hard exclusion layer (pre-ranking AND post-resolution)

### Ranking
- [x] Long-term vs session taste separated, session weighted higher
- [x] Artist/song fatigue in scores
- [x] Sequence-aware selection (simulated session state during picking)
- [x] Tag-continuity (energy/mood proxy) with transition penalty
- [x] Controlled discovery slots

### AI
- [x] LLM reranking over the filtered shortlist (indices only)
- [x] Strict output validation (in-range, deduped, structural)
- [x] Deterministic fallback on any AI failure
- [x] No AI on the playback path (background prefetch only)

### Performance
- [x] Fix prefetch (unified seed derivation so the buffer actually serves)
- [x] Reservation-safe refill (no overwrite races)
- [x] Stage timings preserved and extended

### Observability & UX
- [x] Structured events (AUTOPLAY_RECOMMENDATION_STARTED … RECOMMENDATION_SKIPPED)
- [x] Metrics (duplicate_recommendation_rate, artist repetition, skip/completion)
- [x] Friendly user-facing failure messages, technical detail in logs only

### Testing
- [x] Duplicate protection (same song, normalized variants, provider IDs)
- [x] Queue conflicts (playing / queued / reserved / recent)
- [x] Concurrency (parallel reservation, parallel refills)
- [x] Artist diversity + fatigue
- [x] Session adaptation (session ≠ long-term)
- [x] AI failure (timeout, invalid output, excluded-song attempts)
- [x] Redis failure fallback
- [x] Sequence/manual simulation — live probe (real Last.fm + Groq, simulated
      playback, production pipeline): seeded the spec's exact pattern (Weeknd,
      Drake, Brent Faiyaz, Weeknd, Dua Lipa, Travis Scott), ran 20 autoplay
      transitions → 0 duplicate songs, 0 re-recommendations of played tracks,
      0 adjacent same-artist plays, 20/20 distinct artists, concurrent takes
      fully disjoint, picks squarely in the taste neighbourhood (Miguel,
      Daniel Caesar, Bryson Tiller, PARTYNEXTDOOR, Sonder, Chris Brown).
      Lavalink resolution was simulated (no node in the dev environment) —
      everything upstream of the YouTube search was the production code path.

### Final review
- [x] Full lint/typecheck/test/build
- [x] Final Opus review — adversarial pass found 3 blockers + 4 claim-breaking
      gaps in the first integration; all fixed, re-verified by a second Opus
      pass (B1 FIXED, B2 FIXED, B3's two gating follow-ups fixed in the same
      pass). Accepted residuals, documented deliberately:
      * `sourceKey` (the Last.fm↔YouTube key bridge) is not persisted by the
        queue store, so a queue restored after a restart is un-bridged until
        tracks play — adding it needs a Prisma column/migration, deferred.
      * a bracket group that merely contains "with" ("(With Love)") is
        stripped as a feature credit — low-probability over-merge, safe
        direction for anti-repeat.
      * mix-fallback picks are not reserved (fallback only runs when the
        recommender returned nothing, so there is no concurrent pass to race).
- [x] Verify main branch only, no secrets (single local branch `main`; 0 secret
      patterns in the diff; `.env` untracked)
