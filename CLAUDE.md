# Sunday Ball

Weekly sign-up app for a Sunday night pickup basketball group. A Cloudflare Worker (`src/`) with a D1 database (`migrations/`) and a static front end (`public/`). See README.md for how it works and how to deploy your own copy.

## Rules for working on this project

- **Keep the admin guide current.** The in-app guide (`guide()` in `public/app.js`, admin-only, route `#guide`) must match what the app actually does. Whenever an admin-facing feature is added, changed or removed, update the guide in the same change, bump `GUIDE_UPDATED`, and move items out of "Coming soon" once they ship.
- **Players' phone numbers are private.** Only the player sees their own number. Never return another player's number from the API, not even to admins (admins only learn yes/no flags); the one exception is `/api/admin/wa-link`, which hands an opted-in player's number to WhatsApp at tap time. `test/privacy.test.js` guards this.
- **Never overwrite live links.** `.seed/links.txt` holds real players' sign-in links for a live deployment. Local test seeds write to `.seed/links.local.txt`. Don't print link codes in chat or logs.
- **The code names no group.** The group's name, wordmark and logo letters come from `GROUP_NAME`, `WORDMARK` and `LOGO_TEXT` in `wrangler.toml` `[vars]` (`src/brand.js`); a deployment's own icons are served from the `images` table (`scripts/icons.mjs`). Never hard-code a group's name, city or gym in code, comments, docs or tests.
- **Real data stays out of git.** `roster.csv`, `.seed/`, `wrangler.toml` (your deployment's IDs), `.dev.vars` and `private/` are gitignored. Secrets (Twilio keys and number) live in Cloudflare secrets only.
- Deploy only with `npm run deploy`: it runs the tests, applies any new `migrations/NNNN_*.sql` to the live database, and only then deploys the code. Never deploy code that needs a migration before confirming the migration applied (`npx wrangler d1 migrations list DB --remote` should list nothing pending).
- Times are the group's local time via `TZ` in `src/time.js` (`America/Toronto`); don't hard-code offsets.
