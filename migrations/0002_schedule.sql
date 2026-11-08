-- Adjustable schedule: games can be on any weekday, at any time, moved or skipped.
-- week_of: the Monday of the week a game belongs to. It anchors each weekly slot,
-- so moving a game to another day doesn't make the generator create a second one.
ALTER TABLE games ADD COLUMN week_of TEXT;
ALTER TABLE games ADD COLUMN start_time TEXT;          -- local 'HH:MM'
ALTER TABLE games ADD COLUMN end_time TEXT;            -- local 'HH:MM'
ALTER TABLE games ADD COLUMN opens_at INTEGER;         -- UTC ms for each step
ALTER TABLE games ADD COLUMN reminder_at INTEGER;
ALTER TABLE games ADD COLUMN priority_ends_at INTEGER;
ALTER TABLE games ADD COLUMN locks_at INTEGER;
ALTER TABLE games ADD COLUMN starts_at INTEGER;
ALTER TABLE games ADD COLUMN ends_at INTEGER;
ALTER TABLE games ADD COLUMN custom INTEGER NOT NULL DEFAULT 0;   -- an admin changed this game's day or time
ALTER TABLE games ADD COLUMN note TEXT;                           -- e.g. "Christmas" on a skipped date

UPDATE games SET week_of = date(date, '-6 days', 'weekday 1');
CREATE UNIQUE INDEX games_week_of ON games(week_of);

-- Group-wide settings, stored as JSON values (key 'schedule' holds the default week).
CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
