-- Players manage their own mobile numbers, which only they can see in the app.
-- phone_verified_at: when a text came in from that number (JOIN, IN, OUT...),
-- proving the phone is theirs. Changing the number clears it.
-- intro_seen_at: the first-login welcome (offering to add a number) was shown.
ALTER TABLE players ADD COLUMN phone_verified_at INTEGER;
ALTER TABLE players ADD COLUMN intro_seen_at INTEGER;
UPDATE players SET phone_verified_at = text_opt_in_at WHERE text_opt_in_at IS NOT NULL AND phone IS NOT NULL;
