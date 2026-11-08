-- Players: full-timers ('ft') and drop-ins ('di').
CREATE TABLE players (
  id           INTEGER PRIMARY KEY,
  name         TEXT    NOT NULL,
  phone        TEXT,                                  -- E.164, e.g. +16135550123
  type         TEXT    NOT NULL CHECK (type IN ('ft','di')),
  is_admin     INTEGER NOT NULL DEFAULT 0,
  link_hash    TEXT    UNIQUE,                        -- SHA-256 of the personal link code
  texts_ok     INTEGER NOT NULL DEFAULT 1,
  opted_out_at INTEGER,
  active       INTEGER NOT NULL DEFAULT 1,
  created_at   INTEGER NOT NULL
);

-- A signed-in phone. Opening a personal link creates one; it lasts a year.
CREATE TABLE sessions (
  id_hash    TEXT    PRIMARY KEY,
  player_id  INTEGER NOT NULL REFERENCES players(id),
  created_at INTEGER NOT NULL,
  last_seen  INTEGER
);
CREATE INDEX sessions_player ON sessions(player_id);

-- One row per Sunday. date is the local date, YYYY-MM-DD.
CREATE TABLE games (
  id            INTEGER PRIMARY KEY,
  date          TEXT    NOT NULL UNIQUE,
  cap           INTEGER NOT NULL DEFAULT 15,
  priority_open INTEGER NOT NULL DEFAULT 1,           -- full-timers only, until Friday 6 PM
  locked        INTEGER NOT NULL DEFAULT 0,
  status        TEXT    NOT NULL DEFAULT 'open' CHECK (status IN ('open','cancelled')),
  finished_at   INTEGER,
  created_at    INTEGER NOT NULL
);

-- Scheduled steps already done for a game, so each runs exactly once.
CREATE TABLE game_steps (
  game_id INTEGER NOT NULL REFERENCES games(id),
  step    TEXT    NOT NULL,
  done_at INTEGER NOT NULL,
  PRIMARY KEY (game_id, step)
);

-- in / out for full-timers; requested for drop-ins. No row = no answer.
CREATE TABLE signups (
  game_id     INTEGER NOT NULL REFERENCES games(id),
  player_id   INTEGER NOT NULL REFERENCES players(id),
  answer      TEXT    NOT NULL CHECK (answer IN ('in','out','requested')),
  answered_at INTEGER NOT NULL,
  PRIMARY KEY (game_id, player_id)
);

-- Who actually played, written when a game ends. Feeds season stats.
CREATE TABLE attendance (
  game_id   INTEGER NOT NULL REFERENCES games(id),
  player_id INTEGER NOT NULL REFERENCES players(id),
  kind      TEXT    NOT NULL CHECK (kind IN ('ft','di')),
  PRIMARY KEY (game_id, player_id)
);

CREATE TABLE audit_log (
  id       INTEGER PRIMARY KEY,
  actor_id INTEGER REFERENCES players(id),
  action   TEXT    NOT NULL,
  detail   TEXT,
  at       INTEGER NOT NULL
);
