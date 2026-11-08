// Players manage their own numbers; admins never receive anyone's number.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { fakeD1 } from "./helpers.js";
import worker from "../src/worker.js";

const APP = "https://ball.example.dev";
function setup() {
  const env = fakeD1({ TWILIO_ACCOUNT_SID: "AC1", TWILIO_AUTH_TOKEN: "t", TWILIO_SMS_FROM: "+16135550000", APP_URL: APP });
  env.db.exec(`INSERT INTO players (id,name,phone,type,is_admin,created_at) VALUES
    (1,'Admin','+16135550101','ft',1,0),(2,'Ben','+16135550102','ft',0,0)`);
  for (const [id, sid] of [[1, "admin-session"], [2, "ben-session"]])
    env.db.exec(`INSERT INTO sessions VALUES ('${createHash("sha256").update(sid).digest("hex")}', ${id}, 0, ${Date.now()})`);
  return env;
}
const call = async (env, sid, path, body) => {
  const r = await worker.fetch(new Request(APP + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { cookie: `sb_session=${sid}`, "content-type": "application/json", origin: APP },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), env);
  return { status: r.status, data: await r.json() };
};

test("admins get no phone numbers, only whether texts are on", async () => {
  const env = setup();
  const { data } = await call(env, "admin-session", "/api/state");
  const ben = data.players.find(p => p.id === 2);
  assert.equal(ben.phone, undefined);
  assert.equal(JSON.stringify(data).includes("+16135550102"), false, "Ben's number appears nowhere in the admin's data");
  assert.equal(data.me.phone, undefined, "not even their own full number is sent");
  assert.equal(data.me.phone_last4, "0101");
});

test("admins can't set someone's number", async () => {
  const env = setup();
  const r = await call(env, "admin-session", "/api/admin/players/2", { phone: "613-555-9999" });
  assert.equal(r.status, 403);
});

test("a player's new number needs confirming before texts can be turned on", async () => {
  const env = setup();
  let r = await call(env, "ben-session", "/api/me/phone", { phone: "613 555 0177" });
  assert.equal(r.data.me.phone_last4, "0177");
  assert.equal(r.data.me.phone_verified, false);
  r = await call(env, "ben-session", "/api/me/texts", { on: true });
  assert.equal(r.status, 409);
  assert.match(r.data.error, /JOIN/);
  r = await call(env, "ben-session", "/api/me/phone", { phone: "+16135550101" });
  assert.equal(r.status, 409, "can't take another player's number");
});

test("the welcome shows once", async () => {
  const env = setup();
  assert.equal((await call(env, "ben-session", "/api/state")).data.me.show_intro, true);
  await call(env, "ben-session", "/api/me/intro", {});
  assert.equal((await call(env, "ben-session", "/api/state")).data.me.show_intro, false);
});

test("when an admin turns priority off, placed drop-ins and other drop-ins get texts", async () => {
  const env = setup();
  const sent = [];
  globalThis.fetch = async (url, opts) => { const f = Object.fromEntries(new URLSearchParams(opts.body)); sent.push(f); return new Response(JSON.stringify({ sid: "SM" + sent.length, status: "queued" }), { status: 201 }); };
  env.db.exec(`INSERT INTO players (id,name,phone,type,created_at,text_opt_in_at) VALUES (3,'Sam','+16135550121','di',0,1),(4,'Tom','+16135550122','di',0,1)`);
  env.db.exec(`INSERT INTO settings VALUES ('texts','{"enabled":true}')`);
  const st = (await call(env, "admin-session", "/api/state")).data;   // creates this week's game
  const gid = st.game.id;
  env.db.exec(`UPDATE games SET opens_at = 0 WHERE id = ${gid}; INSERT INTO signups VALUES (${gid},3,'requested',1)`);
  const r = await call(env, "admin-session", "/api/admin/game", { priority_open: false });
  assert.equal(r.status, 200);
  assert.ok(sent.some(m => m.To === "+16135550121" && /you're in/.test(m.Body)), "Sam, who asked, is told he's in");
  assert.ok(sent.some(m => m.To === "+16135550122" && /Reply SPOT/.test(m.Body)), "Tom hears spots are open");
});

test("players can rename themselves", async () => {
  const env = setup();
  const r = await call(env, "ben-session", "/api/me/name", { name: "  Benny   B " });
  assert.equal(r.data.me.name, "Benny B");
  assert.equal((await call(env, "ben-session", "/api/me/name", { name: "" })).status, 400);
});

test("profile pictures: avatars, photos, and admins can remove them", async () => {
  const env = setup();
  let r = await call(env, "ben-session", "/api/me/avatar", { kind: "emoji", emoji: "🏀" });
  assert.equal(r.data.me.avatar_kind, "emoji");
  assert.equal((await call(env, "ben-session", "/api/me/avatar", { kind: "emoji", emoji: "💩" })).status, 400, "only the built-in avatars");
  const jpeg = "data:image/jpeg;base64," + Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString("base64");
  r = await call(env, "ben-session", "/api/me/avatar", { kind: "photo", data: jpeg });
  assert.equal(r.data.me.avatar_kind, "photo");
  const admin = (await call(env, "admin-session", "/api/state")).data;
  assert.equal(JSON.stringify(admin).includes("base64"), false, "photos aren't stuffed into the roster");
  const img = await worker.fetch(new Request(`${APP}/api/avatar/2?v=1`, { headers: { cookie: "sb_session=admin-session" } }), env);
  assert.equal(img.status, 200);
  assert.equal(img.headers.get("content-type"), "image/jpeg");
  const noAuth = await worker.fetch(new Request(`${APP}/api/avatar/2?v=1`), env);
  assert.equal(noAuth.status, 401, "signed-in players only");
  r = await call(env, "admin-session", "/api/admin/players/2", { avatar_reset: true });
  assert.equal(r.data.players.find(p => p.id === 2).avatar_kind, null);
});

test("WhatsApp DMs: admins only learn yes/no; the number comes back only from a tap", async () => {
  const env = setup();
  let ben = (await call(env, "admin-session", "/api/state")).data.players.find(p => p.id === 2);
  assert.equal(ben.wa_dm, false, "off by default");
  let link = (await call(env, "admin-session", "/api/admin/wa-link", { player_id: 2, text: "Hi" })).data;
  assert.equal(link.url, "https://wa.me/?text=Hi", "no number until they opt in");
  await call(env, "ben-session", "/api/me/whatsapp", { ok: true, wa_phone: "613-555-0199" });
  const state = (await call(env, "admin-session", "/api/state")).data;
  assert.equal(state.players.find(p => p.id === 2).wa_dm, true);
  assert.equal(/0199|0102/.test(JSON.stringify(state)), false, "no number anywhere in the admin's data");
  link = (await call(env, "admin-session", "/api/admin/wa-link", { player_id: 2, text: "Are you in?" })).data;
  assert.equal(link.url, "https://wa.me/16135550199?text=Are%20you%20in%3F");
  assert.equal((await call(env, "ben-session", "/api/admin/wa-link", { player_id: 1, text: "x" })).status, 403, "admins only");
});

test("drop-ins are charged when the game ends; admins record payments; players see only their own balance", async () => {
  const env = setup();
  env.db.exec(`INSERT INTO players (id,name,type,created_at) VALUES (3,'Sam','di',0)`);
  env.db.exec(`INSERT INTO sessions VALUES ('${createHash("sha256").update("sam-session").digest("hex")}', 3, 0, ${Date.now()})`);
  const st = (await call(env, "admin-session", "/api/state")).data;
  const g = st.game;
  env.db.exec(`UPDATE games SET priority_open = 0, opens_at = 0, ends_at = ${Date.now() - 1000} WHERE id = ${g.id}; INSERT INTO signups VALUES (${g.id},1,'in',1),(${g.id},3,'requested',2)`);
  let sam = (await call(env, "sam-session", "/api/state")).data;   // ending the game happens on this load
  assert.deepEqual(sam.owed, { cents: 1200, games: 1 });
  assert.equal(sam.payments, undefined, "players never get the payments list");
  const admin = (await call(env, "admin-session", "/api/state")).data;
  assert.equal(admin.payments.charges.length, 1, "only the drop-in is charged");
  assert.equal(admin.owed.cents, 0, "full-timers owe nothing");
  await call(env, "admin-session", `/api/admin/charges/${g.id}/3`, { paid: true });
  sam = (await call(env, "sam-session", "/api/state")).data;
  assert.equal(sam.owed.cents, 0);
  assert.equal((await call(env, "admin-session", "/api/admin/fees", { dropin: 15 })).data.payments.fee_cents, 1500);
});

test("announcements, gym info and the calendar feed", async () => {
  const env = setup();
  let r = await call(env, "admin-session", "/api/admin/announcement", { text: "Side door tonight", until_game_end: false });
  assert.equal(r.data.announcement.text, "Side door tonight");
  assert.equal((await call(env, "ben-session", "/api/state")).data.announcement.text, "Side door tonight");
  assert.equal((await call(env, "ben-session", "/api/admin/announcement", { text: "x" })).status, 403);
  r = await call(env, "admin-session", "/api/admin/announcement", { clear: true });
  assert.equal(r.data.announcement, null);
  assert.equal(r.data.venue.address, "", "no gym is built in; admins fill it in");
  r = await call(env, "admin-session", "/api/admin/venue", { name: "Riverside High School", address: "100 Example St, Springfield", notes: "Side door" });
  assert.equal(r.data.venue.name, "Riverside High School");
  const ics = await worker.fetch(new Request(`${APP}/cal/games.ics`), env);
  assert.equal(ics.status, 200);
  const body = (await ics.text()).replace(/\r\n /g, "");   // unwrap folded lines
  assert.match(body, /BEGIN:VCALENDAR/);
  assert.match(body, /LOCATION:Riverside High School\\, 100 Example St\\, Springfield/);
  assert.equal(/Admin|Ben/.test(body), false, "no player names in the public feed");
});

test("gym photo: none by default; admins can upload or remove one", async () => {
  const env = setup();
  let v = (await call(env, "ben-session", "/api/state")).data.venue;
  assert.equal(v.photo_url, null);
  const jpeg = "data:image/jpeg;base64," + Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString("base64");
  v = (await call(env, "admin-session", "/api/admin/venue-photo", { action: "upload", data: jpeg })).data.venue;
  assert.match(v.photo_url, /^\/api\/venue-photo\?v=\d+$/);
  const img = await worker.fetch(new Request(`${APP}/api/venue-photo?v=1`, { headers: { cookie: "sb_session=ben-session" } }), env);
  assert.equal(img.headers.get("content-type"), "image/jpeg");
  assert.equal((await call(env, "admin-session", "/api/admin/venue-photo", { action: "remove" })).data.venue.photo_url, null);
  assert.equal((await call(env, "ben-session", "/api/admin/venue-photo", { action: "remove" })).status, 403);
});

test("the calendar feed answers HEAD checks as a calendar", async () => {
  const env = setup();
  const r = await worker.fetch(new Request(`${APP}/cal/games.ics`, { method: "HEAD" }), env);
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type"), /^text\/calendar/);
});

test("the sign-in is renewed for another 400 days when the app is used", async () => {
  const env = setup();
  env.db.exec(`UPDATE sessions SET last_seen = ${Date.now() - 2 * 3600_000}`);   // last used two hours ago
  const r = await worker.fetch(new Request(`${APP}/api/state`, { headers: { cookie: "sb_session=ben-session" } }), env);
  assert.match(r.headers.get("set-cookie") || "", /sb_session=ben-session; Path=\/; Max-Age=34560000; HttpOnly; Secure; SameSite=Lax/);
  const again = await worker.fetch(new Request(`${APP}/api/state`, { headers: { cookie: "sb_session=ben-session" } }), env);
  assert.equal(again.headers.get("set-cookie"), null, "not re-sent on every request, only once an hour");
});

test("link previews don't sign anyone in; old sessions expire", async () => {
  const env = setup();
  const code = "previewtestcode1234567";
  env.db.exec(`UPDATE players SET link_hash = '${createHash("sha256").update(code).digest("hex")}' WHERE id = 2`);
  const before = env.db.prepare("SELECT COUNT(*) n FROM sessions").get().n;
  const r = await worker.fetch(new Request(`${APP}/p/${code}`, { headers: { "user-agent": "WhatsApp/2.23.20.0 A" } }), env);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("set-cookie"), null);
  assert.equal(env.db.prepare("SELECT COUNT(*) n FROM sessions").get().n, before, "no session for the preview robot");
  env.db.exec("UPDATE sessions SET last_seen = 1, created_at = 1 WHERE player_id = 2");   // unused for years
  assert.equal((await call(env, "ben-session", "/api/state")).status, 401);
});

test("bad image data is rejected", async () => {
  const env = setup();
  const r = await call(env, "ben-session", "/api/me/avatar", { kind: "photo", data: "data:image/jpeg;base64,@@@@" });
  assert.equal(r.status, 400);
});
