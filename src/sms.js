// Text messages (SMS) through Twilio: scheduled reminders, event messages, and
// replies (IN, OUT, SPOT, JOIN). Twilio itself answers STOP, START and HELP for
// texts; the app just records opt-outs and opt-ins when they arrive.
import { brand } from "./brand.js";
import { all, first, run, newLink, setAnswer } from "./db.js";
import { computeRoster } from "./roster.js";

export const KINDS = {
  week_open: "Week opens: in or out? (full-timers)",
  reminder: "Reminder to no-replies (full-timers)",
  spots_open: "Spots open (drop-ins)",
  promoted: "You're in (drop-in moved up)",
  bumped: "Moved to waitlist (drop-in)",
  cancelled: "Game cancelled",
  moved: "Game moved or re-timed",
  test: "Test text",
  reply: "Reply",
};

export function textConfig(env) {
  // Trim in case a pasted secret picked up a space or line break.
  const sid = String(env.TWILIO_ACCOUNT_SID || "").trim(), token = String(env.TWILIO_AUTH_TOKEN || "").trim();
  const from = String(env.TWILIO_SMS_FROM || "").trim();
  // Shape checks only; the values themselves are never shown anywhere.
  const problems = [];
  if (sid && !/^AC[0-9a-f]{32}$/i.test(sid)) problems.push(`The Account SID doesn't look right: it should start with "AC" and be 34 characters (it's ${sid.length}${sid.startsWith("SK") ? ", and starts with SK, which is an API key, not the Account SID" : ""}).`);
  if (token && !/^[0-9a-f]{32}$/i.test(token)) problems.push(`The Auth Token doesn't look right: it should be 32 letters and numbers (it's ${token.length}).`);
  return {
    sid, token, from, problems,
    appUrl: (env.APP_URL || "").replace(/\/$/, ""),
    ready: !!(sid && token && from),
  };
}

export async function textSettings(env) {
  const row = await first(env, "SELECT value FROM settings WHERE key = 'texts'");
  try { return { enabled: false, ...JSON.parse(row?.value || "{}") }; } catch { return { enabled: false }; }
}
export const setTextSettings = (env, s) =>
  run(env, "INSERT INTO settings (key, value) VALUES ('texts', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", JSON.stringify(s));

export const optedIn = p => !!p.text_opt_in_at && (!p.opted_out_at || p.opted_out_at < p.text_opt_in_at);

// ---------- wording ----------
// Plain characters only (no en dashes or curly quotes): anything outside the
// basic SMS alphabet makes Twilio split a text into more, pricier pieces.
const fmtDay = date => {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-CA", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" }).replace(".", "");
};
const clock = t => { const [h, m] = t.split(":").map(Number); return `${h % 12 || 12}${m ? ":" + String(m).padStart(2, "0") : ""}`; };
const ap = t => (Number(t.split(":")[0]) < 12 ? "AM" : "PM");
const fmtRange = (a, b) => ap(a) === ap(b) ? `${clock(a)}-${clock(b)} ${ap(b)}` : `${clock(a)} ${ap(a)}-${clock(b)} ${ap(b)}`;
const when = g => `${fmtDay(g.date)}, ${fmtRange(g.start_time, g.end_time)}`;
const firstName = n => String(n).split(" ")[0];
/** Every text ends with a link to the app (unless it already has one). */
const withLink = (text, app) => (!app || text.includes(app) ? text : `${text} App: ${app}`);

const BODIES = {
  week_open: (g, app) => `sign-ups are open for ${when(g)}. Reply IN or OUT, or answer in the app: ${app} (Reply STOP to stop texts.)`,
  reminder: (g, app) => `we still need your answer for ${when(g)}. Reply IN or OUT, or use the app: ${app}`,
  spots_open: (g, app, x) => `${x.open} spot${x.open === 1 ? " is" : "s are"} open for ${when(g)}. Reply SPOT to grab one. First come, first served.`,
  promoted: g => `you're in for ${when(g)}. See you there! Reply OUT if you can't make it.`,
  bumped: (g, app, x) => `a full-timer took the last spot for ${fmtDay(g.date)}. You're #${x.pos} on the waitlist and will move up if anyone drops.`,
  cancelled: (g, app) => `no game on ${fmtDay(g.date)}${g.note ? ` (${g.note})` : ""}. Check the app for the next one: ${app}`,
  moved: g => `heads up, the game is now ${when(g)}. Your answer still counts. Reply OUT if that doesn't work.`,
  test: (g, app, x) => `hi ${x.name}, this is a test text. Texts from the app are working.`,
};

// ---------- sending ----------
/**
 * Sends one text. Skips (without error) when texts are off, the player hasn't
 * opted in, or the same scheduled text already went out.
 */
export async function sendText(env, { player, kind, game = null, extra = {}, dedupe = null, force = false }, now = Date.now()) {
  const cfg = textConfig(env);
  if (!cfg.ready) return { skipped: "Twilio isn't connected" };
  if (!force && !(await textSettings(env)).enabled) return { skipped: "texts are turned off" };
  if (!player.phone) return { skipped: "no mobile number on file" };
  if (!force && !optedIn(player)) return { skipped: "player hasn't opted in" };

  const ins = await run(env,
    "INSERT OR IGNORE INTO messages (game_id, player_id, kind, dedupe_key, sent_at) VALUES (?,?,?,?,?)",
    game?.id ?? null, player.id, kind, dedupe, now);
  if (ins.meta.changes !== 1) return { skipped: "already sent" };
  const msgId = ins.meta.last_row_id;

  const form = new URLSearchParams({ To: player.phone, From: cfg.from, Body: withLink(`${brand(env).name}: ${BODIES[kind](game, cfg.appUrl, { name: firstName(player.name), ...extra })}`, cfg.appUrl) });
  if (cfg.appUrl) form.set("StatusCallback", `${cfg.appUrl}/hooks/twilio/status`);
  try {
    const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${cfg.sid}/Messages.json`, {
      method: "POST",
      headers: { authorization: "Basic " + btoa(`${cfg.sid}:${cfg.token}`), "content-type": "application/x-www-form-urlencoded" },
      body: form,
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      await run(env, "UPDATE messages SET status = 'failed', error = ?, updated_at = ? WHERE id = ?", scrub(`${data.code || r.status}: ${data.message || "Twilio error"}`).slice(0, 300), now, msgId);
      return { error: data.message || `Twilio error ${r.status}` };
    }
    await run(env, "UPDATE messages SET twilio_sid = ?, status = ?, updated_at = ? WHERE id = ?", data.sid, data.status || "queued", now, msgId);
    return { sid: data.sid };
  } catch (e) {
    await run(env, "UPDATE messages SET status = 'failed', error = ?, updated_at = ? WHERE id = ?", String(e).slice(0, 300), now, msgId);
    return { error: "Couldn't reach Twilio" };
  }
}

// Twilio's error messages can quote the phone number; admins see these errors, so drop the digits.
const scrub = text => String(text).replace(/\+?\d[\d\s().-]{6,}\d/g, "[number]");

// Event texts (moved up, bumped, game moved) are capped per player per game, so someone
// toggling in and out can't make the app text a drop-in over and over.
const EVENT_LIMIT = 3, EVENT_GAP = 10 * 60_000;
async function eventAllowed(env, gameId, playerId, now) {
  const r = await first(env,
    "SELECT COUNT(*) AS n, MAX(sent_at) AS last FROM messages WHERE game_id = ? AND player_id = ? AND kind IN ('promoted','bumped','moved')",
    gameId, playerId);
  return r.n < EVENT_LIMIT && (!r.last || now - r.last >= EVENT_GAP);
}

const playerCols = "id, name, phone, type, active, text_opt_in_at, opted_out_at";

export async function rosterFor(env, gameId) {
  const game = await first(env, "SELECT * FROM games WHERE id = ?", gameId);
  const players = await all(env, `SELECT ${playerCols} FROM players`);
  const signups = await all(env, "SELECT * FROM signups WHERE game_id = ?", gameId);
  return { game, players, signups, roster: computeRoster(game, players, signups) };
}

/** Texts drop-ins who moved into a spot or back to the waitlist. `skip` is the player who made the change. */
export async function notifyRosterChange(env, gameId, before, skip = null, now = Date.now()) {
  if (!before) return;
  const { game, players, roster: after } = await rosterFor(env, gameId);
  if (game.status !== "open" || game.finished_at) return;
  const byId = new Map(players.map(p => [p.id, p]));
  for (const id of after.diPlay) {
    if (before.diPlay.includes(id) || id === skip || !(await eventAllowed(env, game.id, id, now))) continue;
    await sendText(env, { player: byId.get(id), kind: "promoted", game }, now);
  }
  for (const id of before.diPlay) {
    if (after.diPlay.includes(id) || id === skip || !after.wait.includes(id) || !(await eventAllowed(env, game.id, id, now))) continue;
    await sendText(env, { player: byId.get(id), kind: "bumped", game, extra: { pos: after.wait.indexOf(id) + 1 } }, now);
  }
}

/** Texts everyone who said in (or asked for a spot) that the game was cancelled or moved. */
export async function notifyGameChange(env, gameId, kind, now = Date.now()) {
  const { game, players, signups } = await rosterFor(env, gameId);
  const going = new Set(signups.filter(s => s.answer !== "out").map(s => s.player_id));
  for (const p of players.filter(x => x.active && going.has(x.id))) {
    if (kind === "cancelled") await sendText(env, { player: p, kind, game, dedupe: `${game.id}:${p.id}:cancelled` }, now);
    else if (await eventAllowed(env, game.id, p.id, now)) await sendText(env, { player: p, kind, game }, now);
  }
}

/** Scheduled texts for a game, run once per step by the weekly lifecycle. */
export async function scheduledMessages(env, gameId, step, now = Date.now()) {
  const { game, players, signups, roster } = await rosterFor(env, gameId);
  if (game.status !== "open" || game.locked) return;
  const answered = new Set(signups.map(s => s.player_id));
  const active = players.filter(p => p.active);
  if (step === "msg_open" || step === "msg_reminder") {
    const kind = step === "msg_open" ? "week_open" : "reminder";
    for (const p of active.filter(x => x.type === "ft" && !answered.has(x.id)))
      await sendText(env, { player: p, kind, game, dedupe: `${game.id}:${p.id}:${kind}` }, now);
  }
  if (step === "msg_spots") {
    const open = game.cap - roster.ftPlay.length - roster.diPlay.length;
    if (open <= 0) return;
    for (const p of active.filter(x => x.type === "di" && !answered.has(x.id)))
      await sendText(env, { player: p, kind: "spots_open", game, extra: { open }, dedupe: `${game.id}:${p.id}:spots_open` }, now);
  }
}

// ---------- incoming texts (Twilio webhook) ----------
async function hmacSha1Base64(key, data) {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(data));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

/** Twilio's request signature: HMAC-SHA1 of the URL plus every POST field (sorted by name), keyed with the Auth Token. */
export async function validTwilioSignature(token, url, params, header) {
  if (!header) return false;
  const data = url + Object.keys(params).sort().map(k => k + params[k]).join("");
  const expected = await hmacSha1Base64(token, data);
  if (expected.length !== header.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ header.charCodeAt(i);
  return diff === 0;
}

const xml = s => String(s).replace(/[<>&]/g, c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]));   // element text only
const twiml = text => new Response(
  `<?xml version="1.0" encoding="UTF-8"?><Response>${text ? `<Message>${xml(text)}</Message>` : ""}</Response>`,
  { headers: { "content-type": "text/xml" } });

const STOP_WORDS = ["STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT", "REVOKE", "OPTOUT"];
const START_WORDS = ["START", "UNSTOP", "OPTIN"];
const HELP_WORDS = ["HELP", "INFO"];

/**
 * Handles POST /hooks/twilio (incoming texts) and /hooks/twilio/status
 * (delivery updates). `ctx` gives access to the app's current game.
 */
export async function handleTwilioHook(req, env, ctx, now = Date.now()) {
  const cfg = textConfig(env);
  if (!cfg.ready) return new Response("Texts aren't set up", { status: 503 });
  let params;
  try { params = Object.fromEntries((await req.formData()).entries()); }
  catch { return new Response("Expected a form-encoded Twilio request", { status: 400 }); }
  const url = new URL(req.url);
  // Check against the address Twilio was given (APP_URL), falling back to the request's own.
  const signedUrl = (cfg.appUrl || url.origin) + url.pathname + url.search;
  if (!(await validTwilioSignature(cfg.token, signedUrl, params, req.headers.get("x-twilio-signature"))))
    return new Response("Invalid signature", { status: 403 });

  if (url.pathname.endsWith("/status")) {
    if (params.MessageSid) {
      await run(env, "UPDATE messages SET status = ?, error = COALESCE(?, error), updated_at = ? WHERE twilio_sid = ?",
        params.MessageStatus || "unknown", params.ErrorCode ? `${params.ErrorCode}` : null, now, params.MessageSid);
    }
    return new Response(null, { status: 204 });
  }

  const app = cfg.appUrl || url.origin, B = brand(env).name;
  const word = String(params.Body || "").trim().toUpperCase().replace(/[^A-Z' ]/g, "").replace(/^I'?M /, "").split(/\s+/)[0];
  const p = await first(env, `SELECT ${playerCols}, is_admin, phone_verified_at FROM players WHERE phone = ? AND active = 1`, String(params.From || ""));
  // A text from this number proves the phone belongs to that player.
  if (p && !p.phone_verified_at) await run(env, "UPDATE players SET phone_verified_at = ? WHERE id = ?", now, p.id);

  // Twilio sends its own reply to these; the app only records the choice.
  if (STOP_WORDS.includes(word)) { if (p) await run(env, "UPDATE players SET opted_out_at = ? WHERE id = ?", now, p.id); return twiml(""); }
  if (START_WORDS.includes(word)) { if (p) await run(env, "UPDATE players SET text_opt_in_at = ?, opted_out_at = NULL WHERE id = ?", now, p.id); return twiml(""); }
  if (HELP_WORDS.includes(word)) return twiml("");

  if (!p) return twiml(`${B}: we don't recognize this number. Open the app with your personal link, add this number (tap your initials at the top right), then text JOIN again.`);

  if (word === "JOIN") {
    await run(env, "UPDATE players SET text_opt_in_at = ?, opted_out_at = NULL WHERE id = ?", now, p.id);
    const link = await newLink(env, p.id, app, false);
    return twiml(`${B}: hi ${firstName(p.name)}, you're set up for game texts. Your personal app link (don't share it): ${link} - When sign-ups open, reply IN or OUT. Text STOP any time to stop.`);
  }
  if (["IN", "OUT", "SPOT", "YES", "NO"].includes(word)) return twiml(withLink(await answerFromText(env, ctx, p, word, app, now), app));

  return twiml(`${B}: reply IN or OUT for the next game (drop-ins: SPOT), or use the app: ${app} - Text JOIN for a new link, STOP to stop texts.`);
}

async function answerFromText(env, ctx, p, word, app, now) {
  const game = await ctx.currentGame(env, now), B = brand(env).name;
  if (!game) return `${B}: sign-ups for the next game aren't open yet. You'll get a text when they open.`;
  if (game.status === "cancelled") return `${B}: there's no game on ${fmtDay(game.date)}.`;
  if (game.locked) return `${B}: the list is locked. Message an admin if your plans changed.`;
  const out = word === "OUT" || word === "NO";
  // Full-timers answer in/out; for drop-ins IN or SPOT means "give me a spot" and OUT withdraws.
  const answer = p.type === "ft" ? (out ? "out" : "in") : (out ? null : "requested");

  const before = (await rosterFor(env, game.id)).roster;
  await setAnswer(env, game.id, p, answer, now);
  await notifyRosterChange(env, game.id, before, p.id, now);
  const { roster: r, game: g } = await rosterFor(env, game.id);
  const taken = r.ftPlay.length + r.diPlay.length;
  if (out) return `${B}: got it, you're out for ${fmtDay(g.date)}. Thanks for letting us know!`;
  if (r.ftPlay.includes(p.id) || r.diPlay.includes(p.id)) return `${B}: got it, you're in for ${when(g)}. ${taken}/${g.cap} spots taken.`;
  const pos = r.wait.indexOf(p.id) + 1;
  if (answer === "requested" && g.priority_open) return `${B}: you're on the drop-in list (#${pos}). Spots are confirmed when full-timer priority ends, and you'll get a text if you're in.`;
  return `${B}: the game is full, so you're #${pos} on the waitlist. You'll get a text if a spot opens up.`;
}
