import { computeTimes, seasonStart, localDate, addDays, mondayOf, dateInWeek, dayName, scheduleError, DEFAULT_SCHEDULE, STEP_LABELS } from "./time.js";
import { computeRoster } from "./roster.js";
import { HttpError, fail, sha256, randomCode, normalizePhone, all, first, run, audit, setAnswer, newLink } from "./db.js";
import { brand, customBrand, brandPage, escapeHtml as esc, ICON_FILES } from "./brand.js";
import { textConfig, textSettings, setTextSettings, optedIn, sendText, rosterFor, notifyRosterChange, notifyGameChange, scheduledMessages, handleTwilioHook, KINDS } from "./sms.js";

// Scheduled messages are only sent close to their time, so a late catch-up
// (say, after downtime) never sends a burst of stale reminders.
const FRESH = 6 * 3600_000;

// Group-wide settings kept as JSON in the settings table.
export const SETTING_DEFAULTS = {
  fees: { dropin_cents: 1200 },
  // Admins fill in the gym on the Admin screen. Photos: "uploaded" (images table) or "none".
  venue: { name: "", address: "", notes: "", photo: "none", photo_v: null, map: "none", map_v: null },
  announcement: null,
};
export async function getSetting(env, key) {
  const row = await first(env, "SELECT value FROM settings WHERE key = ?", key);
  const d = SETTING_DEFAULTS[key];
  if (!row) return d && typeof d === "object" ? structuredClone(d) : d;
  try { const v = JSON.parse(row.value); return d && v && typeof d === "object" ? { ...d, ...v } : v; } catch { return d; }
}
const setSetting = (env, key, value) =>
  run(env, "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", key, JSON.stringify(value));
// Uploaded pictures are served with headers that stop a browser treating them as anything but an image.
const IMAGE_HEADERS = type => ({ "content-type": type, "cache-control": "private, max-age=31536000, immutable",
  "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; sandbox" });
const validImage = (data, maxB64) => {
  const m = String(data || "").match(/^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/);
  if (!m || m[2].length > maxB64) return false;
  try { atob(m[2]); return true; } catch { return false; }
};
const money = c => `$${(c / 100).toFixed(c % 100 ? 2 : 0)}`;

// Built-in avatars players can pick (shared with the app's picker via /api/state).
export const AVATAR_EMOJI = ["🏀", "⛹️", "🔥", "⚡", "🦅", "🐺", "🦁", "🐻", "🦈", "🐉", "👑", "🎯", "🚀", "💪", "😎", "🧢", "🍁", "🌊"];

// Sign-ins last 400 days (the longest browsers allow) and are renewed on every visit,
// so anyone who opens the app at least once a year stays signed in for good.
const SIGN_IN_MAX_AGE = 400 * 24 * 3600;
const signInCookie = sid => `${COOKIE}=${sid}; Path=/; Max-Age=${SIGN_IN_MAX_AGE}; HttpOnly; Secure; SameSite=Lax`;
const COOKIE = "sb_session";

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...headers } });

function cookie(req, name) {
  const m = (req.headers.get("cookie") || "").match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return m ? m[1] : null;
}
// ---------- schedule settings ----------
export async function getSchedule(env) {
  const row = await first(env, "SELECT value FROM settings WHERE key = 'schedule'");
  if (!row) return structuredClone(DEFAULT_SCHEDULE);
  try { return { ...structuredClone(DEFAULT_SCHEDULE), ...JSON.parse(row.value) }; }
  catch { return structuredClone(DEFAULT_SCHEDULE); }
}

const timeCols = t => [t.open, t.reminder, t.priorityEnd, t.lock, t.start, t.end];
const SET_TIMES = "opens_at = ?, reminder_at = ?, priority_ends_at = ?, locks_at = ?, starts_at = ?, ends_at = ?";
const WEEKS_AHEAD = 10;

// ---------- weekly lifecycle ----------
// Keeps the next 10 weeks of games planned from the default schedule, and runs
// each game's steps (priority ends, list locks, game ends) exactly once. Called
// by the cron job and on every page load, so nothing depends on the cron firing on time.
export async function tick(env, now = Date.now()) {
  const s = await getSchedule(env);

  // Games from before the schedule was adjustable have no times yet.
  for (const g of await all(env, "SELECT id, date FROM games WHERE starts_at IS NULL")) {
    const t = computeTimes(g.date, s.start, s.end, s);
    await run(env, `UPDATE games SET start_time = ?, end_time = ?, week_of = COALESCE(week_of, ?), ${SET_TIMES} WHERE id = ?`,
      s.start, s.end, mondayOf(g.date), ...timeCols(t), g.id);
  }

  // Plan ahead. week_of is unique, so a week that already has a game (moved or not) is left alone.
  const today = localDate(now);
  const stmts = [];
  for (let k = 0; k < WEEKS_AHEAD; k++) {
    const monday = mondayOf(addDays(today, 7 * k));
    const date = dateInWeek(monday, s.weekday);
    const t = computeTimes(date, s.start, s.end, s);
    if (t.end <= now) continue;
    stmts.push(env.DB.prepare(
      `INSERT OR IGNORE INTO games (week_of, date, cap, start_time, end_time, opens_at, reminder_at, priority_ends_at, locks_at, starts_at, ends_at, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).bind(monday, date, s.cap, s.start, s.end, ...timeCols(t), now));
  }
  if (stmts.length) await env.DB.batch(stmts);

  const pending = await all(env, "SELECT * FROM games WHERE finished_at IS NULL AND starts_at IS NOT NULL");
  for (const g of pending) await advance(env, g, now);
}

const STEPS = g => [
  ["lock", g.locks_at, "UPDATE games SET locked = 1 WHERE id = ?", "UPDATE games SET locked = 0 WHERE id = ?"],
];

async function advance(env, game, now) {
  for (const [step, at, sql] of STEPS(game)) {
    if (now < at) continue;
    const r = await run(env, "INSERT OR IGNORE INTO game_steps (game_id, step, done_at) VALUES (?,?,?)", game.id, step, now);
    if (r.meta.changes === 1) await run(env, sql, game.id);
  }
  // Full-timer priority never ends on its own: it stays on until an admin turns it off.
  // Texts: week opens (full-timers), reminder (no-replies). "Spots open" goes to
  // drop-ins when an admin turns priority off.
  for (const [step, at] of [["msg_open", game.opens_at], ["msg_reminder", game.reminder_at]]) {
    if (now < at) continue;
    const r = await run(env, "INSERT OR IGNORE INTO game_steps (game_id, step, done_at) VALUES (?,?,?)", game.id, step, now);
    if (r.meta.changes === 1 && now - at < FRESH) await scheduledMessages(env, game.id, step, now);
  }
  if (now >= game.ends_at) {
    const r = await run(env, "INSERT OR IGNORE INTO game_steps (game_id, step, done_at) VALUES (?,?,?)", game.id, "finish", now);
    if (r.meta.changes === 1) await finishGame(env, game.id, now);
  }
}

/** After a game's times change, undo steps that are now in the future again. */
async function rewindSteps(env, game, now) {
  for (const [step, at, , undo] of STEPS(game)) {
    if (now >= at) continue;
    const r = await run(env, "DELETE FROM game_steps WHERE game_id = ? AND step = ?", game.id, step);
    if (r.meta.changes) await run(env, undo, game.id);
  }
}

async function finishGame(env, gameId, now) {
  const game = await first(env, "SELECT * FROM games WHERE id = ?", gameId);
  if (game.status === "open") {
    const players = await all(env, "SELECT id, type, active FROM players");
    const signups = await all(env, "SELECT * FROM signups WHERE game_id = ?", gameId);
    const r = computeRoster(game, players, signups);
    const stmts = [
      ...r.ftPlay.map(id => env.DB.prepare("INSERT OR IGNORE INTO attendance VALUES (?,?, 'ft')").bind(gameId, id)),
      ...r.diPlay.map(id => env.DB.prepare("INSERT OR IGNORE INTO attendance VALUES (?,?, 'di')").bind(gameId, id)),
    ];
    // Each drop-in who played owes the drop-in fee for this game.
    const fee = (await getSetting(env, "fees")).dropin_cents;
    if (fee > 0) stmts.push(...r.diPlay.map(id =>
      env.DB.prepare("INSERT OR IGNORE INTO dropin_charges (game_id, player_id, amount_cents, created_at) VALUES (?,?,?,?)").bind(gameId, id, fee, now)));
    if (stmts.length) await env.DB.batch(stmts);
  }
  await run(env, "UPDATE games SET finished_at = ? WHERE id = ?", now, gameId);
}

// Only the last four digits ever leave the server, even to the number's owner: anyone
// holding a player's sign-in link (an admin can make one) would otherwise see it.
const last4 = phone => (phone ? String(phone).replace(/\D/g, "").slice(-4) : null);

const withPhotoUrl = v => ({
  ...v,
  photo_url: v.photo === "uploaded" && v.photo_v ? `/api/venue-photo?v=${v.photo_v}` : null,
  map_url: v.map === "uploaded" && v.map_v ? `/api/venue-photo?slot=map&v=${v.map_v}` : null,
});

const activeAnnouncement = (a, now) => a && a.text && (!a.until || now < a.until) ? { text: a.text, by: a.by, at: a.at } : null;

const timesOf = g => g && ({ open: g.opens_at, reminder: g.reminder_at, priorityEnd: g.priority_ends_at, lock: g.locks_at, start: g.starts_at, end: g.ends_at });

// ---------- state for the app ----------
async function buildState(env, me, now = Date.now()) {
  await tick(env, now);
  const schedule = await getSchedule(env);
  // The current game is the next one that hasn't finished, even if its sign-ups aren't open yet.
  const upcoming = await all(env,
    `SELECT id, date, start_time, end_time, status, note, custom, cap, opens_at, starts_at, ends_at
     FROM games WHERE finished_at IS NULL ORDER BY starts_at LIMIT ?`, WEEKS_AHEAD);
  const game = upcoming.length ? await first(env, "SELECT * FROM games WHERE id = ?", upcoming[0].id) : null;
  const open = !!game && now >= game.opens_at;

  const players = await all(env,
    me.is_admin
      ? `SELECT p.id, p.name, p.type, p.is_admin, p.active, p.avatar_kind, p.avatar_emoji, p.avatar_v, p.phone IS NOT NULL AS has_phone, p.text_opt_in_at, p.opted_out_at,
           (p.wa_dm_ok = 1 AND COALESCE(p.wa_phone, p.phone) IS NOT NULL) AS wa_dm,
           EXISTS (SELECT 1 FROM sessions s WHERE s.player_id = p.id) AS signed_in
         FROM players p WHERE p.active = 1 ORDER BY p.name`
      : "SELECT id, name, type, is_admin, active, avatar_kind, avatar_emoji, avatar_v FROM players WHERE active = 1 ORDER BY name");

  const signups = open ? await all(env, "SELECT player_id, answer, answered_at FROM signups WHERE game_id = ?", game.id) : [];
  const roster = open ? computeRoster(game, players, signups) : null;

  const season = seasonStart(now);
  const played = await all(env,
    `SELECT g.date,
       SUM(CASE WHEN a.kind = 'ft' THEN 1 ELSE 0 END) AS ft,
       SUM(CASE WHEN a.kind = 'di' THEN 1 ELSE 0 END) AS di
     FROM games g LEFT JOIN attendance a ON a.game_id = g.id
     WHERE g.finished_at IS NOT NULL AND g.status = 'open' AND g.date >= ?
     GROUP BY g.id ORDER BY g.date`, season);
  const att = await all(env,
    `SELECT a.player_id, COUNT(*) AS n FROM attendance a JOIN games g ON g.id = a.game_id
     WHERE g.status = 'open' AND g.date >= ? GROUP BY a.player_id`, season);
  const attMap = Object.fromEntries(att.map(r => [r.player_id, r.n]));
  for (const p of players) {
    p.att = attMap[p.id] || 0;
    if (me.is_admin) {
      p.texts = optedIn(p) ? "on" : p.opted_out_at ? "stopped" : "not yet";
      // Admins only learn *whether* a player allows WhatsApp DMs, never the number.
      p.wa_dm = !!p.wa_dm;
      delete p.text_opt_in_at; delete p.opted_out_at;
    }
  }
  // A player's own number is sent only to that player; admins never receive anyone's number.
  const mine = await first(env, "SELECT phone, phone_verified_at, intro_seen_at, text_opt_in_at, opted_out_at, avatar_kind, avatar_emoji, avatar_v, wa_dm_ok, wa_phone FROM players WHERE id = ?", me.id);
  const cfg = textConfig(env);
  const textsOn = (await textSettings(env)).enabled;

  const state = {
    now,
    me: { id: me.id, name: me.name, type: me.type, is_admin: !!me.is_admin, has_phone: !!mine.phone, phone_last4: last4(mine.phone), phone_verified: !!mine.phone_verified_at, show_intro: !mine.intro_seen_at, texts_on: optedIn(mine),
      avatar_kind: mine.avatar_kind, avatar_emoji: mine.avatar_emoji, avatar_v: mine.avatar_v,
      wa_dm_ok: !!mine.wa_dm_ok, wa_phone_last4: last4(mine.wa_phone) },
    texts: { live: cfg.ready && textsOn, number: cfg.from },
    game, open, times: timesOf(game), roster,
    upcoming, schedule, stepLabels: STEP_LABELS, avatarEmoji: AVATAR_EMOJI,
    signups: Object.fromEntries(signups.map(s => [s.player_id, s.answer])),
    players,
    season: { start: season, games: played.length, history: played.slice(-8) },
    venue: withPhotoUrl(await getSetting(env, "venue")),
    dropin_fee_cents: (await getSetting(env, "fees")).dropin_cents,
    announcement: activeAnnouncement(await getSetting(env, "announcement"), now),
    owed: await first(env, "SELECT COALESCE(SUM(amount_cents), 0) AS cents, COUNT(*) AS games FROM dropin_charges WHERE player_id = ? AND paid_at IS NULL", me.id),
  };
  if (me.is_admin) {
    state.payments = {
      fee_cents: (await getSetting(env, "fees")).dropin_cents,
      // Unpaid charges, plus anything paid in the last 60 days so a mistaken tick can be undone.
      charges: await all(env,
        `SELECT c.game_id, c.player_id, c.amount_cents, c.paid_at, g.date, p.name AS player
         FROM dropin_charges c JOIN games g ON g.id = c.game_id JOIN players p ON p.id = c.player_id
         WHERE c.paid_at IS NULL OR c.paid_at > ? ORDER BY g.date DESC`, now - 60 * 86400_000),
    };
    state.texts.admin = {
      ready: cfg.ready, enabled: textsOn, kinds: KINDS, problems: cfg.problems,
      recent: await all(env,
        `SELECT m.kind, m.status, m.error, m.sent_at, p.name FROM messages m LEFT JOIN players p ON p.id = m.player_id
         ORDER BY m.id DESC LIMIT 12`),
    };
    state.audit = await all(env,
      `SELECT l.action, l.detail, l.at, p.name AS actor FROM audit_log l LEFT JOIN players p ON p.id = l.actor_id
       ORDER BY l.id DESC LIMIT 8`);
  }
  return state;
}

// ---------- actions ----------
/** The current game, but only once its sign-ups are open. */
export async function currentGame(env, now = Date.now()) {
  await tick(env, now);
  const g = await first(env, "SELECT * FROM games WHERE finished_at IS NULL ORDER BY starts_at LIMIT 1");
  return g && now >= g.opens_at ? g : null;
}

const fmtDay = date => { const [y, m, d] = date.split("-").map(Number); return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-CA", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" }); };

export async function updateSchedule(env, me, b, now = Date.now()) {
  const cur = await getSchedule(env);
  const s = {
    weekday: Number(b.weekday ?? cur.weekday), start: String(b.start ?? cur.start), end: String(b.end ?? cur.end), cap: Number(b.cap ?? cur.cap),
    open: b.open ?? cur.open, reminder: b.reminder ?? cur.reminder, priorityEnd: b.priorityEnd ?? cur.priorityEnd, lock: b.lock ?? cur.lock,
  };
  for (const k of ["open", "reminder", "priorityEnd", "lock"]) s[k] = { before: Number(s[k].before), time: String(s[k].time) };
  const err = scheduleError(s);
  if (err) fail(400, err);
  await run(env, "INSERT INTO settings (key, value) VALUES ('schedule', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", JSON.stringify(s));

  // Re-plan upcoming games that nobody has touched: not opened yet, not moved or skipped, no answers.
  const games = await all(env,
    `SELECT * FROM games g WHERE finished_at IS NULL AND custom = 0 AND status = 'open' AND opens_at > ?
       AND NOT EXISTS (SELECT 1 FROM signups x WHERE x.game_id = g.id) ORDER BY starts_at`, now);
  let moved = 0;
  for (const g of games) {
    const date = dateInWeek(g.week_of, s.weekday);
    const t = computeTimes(date, s.start, s.end, s);
    try {
      await run(env, `UPDATE games SET date = ?, start_time = ?, end_time = ?, cap = ?, ${SET_TIMES} WHERE id = ?`, date, s.start, s.end, s.cap, ...timeCols(t), g.id);
      moved++;
    } catch { /* another game already sits on that date; leave this one as it was */ }
  }
  await audit(env, me, "schedule", `default schedule: ${dayName(s.weekday)}s ${s.start}–${s.end}, ${s.cap} spots (updated ${moved} upcoming game${moved === 1 ? "" : "s"})`);
}

export async function updateGame(env, me, id, b, now = Date.now()) {
  const g = await first(env, "SELECT * FROM games WHERE id = ?", id);
  if (!g) fail(404, "That game doesn't exist.");
  if (g.finished_at) fail(409, "That game is already over.");
  const s = await getSchedule(env);
  const notes = [];
  const openWeek = now >= g.opens_at;   // players may already have answered
  let date = g.date, start = g.start_time, end = g.end_time;

  if ("date" in b || "start" in b || "end" in b) {
    date = String(b.date ?? g.date); start = String(b.start ?? g.start_time); end = String(b.end ?? g.end_time);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) fail(400, "Pick a date.");
    const err = scheduleError({ ...s, start, end });
    if (err) fail(400, err);
    // Stay between the games before and after, so the order of weeks never changes.
    const prev = await first(env, "SELECT date FROM games WHERE starts_at < ? AND id != ? ORDER BY starts_at DESC LIMIT 1", g.starts_at, g.id);
    const next = await first(env, "SELECT date FROM games WHERE starts_at > ? AND id != ? ORDER BY starts_at LIMIT 1", g.starts_at, g.id);
    if (prev && date <= prev.date) fail(400, `Pick a date after the previous game (${fmtDay(prev.date)}).`);
    if (next && date >= next.date) fail(400, `Pick a date before the next game (${fmtDay(next.date)}). To skip a week, use Skip this date instead.`);
    const t = computeTimes(date, start, end, s);
    if (t.end <= now) fail(400, "That time has already passed.");
    await run(env, `UPDATE games SET date = ?, start_time = ?, end_time = ?, custom = 1, ${SET_TIMES} WHERE id = ?`, date, start, end, ...timeCols(t), g.id);
    await rewindSteps(env, { id: g.id, priority_ends_at: t.priorityEnd, locks_at: t.lock }, now);
    if (openWeek && g.status === "open" && (date !== g.date || start !== g.start_time || end !== g.end_time)) await notifyGameChange(env, g.id, "moved", now);
    if (date !== g.date) notes.push(`moved to ${fmtDay(date)}`);
    if (start !== g.start_time || end !== g.end_time) notes.push(`time ${start}–${end}`);
  }
  if ("status" in b) {
    if (!["open", "cancelled"].includes(b.status)) fail(400, "Unknown game status.");
    const note = b.status === "cancelled" ? String(b.note ?? "").trim().slice(0, 60) || null : null;
    await run(env, "UPDATE games SET status = ?, note = ? WHERE id = ?", b.status, note, g.id);
    if (openWeek && b.status === "cancelled" && g.status !== "cancelled") await notifyGameChange(env, g.id, "cancelled", now);
    notes.push(b.status === "cancelled" ? `skipped${note ? ` (${note})` : ""}` : "back on");
  }
  if (b.reset) {
    // Back to the default day and time for its week.
    const rd = dateInWeek(g.week_of, s.weekday);
    const t = computeTimes(rd, s.start, s.end, s);
    if (t.end <= now) fail(400, "The default time for that week has already passed.");
    try {
      await run(env, `UPDATE games SET date = ?, start_time = ?, end_time = ?, custom = 0, ${SET_TIMES} WHERE id = ?`, rd, s.start, s.end, ...timeCols(t), g.id);
    } catch { fail(409, "Another game is already on the default day for that week."); }
    await rewindSteps(env, { id: g.id, priority_ends_at: t.priorityEnd, locks_at: t.lock }, now);
    notes.push("back to the default day and time");
  }
  if (!notes.length) fail(400, "Nothing to change.");
  await audit(env, me, "game", `${fmtDay(g.date)}: ${notes.join(", ")}`);
}

async function body(req) {
  try { return await req.json(); } catch { fail(400, "The request was empty or not valid JSON."); }
}

async function api(req, env, me, path, origin, ctx) {
  if (req.method === "GET" && path === "/api/state") return json(await buildState(env, me));
  if (req.method === "GET" && path === "/api/venue-photo") {
    const row = await first(env, "SELECT data FROM images WHERE key = ?", new URL(req.url).searchParams.get("slot") === "map" ? "venue-map" : "venue");
    if (!row) return new Response("Not found", { status: 404 });
    const [, type, b64] = row.data.match(/^data:(image\/[a-z]+);base64,(.*)$/);
    return new Response(Uint8Array.from(atob(b64), c => c.charCodeAt(0)), { headers: IMAGE_HEADERS(type) });
  }
  const av = req.method === "GET" && path.match(/^\/api\/avatar\/(\d+)$/);
  if (av) {
    const row = await first(env, "SELECT a.data FROM avatars a JOIN players p ON p.id = a.player_id WHERE a.player_id = ? AND p.active = 1 AND p.avatar_kind = 'photo'", Number(av[1]));
    if (!row) return new Response("Not found", { status: 404 });
    const [, type, b64] = row.data.match(/^data:(image\/[a-z]+);base64,(.*)$/);
    const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    // The URL carries ?v=<version>, so a new photo gets a new URL and phones can cache this one for good.
    return new Response(bytes, { headers: IMAGE_HEADERS(type) });
  }
  if (req.method !== "POST") fail(404, "Not found.");
  // Any change can move drop-ins in or out of a spot; text them afterwards.
  const g0 = await currentGame(env);
  const before = g0 ? (await rosterFor(env, g0.id)).roster : null;
  const res = await apiPost(req, env, me, path, origin);
  if (before) {
    const skip = path === "/api/me/answer" ? me.id : null;
    const job = notifyRosterChange(env, g0.id, before, skip).catch(e => console.error("Text notify failed", e));
    if (ctx?.waitUntil) ctx.waitUntil(job); else await job;
  }
  return res;
}

async function apiPost(req, env, me, path, origin) {

  // ---- player actions ----
  if (path === "/api/me/answer") {
    const { answer } = await body(req);
    const game = await currentGame(env);
    if (!game) fail(409, "Sign-ups for the next game haven't opened yet.");
    if (game.status === "cancelled") fail(409, "This game is cancelled.");
    if (game.locked) fail(409, "The list is locked. Message an admin if your plans changed.");
    await setAnswer(env, game.id, me, answer ?? null);
    return json(await buildState(env, me));
  }

  if (path === "/api/me/texts") {
    const { on } = await body(req);
    const p = await first(env, "SELECT phone, phone_verified_at FROM players WHERE id = ?", me.id);
    if (on && !p.phone) fail(409, "Add your mobile number first.");
    if (on && !p.phone_verified_at) fail(409, `Text JOIN from your phone to confirm the number first.`);
    if (on) await run(env, "UPDATE players SET text_opt_in_at = ?, opted_out_at = NULL WHERE id = ?", Date.now(), me.id);
    else await run(env, "UPDATE players SET opted_out_at = ? WHERE id = ?", Date.now(), me.id);
    return json(await buildState(env, me));
  }

  if (path === "/api/me/phone") {
    const { phone } = await body(req);
    const next = phone ? normalizePhone(phone) : null;
    const cur = await first(env, "SELECT phone FROM players WHERE id = ?", me.id);
    if (next !== cur.phone) {
      if (next && await first(env, "SELECT 1 FROM players WHERE phone = ? AND id != ? AND active = 1", next, me.id))
        fail(409, "That number can't be used. Double-check it, or ask an admin.");
      // A new number has to be confirmed (by texting JOIN from it) before any texts go to it.
      await run(env, "UPDATE players SET phone = ?, phone_verified_at = NULL, text_opt_in_at = NULL WHERE id = ?", next, me.id);
      await audit(env, me, "player", next ? "updated their own mobile number" : "removed their mobile number");
    }
    return json(await buildState(env, me));
  }

  if (path === "/api/me/name") {
    const name = String((await body(req)).name || "").trim().replace(/\s+/g, " ");
    if (!name) fail(400, "Enter your name.");
    if (name.length > 40) fail(400, "Keep your name under 40 characters.");
    if (name !== me.name) {
      await run(env, "UPDATE players SET name = ? WHERE id = ?", name, me.id);
      await audit(env, me, "player", `${me.name} changed their name to ${name}`);
    }
    return json(await buildState(env, { ...me, name }));
  }

  if (path === "/api/me/avatar") {
    const b = await body(req);
    const now = Date.now();
    if (b.kind === "initials") {
      await run(env, "UPDATE players SET avatar_kind = NULL, avatar_emoji = NULL WHERE id = ?", me.id);
      await run(env, "DELETE FROM avatars WHERE player_id = ?", me.id);
    } else if (b.kind === "emoji") {
      const e = String(b.emoji || "");
      if (!AVATAR_EMOJI.includes(e)) fail(400, "Pick one of the avatars shown.");
      await run(env, "UPDATE players SET avatar_kind = 'emoji', avatar_emoji = ? WHERE id = ?", e, me.id);
      await run(env, "DELETE FROM avatars WHERE player_id = ?", me.id);
    } else if (b.kind === "photo") {
      if (!validImage(b.data, 400_000)) fail(400, "That picture couldn't be used. Try a different photo.");
      await run(env, "INSERT INTO avatars (player_id, data, updated_at) VALUES (?,?,?) ON CONFLICT (player_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at", me.id, b.data, now);
      await run(env, "UPDATE players SET avatar_kind = 'photo', avatar_emoji = NULL, avatar_v = ? WHERE id = ?", now, me.id);
    } else fail(400, "Unknown picture type.");
    return json(await buildState(env, me));
  }

  if (path === "/api/me/whatsapp") {
    const b = await body(req);
    const cur = await first(env, "SELECT phone, wa_phone, wa_dm_ok FROM players WHERE id = ?", me.id);
    const waPhone = "wa_phone" in b ? (b.wa_phone ? normalizePhone(b.wa_phone) : null) : cur.wa_phone;
    const ok = "ok" in b ? !!b.ok : !!cur.wa_dm_ok;
    if (ok && !waPhone && !cur.phone) fail(409, "Add your mobile number or a WhatsApp number first.");
    await run(env, "UPDATE players SET wa_dm_ok = ?, wa_phone = ? WHERE id = ?", ok ? 1 : 0, waPhone, me.id);
    if (ok !== !!cur.wa_dm_ok) await audit(env, me, "player", ok ? "let admins message them on WhatsApp" : "stopped admins messaging them on WhatsApp");
    return json(await buildState(env, me));
  }

  if (path === "/api/me/intro") {
    await run(env, "UPDATE players SET intro_seen_at = COALESCE(intro_seen_at, ?) WHERE id = ?", Date.now(), me.id);
    return json(await buildState(env, me));
  }

  // ---- admin actions ----
  if (!path.startsWith("/api/admin/")) fail(404, "Not found.");
  if (!me.is_admin) fail(403, "Only admins can do that.");
  const b = await body(req);

  // The one place a number leaves the server: an admin tapped a WhatsApp button for
  // a player who allows it. The link goes straight to WhatsApp and isn't stored.
  if (path === "/api/admin/wa-link") {
    const p = await first(env, "SELECT name, COALESCE(wa_phone, phone) AS num, wa_dm_ok FROM players WHERE id = ? AND active = 1", Number(b.player_id));
    const text = String(b.text || "").slice(0, 1500);
    const digits = p && p.wa_dm_ok && p.num ? String(p.num).replace(/\D/g, "") : "";
    return json({ url: `https://wa.me/${digits}?text=${encodeURIComponent(text)}`, direct: !!digits });
  }

  if (path === "/api/admin/fees") {
    const cents = Math.round(Number(b.dropin) * 100);
    if (!(cents >= 0 && cents <= 10000)) fail(400, "Enter a fee between $0 and $100.");
    await setSetting(env, "fees", { dropin_cents: cents });
    await audit(env, me, "fees", `drop-in fee set to ${money(cents)} (applies to games that end from now on)`);
    return json(await buildState(env, me));
  }

  const ch = path.match(/^\/api\/admin\/charges\/(\d+)\/(\d+)$/);
  if (ch) {
    const c = await first(env, "SELECT c.*, p.name, g.date FROM dropin_charges c JOIN players p ON p.id = c.player_id JOIN games g ON g.id = c.game_id WHERE c.game_id = ? AND c.player_id = ?", Number(ch[1]), Number(ch[2]));
    if (!c) fail(404, "That charge doesn't exist.");
    await run(env, "UPDATE dropin_charges SET paid_at = ?, paid_by = ? WHERE game_id = ? AND player_id = ?", b.paid ? Date.now() : null, b.paid ? me.id : null, c.game_id, c.player_id);
    await audit(env, me, "payment", `${c.name}: ${fmtDay(c.date)} ${b.paid ? "marked paid" : "marked unpaid"} (${money(c.amount_cents)})`);
    return json(await buildState(env, me));
  }

  const pa = path.match(/^\/api\/admin\/players\/(\d+)\/paid-all$/);
  if (pa) {
    const p = await first(env, "SELECT name FROM players WHERE id = ?", Number(pa[1]));
    if (!p) fail(404, "That player doesn't exist.");
    const owed = await first(env, "SELECT COALESCE(SUM(amount_cents),0) AS cents FROM dropin_charges WHERE player_id = ? AND paid_at IS NULL", Number(pa[1]));
    await run(env, "UPDATE dropin_charges SET paid_at = ?, paid_by = ? WHERE player_id = ? AND paid_at IS NULL", Date.now(), me.id, Number(pa[1]));
    await audit(env, me, "payment", `${p.name}: paid in full (${money(owed.cents)})`);
    return json(await buildState(env, me));
  }

  if (path === "/api/admin/announcement") {
    if (b.clear) {
      await setSetting(env, "announcement", null);
      await audit(env, me, "announcement", "removed the announcement");
    } else {
      const text = String(b.text || "").trim();
      if (!text) fail(400, "Write the announcement first.");
      if (text.length > 280) fail(400, "Keep it under 280 characters.");
      const g = b.until_game_end ? await first(env, "SELECT ends_at FROM games WHERE finished_at IS NULL ORDER BY starts_at LIMIT 1") : null;
      await setSetting(env, "announcement", { text, by: me.name, at: Date.now(), until: g?.ends_at ?? null });
      await audit(env, me, "announcement", `posted: ${text.slice(0, 60)}${text.length > 60 ? "…" : ""}`);
    }
    return json(await buildState(env, me));
  }

  if (path === "/api/admin/venue") {
    const clean = (v, max) => String(v ?? "").trim().slice(0, max);
    const venue = { ...(await getSetting(env, "venue")), name: clean(b.name, 80), address: clean(b.address, 160), notes: clean(b.notes, 1000) };
    if (!venue.name && !venue.address) fail(400, "Enter the gym's name or address.");
    await setSetting(env, "venue", venue);
    await audit(env, me, "venue", `gym info updated: ${venue.name}`);
    return json(await buildState(env, me));
  }

  if (path === "/api/admin/venue-photo") {
    const venue = await getSetting(env, "venue");
    const slot = b.slot === "map" ? "map" : "photo", key = slot === "map" ? "venue-map" : "venue";
    if (b.action === "upload") {
      if (!validImage(b.data, 1_200_000)) fail(400, "That picture couldn't be used. Try a different photo.");
      const now = Date.now();
      await run(env, "INSERT INTO images (key, data, updated_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at", key, b.data, now);
      Object.assign(venue, { [slot]: "uploaded", [`${slot}_v`]: now });
    } else if (b.action === "remove") {
      Object.assign(venue, { [slot]: "none" });
    } else fail(400, "Unknown photo action.");
    await setSetting(env, "venue", venue);
    const what = slot === "map" ? "gym map" : "gym photo";
    await audit(env, me, "venue", { upload: `uploaded a new ${what}`, remove: `removed the ${what}` }[b.action]);
    return json(await buildState(env, me));
  }

  if (path === "/api/admin/texts") {
    if (b.enabled && !textConfig(env).ready) fail(409, "Twilio isn't connected yet. The keys and phone number still need to be added.");
    await setTextSettings(env, { ...(await textSettings(env)), enabled: !!b.enabled });
    await audit(env, me, "texts", b.enabled ? "turned text messages on" : "turned text messages off");
    return json(await buildState(env, me));
  }

  if (path === "/api/admin/texts/test") {
    const p = await first(env, "SELECT * FROM players WHERE id = ?", me.id);
    if (!p.phone) fail(409, "Add your own mobile number first: tap your initials at the top right.");
    const r = await sendText(env, { player: p, kind: "test", force: true });
    if (r.error) fail(502, `Twilio couldn't send it: ${r.error}`);
    if (r.skipped) fail(409, `Not sent: ${r.skipped}.`);
    return json({ ok: true, state: await buildState(env, me) });
  }

  if (path === "/api/admin/schedule") {
    await updateSchedule(env, me, b);
    return json(await buildState(env, me));
  }

  const gm = path.match(/^\/api\/admin\/games\/(\d+)$/);
  if (gm) {
    await updateGame(env, me, Number(gm[1]), b);
    return json(await buildState(env, me));
  }

  if (path === "/api/admin/game") {
    const game = await currentGame(env);
    if (!game) fail(409, "Sign-ups for the next game haven't opened yet.");
    const sets = [], vals = [], notes = [];
    if ("priority_open" in b) { sets.push("priority_open = ?"); vals.push(b.priority_open ? 1 : 0); notes.push(`priority ${b.priority_open ? "on" : "off"}`); }
    if ("locked" in b) { sets.push("locked = ?"); vals.push(b.locked ? 1 : 0); notes.push(b.locked ? "locked list" : "reopened sign-ups"); }
    if ("cap" in b) {
      const cap = Math.round(Number(b.cap));
      if (!(cap >= 6 && cap <= 30)) fail(400, "Spots must be between 6 and 30.");
      sets.push("cap = ?"); vals.push(cap); notes.push(`spots ${cap}`);
    }
    if ("status" in b) {
      if (!["open", "cancelled"].includes(b.status)) fail(400, "Unknown game status.");
      sets.push("status = ?"); vals.push(b.status); notes.push(b.status === "cancelled" ? "cancelled the game" : "restored the game");
    }
    if (!sets.length) fail(400, "Nothing to change.");
    await run(env, `UPDATE games SET ${sets.join(", ")} WHERE id = ?`, ...vals, game.id);
    if (b.status === "cancelled" && game.status !== "cancelled") await notifyGameChange(env, game.id, "cancelled");
    // Priority turned off: drop-ins who didn't ask yet hear that spots are open (once per game).
    if ("priority_open" in b && !b.priority_open && game.priority_open) await scheduledMessages(env, game.id, "msg_spots");
    await audit(env, me, "game", `${fmtDay(game.date)}: ${notes.join(", ")}`);
    return json(await buildState(env, me));
  }

  if (path === "/api/admin/answer") {
    const game = await currentGame(env);
    if (!game) fail(409, "Sign-ups for the next game haven't opened yet.");
    const p = await first(env, "SELECT * FROM players WHERE id = ? AND active = 1", b.player_id);
    if (!p) fail(404, "That player isn't on the roster.");
    await setAnswer(env, game.id, p, b.answer ?? null);
    await audit(env, me, "answer", `${p.name}: ${b.answer ?? "cleared"}`);
    return json(await buildState(env, me));
  }

  if (path === "/api/admin/players") {
    const name = String(b.name || "").trim();
    if (!name) fail(400, "Enter the player's name.");
    if (name.length > 40) fail(400, "Keep the name under 40 characters.");
    const type = b.type === "ft" ? "ft" : "di";
    const r = await run(env, "INSERT INTO players (name, type, created_at) VALUES (?,?,?)", name, type, Date.now());
    const id = r.meta.last_row_id;
    const link = await newLink(env, id, origin, false);
    await audit(env, me, "player", `added ${name} as ${type === "ft" ? "full-timer" : "drop-in"}`);
    return json({ link, player_id: id, state: await buildState(env, me) });
  }

  let m = path.match(/^\/api\/admin\/players\/(\d+)(\/link)?$/);
  if (m) {
    const p = await first(env, "SELECT * FROM players WHERE id = ? AND active = 1", Number(m[1]));
    if (!p) fail(404, "That player isn't on the roster.");

    if (m[2]) {
      const link = await newLink(env, p.id, origin, !!b.sign_out);
      await audit(env, me, "link", `new link for ${p.name}${b.sign_out ? " (signed out all phones)" : ""}`);
      return json({ link, state: await buildState(env, me) });
    }

    const notes = [];
    if ("name" in b) {
      const name = String(b.name || "").trim();
      if (!name || name.length > 40) fail(400, "Enter a name under 40 characters.");
      await run(env, "UPDATE players SET name = ? WHERE id = ?", name, p.id); notes.push(`renamed to ${name}`);
    }
    if ("phone" in b) fail(403, "Players add and change their own mobile numbers.");
    if ("type" in b && b.type !== p.type) {
      if (!["ft", "di"].includes(b.type)) fail(400, "Type must be full-time or drop-in.");
      await run(env, "UPDATE players SET type = ? WHERE id = ?", b.type, p.id);
      const game = await currentGame(env);
      if (game) await run(env, "DELETE FROM signups WHERE game_id = ? AND player_id = ?", game.id, p.id);
      notes.push(b.type === "ft" ? "made full-timer" : "made drop-in");
    }
    if (b.avatar_reset) {
      await run(env, "UPDATE players SET avatar_kind = NULL, avatar_emoji = NULL WHERE id = ?", p.id);
      await run(env, "DELETE FROM avatars WHERE player_id = ?", p.id);
      notes.push("removed profile picture");
    }
    if ("is_admin" in b && !!b.is_admin !== !!p.is_admin) {
      if (!b.is_admin) {
        const admins = await first(env, "SELECT COUNT(*) AS n FROM players WHERE is_admin = 1 AND active = 1");
        if (admins.n <= 1) fail(409, "The group needs at least one admin.");
      }
      await run(env, "UPDATE players SET is_admin = ? WHERE id = ?", b.is_admin ? 1 : 0, p.id);
      notes.push(b.is_admin ? "made admin" : "removed admin");
    }
    if (b.active === false) {
      if (p.id === me.id) fail(409, "You can't remove yourself.");
      if (p.is_admin) fail(409, "Remove their admin rights first.");
      await run(env, "UPDATE players SET active = 0, link_hash = NULL WHERE id = ?", p.id);
      await run(env, "DELETE FROM sessions WHERE player_id = ?", p.id);
      const game = await currentGame(env);
      if (game) await run(env, "DELETE FROM signups WHERE game_id = ? AND player_id = ?", game.id, p.id);
      notes.push("removed from group");
    }
    if (notes.length) await audit(env, me, "player", `${p.name}: ${notes.join(", ")}`);
    return json(await buildState(env, me));
  }

  fail(404, "Not found.");
}

// ---------- calendar (.ics) ----------
const icsText = s => String(s || "").replace(/\\/g, "\\\\").replace(/\r?\n|\r/g, "\\n").replace(/([,;])/g, "\\$1");
const icsTime = ms => new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
function icsFold(line) {   // lines longer than 75 bytes continue on the next line, indented
  const out = []; let cur = "";
  for (const ch of line) { if (new TextEncoder().encode(cur + ch).length > 74) { out.push(cur); cur = " " + ch; } else cur += ch; }
  return [...out, cur].join("\r\n");
}
async function calendarResponse(env, url, gameId) {
  // Anyone can fetch this, so it only reads (the 15-minute job keeps games planned) and
  // is cached at Cloudflare's edge for 15 minutes.
  const cache = globalThis.caches?.default, key = new Request(url.origin + url.pathname);
  const hit = cache && await cache.match(key);
  if (hit) return hit;
  const venue = await getSetting(env, "venue");
  const games = gameId
    ? await all(env, "SELECT * FROM games WHERE id = ?", gameId)
    : await all(env, "SELECT * FROM games WHERE starts_at IS NOT NULL AND ends_at > ? ORDER BY starts_at LIMIT 14", Date.now() - 35 * 86400_000);
  if (gameId && !games.length) return new Response("Not found", { status: 404 });
  const where = [venue.name, venue.address].filter(Boolean).join(", ");
  const name = brand(env).name;
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Sunday Ball//EN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
    `X-WR-CALNAME:${icsText(name)}`, "X-PUBLISHED-TTL:PT6H", "REFRESH-INTERVAL;VALUE=DURATION:PT6H"];
  for (const g of games) {
    const cancelled = g.status === "cancelled";
    lines.push("BEGIN:VEVENT", `UID:game-${g.id}@${url.host}`, `DTSTAMP:${icsTime(Date.now())}`,
      `DTSTART:${icsTime(g.starts_at)}`, `DTEND:${icsTime(g.ends_at)}`,
      `SUMMARY:${icsText(cancelled ? `Cancelled: ${name}${g.note ? ` (${g.note})` : ""}` : name)}`,
      `LOCATION:${icsText(where)}`,
      `DESCRIPTION:${icsText(`Answer in or out in the app: ${url.origin}`)}`,   // gym notes stay in the app: they may hold a door code
      `URL:${url.origin}`, `STATUS:${cancelled ? "CANCELLED" : "CONFIRMED"}`, `SEQUENCE:${(g.custom ? 1 : 0) + (cancelled ? 2 : 0)}`,
      "END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  const res = new Response(lines.map(icsFold).join("\r\n") + "\r\n", {
    headers: {
      "content-type": "text/calendar; charset=utf-8",
      "content-disposition": `inline; filename="${gameId ? "sunday-ball-game" : "sunday-ball"}.ics"`,
      "cache-control": "public, max-age=900",
    },
  });
  if (cache) await cache.put(key, res.clone()).catch(() => {});
  return res;
}

// ---------- entry points ----------
// Apps that fetch a link to show a preview card. They get a plain card and no sign-in,
// so sending someone their link doesn't sign in the preview robot instead.
const PREVIEW_BOT = /WhatsApp|facebookexternalhit|Facebot|Twitterbot|Slackbot|TelegramBot|Discordbot|LinkedInBot|Applebot|Googlebot|bingbot|SkypeUriPreview|Iframely|embedly|redditbot|vkShare|Pinterest/i;
const linkPreview = (url, env) => new Response(
  `<!doctype html><meta charset="utf-8"><title>${esc(brand(env).name)}</title>
<meta property="og:title" content="Your ${esc(brand(env).name)} link"><meta property="og:description" content="Tap to sign in and answer for Sunday's game.">
<meta property="og:image" content="${url.origin}/icon-512.png"><meta name="robots" content="noindex">`,
  { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex" } });

async function handle(req, env, ctx) {
  const url = new URL(req.url);
  const path = url.pathname;

  // Personal link: sign this phone in (renewed on every visit), then go to the app.
  const link = path.match(/^\/p\/([A-Za-z0-9_-]{16,64})\/?$/);
  if (link && req.method === "GET") {
    if (PREVIEW_BOT.test(req.headers.get("user-agent") || "")) return linkPreview(url, env);
    const p = await first(env, "SELECT id FROM players WHERE link_hash = ? AND active = 1", await sha256(link[1]));
    if (!p) return Response.redirect(`${url.origin}/?link=invalid`, 302);
    const sid = randomCode(24);
    await run(env, "INSERT INTO sessions (id_hash, player_id, created_at, last_seen) VALUES (?,?,?,?)", await sha256(sid), p.id, Date.now(), Date.now());
    return new Response(null, {
      status: 302,
      headers: {
        location: "/",
        "set-cookie": signInCookie(sid),
        "referrer-policy": "no-referrer",
      },
    });
  }

  // Calendar files. Public on purpose: they hold only game times and the gym,
  // never anyone's name, so calendar apps can fetch them without signing in.
  const cal = path.match(/^\/cal\/(?:games|game\/(\d+))\.ics$/);
  if (cal && (req.method === "GET" || req.method === "HEAD")) {
    // Calendar services often check the address with HEAD first; answer it as a calendar too.
    const res = await calendarResponse(env, url, cal[1] ? Number(cal[1]) : null);
    return req.method === "HEAD" ? new Response(null, { status: res.status, headers: res.headers }) : res;
  }

  if (path === "/hooks/twilio" || path === "/hooks/twilio/status") {
    if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
    return handleTwilioHook(req, env, { currentGame });
  }

  if (path.startsWith("/api/")) {
    // Writes must come from the app's own pages.
    if (req.method !== "GET") {
      const origin = req.headers.get("origin");
      if (origin && origin !== url.origin) fail(403, "Requests from other sites aren't allowed.");
    }
    const sid = cookie(req, COOKIE);
    const me = sid && await first(env,
      `SELECT p.*, s.id_hash, s.last_seen FROM sessions s JOIN players p ON p.id = s.player_id
       WHERE s.id_hash = ? AND p.active = 1 AND COALESCE(s.last_seen, s.created_at) > ?`, await sha256(sid), Date.now() - SIGN_IN_MAX_AGE * 1000);
    if (!me) fail(401, "Open your personal link to sign in.");
    // Renew the sign-in (at most once an hour): the cookie's 400 days start again from today.
    const renew = !me.last_seen || Date.now() - me.last_seen > 3600_000;
    if (renew) await run(env, "UPDATE sessions SET last_seen = ? WHERE id_hash = ?", Date.now(), me.id_hash);
    const res = await api(req, env, me, path, url.origin, ctx);
    if (renew) res.headers.append("set-cookie", signInCookie(sid));
    return res;
  }

  if (req.method === "GET" || req.method === "HEAD") {
    // The group's own name and logo (see src/brand.js), put into the page and the home-screen manifest.
    if ((path === "/" || path === "/index.html") && customBrand(env)) return rewriteAsset(req, env, html => brandPage(html, brand(env)));
    if (path === "/manifest.webmanifest" && customBrand(env))
      return rewriteAsset(req, env, text => JSON.stringify({ ...JSON.parse(text), name: brand(env).name }, null, 2));
    // The group's own home-screen icons, if it uploaded any; otherwise the ones in public/.
    if (ICON_FILES.includes(path.slice(1))) {
      const row = await first(env, "SELECT data FROM images WHERE key = ?", "icon:" + path.slice(1)).catch(() => null);
      const m = row?.data.match(/^data:image\/png;base64,(.*)$/);
      if (m) return new Response(req.method === "HEAD" ? null : Uint8Array.from(atob(m[1]), c => c.charCodeAt(0)),
        { headers: { "content-type": "image/png", "cache-control": "public, max-age=86400", "x-content-type-options": "nosniff" } });
    }
  }
  return env.ASSETS.fetch(req);
}

// Serves a file from public/ with its text changed, keeping its headers.
async function rewriteAsset(req, env, change) {
  const res = await env.ASSETS.fetch(req);
  if (!res.ok) return res;
  const headers = new Headers(res.headers);
  headers.delete("content-length"); headers.delete("etag");
  return new Response(req.method === "HEAD" ? null : change(await res.text()), { status: res.status, headers });
}

export default {
  async fetch(req, env, ctx) {
    try {
      return await handle(req, env, ctx);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status);
      console.error(e);
      return json({ error: "Something went wrong on our end. Try again in a minute." }, 500);
    }
  },
  async scheduled(controller, env) {
    await tick(env, controller.scheduledTime || Date.now());
  },
};
