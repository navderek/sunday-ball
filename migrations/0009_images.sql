-- Group pictures admins upload (for now, the gym photo under key 'venue').
CREATE TABLE images (
  key        TEXT    PRIMARY KEY,
  data       TEXT    NOT NULL,     -- base64 JPEG, resized on the phone
  updated_at INTEGER NOT NULL
);
