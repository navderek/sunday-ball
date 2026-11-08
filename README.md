# Sunday Ball

A small web app that runs the weekly sign-up for a pickup basketball group: about 13 full-timers who get first dibs, a list of drop-ins who fill any open spots, and a cap of 15 players. It replaces the weekly "who's in?" vote in a WhatsApp group.

It's built for phones and runs entirely on Cloudflare's free tier (Workers + D1), with optional text-message reminders through Twilio.

## What it does

**For players**
- **One-tap sign-in:** each player gets a personal link. Opening it signs that phone in, and it stays signed in as long as the app gets used at least once a year. There are no passwords or accounts.
- **In or out:** full-timers answer *I'm in* or *I'm out* each week. Drop-ins add their name and get placed in sign-up order once spots open up.
- **This week at a glance:** the 15-spot grid, who's playing, the waitlist, who hasn't answered, the gym's address and directions, and a link to add the game to Google, Outlook or Apple Calendar (or subscribe to every game).
- **Text reminders (optional):** a text when sign-ups open, a reminder for anyone who hasn't answered, and a heads-up when a drop-in moves up or gets bumped. Players reply **IN**, **OUT** or **SPOT**. Texting **JOIN** opts them in and sends back their personal link.
- **Profiles:** players set their own name, a built-in avatar or a photo, and their own mobile number. Numbers are private: admins never see them, and the app only ever shows the last four digits.
- **Phone-friendly:** add-to-home-screen, light and dark mode, and a short tip-off intro animation when the app opens.

**For admins**
- **Full-timer priority:** on by default every week, until an admin turns it off and lets drop-ins in.
- **Schedule:** a default weekly day, time and sign-up window, with individual dates moved, re-timed or skipped for holidays.
- **Roster:** add players, switch full-timer ↔ drop-in, make admins, set anyone's answer, and send personal links over WhatsApp in one tap.
- **Drop-in fees:** each drop-in who plays is charged automatically ($12 by default), with a running total owed and one-tap "mark paid".
- **Announcements and gym info:** a notice at the top of the app, plus the gym's address, how to get in, a photo and a map.
- **Admin guide:** a built-in guide for admins explains everything, step by step.

## How it works

| Part | What it is |
|---|---|
| `src/worker.js` | The Cloudflare Worker: API, sign-in, admin actions, the weekly schedule, calendar feed |
| `src/sms.js` | Twilio texts and the incoming-text webhook (signature-checked) |
| `src/roster.js` | The rules for who plays: full-timers first, then drop-ins in order, then the waitlist |
| `src/brand.js` | The group's name and logo, set per deployment (see [Making it yours](#making-it-yours)) |
| `src/time.js` | The group's local time (`TZ`, daylight saving handled) and the default schedule |
| `migrations/` | The D1 database schema, applied in order |
| `public/` | The front end: plain HTML, CSS and JavaScript, with no build step |
| `test/` | Tests run with Node's built-in test runner, against a real SQLite database |

A job runs every 15 minutes to plan the next 10 weeks of games, lock the list before tip-off, record who played, charge drop-ins and send scheduled texts. Each step runs exactly once per game.

## Run your own copy

You'll need [Node.js](https://nodejs.org/) 22.13 or newer and a free [Cloudflare](https://dash.cloudflare.com/sign-up) account.

**1. Install and sign in to Cloudflare**

```bash
npm install
npx wrangler login
```

**2. Create the database and your config**

```bash
npx wrangler d1 create sunday-ball
cp wrangler.example.toml wrangler.toml
```

In `wrangler.toml`, paste the `database_id` that the first command printed. Set `APP_URL` to the address your app will have, which is shown after the first deploy (for example `https://sunday-ball.your-subdomain.workers.dev`).

**3. Deploy**

```bash
npm run deploy
```

This runs the tests, applies the database migrations, then deploys the app.

**4. Load your roster**

Copy `roster.sample.csv` to `roster.csv` and fill in your players (`name,phone,type,admin`, where `type` is `ft` or `di` and `admin` is `yes` for admins). Then:

```bash
node scripts/seed.mjs roster.csv --base https://YOUR-APP-ADDRESS
npx wrangler d1 execute DB --remote --file .seed/seed.sql
```

Everyone's personal sign-in link is written to `.seed/links.txt`. Keep that file private. Open an admin's link to start, then add or edit players from the app. Numbers in the roster file are optional: players can add their own.

**5. Text messages (optional)**

With a [Twilio](https://www.twilio.com/) account and an SMS-capable phone number:

```bash
npx wrangler secret put TWILIO_ACCOUNT_SID
npx wrangler secret put TWILIO_AUTH_TOKEN
npx wrangler secret put TWILIO_SMS_FROM
```

`TWILIO_SMS_FROM` is the number in international format, for example `+16135550123`. Then, in Twilio, set the number's **A message comes in** webhook to `https://YOUR-APP-ADDRESS/hooks/twilio` (HTTP POST). Turn texts on from the app's Admin screen and send yourself a test.

Phones often file texts from a new number as spam, so ask players to save the number as a contact. In some countries, sending texts from an unregistered number is restricted. Check Twilio's rules for yours.

## Local development

```bash
npm run db:migrate:local
npm run seed:demo      # sample roster and 8 weeks of history; links go to .seed/links.local.txt
npm run dev            # http://localhost:8787
npm test
```

## Making it yours

- **Name and logo:** set `GROUP_NAME`, `WORDMARK` and `LOGO_TEXT` under `[vars]` in `wrangler.toml` (examples in `wrangler.example.toml`). The name goes into texts, calendar events and the page title; the wordmark is the two-line logo at the top of the app; the letters appear in the tip-off intro. No code changes needed.
- **Home-screen icons:** the defaults are in `public/`. To use your own without changing those files, put PNGs with the same names in a folder, then run `node scripts/icons.mjs <folder>` and `npx wrangler d1 execute DB --remote --file .seed/icons.sql`.
- **Colours and type:** set in `public/styles.css`. Court orange is for full-timers, blue for drop-ins.
- **Time zone:** `TZ` in `src/time.js`.
- **Default schedule:** `DEFAULT_SCHEDULE` in `src/time.js`. Admins can change it in the app anyway.
- **Gym:** set from the Admin screen. Nothing about the venue is built into the code.

## Privacy and security

- Personal links and sessions are stored only as SHA-256 hashes. Sign-in cookies are `HttpOnly`, `Secure` and `SameSite=Lax`.
- Players' phone numbers never leave the server, except the last four digits shown to the player and a WhatsApp link handed to an admin, for players who opted in to that. `test/privacy.test.js` guards this.
- Incoming Twilio requests are checked against Twilio's signature before anything happens.
- The public calendar feed contains only game times and the gym's address.

If you find a security problem, please open an issue without the details, or contact the maintainer privately.

## License

[MIT](LICENSE)
