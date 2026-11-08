-- Players can let admins open a WhatsApp chat with them straight from the app
-- (Nudge, Send in WhatsApp). Off unless the player turns it on.
-- wa_phone: optional WhatsApp number if different from their texting number.
ALTER TABLE players ADD COLUMN wa_dm_ok INTEGER NOT NULL DEFAULT 0;
ALTER TABLE players ADD COLUMN wa_phone TEXT;
