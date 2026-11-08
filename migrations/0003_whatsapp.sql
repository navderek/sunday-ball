-- WhatsApp messages through Twilio.
-- A player gets WhatsApp messages only after they opt in themselves (sending JOIN or
-- START, or turning it on in the app), and stop when they send STOP or turn it off.
ALTER TABLE players ADD COLUMN wa_opt_in_at INTEGER;
-- (players.opted_out_at already exists and is reused for WhatsApp opt-outs.)

-- Every message sent. dedupe_key makes scheduled messages go out at most once
-- (e.g. "12:5:week_open"); one-off messages leave it empty.
CREATE TABLE messages (
  id         INTEGER PRIMARY KEY,
  game_id    INTEGER REFERENCES games(id),
  player_id  INTEGER REFERENCES players(id),
  kind       TEXT    NOT NULL,
  dedupe_key TEXT    UNIQUE,
  twilio_sid TEXT,
  status     TEXT    NOT NULL DEFAULT 'queued',   -- queued, sent, delivered, read, failed, undelivered
  error      TEXT,
  sent_at    INTEGER NOT NULL,
  updated_at INTEGER
);
CREATE INDEX messages_sid ON messages(twilio_sid);
