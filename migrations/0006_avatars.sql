-- Profile pictures: initials (default), a built-in avatar (an emoji), or an uploaded photo.
ALTER TABLE players ADD COLUMN avatar_kind TEXT;      -- NULL = initials, 'emoji', 'photo'
ALTER TABLE players ADD COLUMN avatar_emoji TEXT;
ALTER TABLE players ADD COLUMN avatar_v INTEGER;      -- changes with each new photo, so phones re-fetch it

-- Photos live in their own table so the roster stays small; served from /api/avatar/<id>.
CREATE TABLE avatars (
  player_id  INTEGER PRIMARY KEY REFERENCES players(id),
  data       TEXT    NOT NULL,                        -- base64 JPEG, resized on the phone to 192x192
  updated_at INTEGER NOT NULL
);
