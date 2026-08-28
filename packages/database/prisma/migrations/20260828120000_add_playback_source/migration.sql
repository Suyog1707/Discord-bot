-- Which provider actually supplied the audio, as distinct from the catalogue
-- that named the track.
--
-- The two used to be the same question because YouTube was the only playback
-- provider; SoundCloud-first resolution separated them. A row whose `source` is
-- SPOTIFY now says nothing about where its bytes came from, and two things need
-- to know:
--
--   * stream recovery, which switches to "the other provider" when a stream
--     dies, and cannot derive one from a metadata source;
--   * autoplay's mix fallback, which builds a YouTube radio URL out of
--     `identifier` — valid only when the audio really came from YouTube.
--
-- Nullable rather than defaulted: NULL means "unknown, predates the split",
-- which is exactly what `playbackSourceOf` already treats as the legacy case.
-- Backfilling every old row to YOUTUBE would be almost right and occasionally
-- wrong, and a wrong recorded provider is worse than an absent one.
ALTER TABLE "queue_tracks" ADD COLUMN "playbackSource" "music_source";
ALTER TABLE "song_history" ADD COLUMN "playbackSource" "music_source";
