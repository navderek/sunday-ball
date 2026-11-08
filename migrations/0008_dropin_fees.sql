-- Drop-in fees: one charge per drop-in per game they played, written when the game
-- ends at the fee in effect then. Admins mark charges paid; unpaid ones add up
-- to the player's running total owed.
CREATE TABLE dropin_charges (
  game_id      INTEGER NOT NULL REFERENCES games(id),
  player_id    INTEGER NOT NULL REFERENCES players(id),
  amount_cents INTEGER NOT NULL,
  created_at   INTEGER NOT NULL,
  paid_at      INTEGER,
  paid_by      INTEGER REFERENCES players(id),
  PRIMARY KEY (game_id, player_id)
);
CREATE INDEX dropin_charges_unpaid ON dropin_charges(player_id) WHERE paid_at IS NULL;
