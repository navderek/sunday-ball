-- Reminders now go out as text messages (SMS) instead of WhatsApp.
ALTER TABLE players RENAME COLUMN wa_opt_in_at TO text_opt_in_at;
UPDATE settings SET key = 'texts' WHERE key = 'whatsapp';
