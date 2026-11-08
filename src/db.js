// Shared database and helper functions used by the app, the scheduler and WhatsApp.
export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export const fail = (status, message) => { throw new HttpError(status, message); };

// ---------- small helpers ----------
export async function sha256(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}
export function randomCode(bytes = 18) {
  const a = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...a)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export function normalizePhone(raw) {
  const d = String(raw || "").replace(/\D/g, "");
  if (!d) return null;
  if (d.length === 10) return "+1" + d;
  if (d.length === 11 && d[0] === "1") return "+" + d;
  if (d.length >= 8 && d.length <= 15) return "+" + d;
  fail(400, "That phone number doesn't look right. Use a 10-digit number like 613-555-0123.");
}

export const all = async (env, sql, ...p) => (await env.DB.prepare(sql).bind(...p).all()).results;
export const first = (env, sql, ...p) => env.DB.prepare(sql).bind(...p).first();
export const run = (env, sql, ...p) => env.DB.prepare(sql).bind(...p).run();
export const audit = (env, actor, action, detail) =>
  run(env, "INSERT INTO audit_log (actor_id, action, detail, at) VALUES (?,?,?,?)", actor?.id ?? null, action, detail ?? null, Date.now());

export async function setAnswer(env, gameId, player, answer, now = Date.now()) {
  if (answer == null) return run(env, "DELETE FROM signups WHERE game_id = ? AND player_id = ?", gameId, player.id);
  const ok = player.type === "ft" ? ["in", "out"] : ["requested"];
  if (!ok.includes(answer)) fail(400, player.type === "ft" ? "Full-timers answer in or out." : "Drop-ins can only ask for a spot.");
  // Keep the original time when re-sending the same answer, so nobody loses their place.
  await run(env,
    `INSERT INTO signups (game_id, player_id, answer, answered_at) VALUES (?,?,?,?)
     ON CONFLICT (game_id, player_id) DO UPDATE SET
       answered_at = CASE WHEN signups.answer = excluded.answer THEN signups.answered_at ELSE excluded.answered_at END,
       answer = excluded.answer`,
    gameId, player.id, answer, now);
}

export async function newLink(env, playerId, origin, signOut) {
  const code = randomCode();
  await run(env, "UPDATE players SET link_hash = ? WHERE id = ?", await sha256(code), playerId);
  if (signOut) await run(env, "DELETE FROM sessions WHERE player_id = ?", playerId);
  return `${origin}/p/${code}`;
}

