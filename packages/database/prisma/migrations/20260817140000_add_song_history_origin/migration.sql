-- Where each play came from: a person ("user") or the recommender ("autoplay").
-- Backfills existing rows as "user" via the default, which is the conservative
-- reading — old rows carry at most the weight they always had.
ALTER TABLE "song_history" ADD COLUMN "origin" TEXT NOT NULL DEFAULT 'user';
