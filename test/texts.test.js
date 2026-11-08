// Text messages: Twilio signature checks, JOIN/STOP, IN/OUT/SPOT replies and
// scheduled texts, with Twilio's API replaced by a recorder.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { fakeD1 } from "./helpers.js";
import { tick, currentGame } from "../src/worker.js";
import { validTwilioSignature, handleTwilioHook } from "../src/sms.js";
import { localToUtc } from "../src/time.js";

const TOKEN = "test-auth-token";
const APP = "https://ball.example.dev";
let sent = [];
beforeEach(() => {
  sent = [];
  globalThis.fetch = async (url, opts) => {
    const f = Object.fromEntries(new URLSearchParams(opts.body));
    sent.push({ to: f.To, from: f.From, body: f.Body });
    return new Response(JSON.stringify({ sid: "SM" + sent.length, status: "queued" }), { status: 201 });
  };
});

function setup() {
  const env = fakeD1({ TWILIO_ACCOUNT_SID: "AC1", TWILIO_AUTH_TOKEN: TOKEN, TWILIO_SMS_FROM: "+16135550000", APP_URL: APP });
  env.db.exec(`INSERT INTO players (id,name,phone,type,created_at) VALUES
    (1,'Alex','+16135550101','ft',0),(2,'Ben','+16135550102','ft',0),(3,'Sam','+16135550121','di',0)`);
  env.db.exec(`INSERT INTO settings VALUES ('texts','{"enabled":true}')`);
  return env;
}
const sign = (url, params) => createHmac("sha1", TOKEN).update(url + Object.keys(params).sort().map(k => k + params[k]).join("")).digest("base64");
async function hook(env, params, now, { badSig = false } = {}) {
  const url = `${APP}/hooks/twilio`;
  const req = new Request(url, { method: "POST", body: new URLSearchParams(params), headers: { "x-twilio-signature": badSig ? "nope" : sign(url, params) } });
  const res = await handleTwilioHook(req, env, { currentGame }, now);
  return { status: res.status, text: await res.text() };
}
const at = (d, t) => localToUtc(d, t);
const isGsm = s => /^[\x20-\x7E\n]*$/.test(s);   // plain characters keep texts to one cheap segment type

test("signature check matches Twilio's algorithm", async () => {
  const p = { Body: "JOIN", From: "+16135550101", To: "+16135550000" };
  assert.equal(await validTwilioSignature(TOKEN, `${APP}/hooks/twilio`, p, sign(`${APP}/hooks/twilio`, p)), true);
  assert.equal(await validTwilioSignature(TOKEN, `${APP}/hooks/twilio`, { ...p, Body: "STOP" }, sign(`${APP}/hooks/twilio`, p)), false);
});

test("JOIN opts in and replies with a personal link; STOP is recorded; strangers and forgeries are turned away", async () => {
  const env = setup();
  const now = at("2026-11-03", "12:00");
  const r = await hook(env, { From: "+16135550101", Body: "join" }, now);
  assert.match(r.text, /https:\/\/ball\.example\.dev\/p\/[A-Za-z0-9_-]+/);
  assert.ok(env.db.prepare("SELECT text_opt_in_at FROM players WHERE id=1").get().text_opt_in_at);
  const stop = await hook(env, { From: "+16135550101", Body: "STOP" }, now + 1);
  assert.doesNotMatch(stop.text, /<Message>/, "Twilio sends its own STOP reply");
  assert.ok(env.db.prepare("SELECT opted_out_at FROM players WHERE id=1").get().opted_out_at);
  assert.match((await hook(env, { From: "+19995550000", Body: "JOIN" }, now)).text, /we don't recognize this number/);
  assert.equal((await hook(env, { From: "+16135550101", Body: "JOIN" }, now, { badSig: true })).status, 403);
});

test("week-open text goes once to opted-in full-timers, and replying IN answers", async () => {
  const env = setup();
  env.db.exec(`UPDATE players SET text_opt_in_at = 1`);
  env.db.exec(`UPDATE players SET opted_out_at = 2 WHERE id = 2`);   // Ben stopped texts
  await tick(env, at("2026-11-02", "08:00"));
  assert.equal(sent.length, 0, "nothing before the week opens");
  await tick(env, at("2026-11-02", "09:00"));
  assert.deepEqual(sent.map(m => m.to), ["+16135550101"]);
  assert.match(sent[0].body, /sign-ups are open for Sun, Nov 8, 8-10 PM\. Reply IN or OUT/);
  assert.ok(isGsm(sent[0].body));
  await tick(env, at("2026-11-02", "09:15"));
  assert.equal(sent.length, 1, "not sent twice");

  const r = await hook(env, { From: "+16135550101", Body: "I'm in!" }, at("2026-11-02", "09:20"));
  assert.match(r.text, /you're in for Sun, Nov 8, 8-10 PM\. 1\/15 spots taken/);
  assert.match(r.text, /App: https:\/\/ball\.example\.dev/, "replies link to the app");
  assert.equal(env.db.prepare("SELECT answer FROM signups WHERE player_id = 1").get().answer, "in");
  await hook(env, { From: "+16135550101", Body: "out" }, at("2026-11-02", "09:25"));
  assert.equal(env.db.prepare("SELECT answer FROM signups WHERE player_id = 1").get().answer, "out");
});

test("a drop-in replying SPOT before the week opens is told to wait; priority stays on until an admin turns it off", async () => {
  const env = setup();
  env.db.exec(`UPDATE players SET text_opt_in_at = 1`);
  await tick(env, at("2026-11-02", "08:00"));   // the Nov 1 game is over; Nov 8 opens at 9 AM
  assert.match((await hook(env, { From: "+16135550121", Body: "spot" }, at("2026-11-02", "08:00"))).text, /aren't open yet/);
  await tick(env, at("2026-11-03", "10:00"));
  const r = await hook(env, { From: "+16135550121", Body: "SPOT" }, at("2026-11-03", "10:00"));
  assert.match(r.text, /drop-in list \(#1\)/);
  sent = [];
  await tick(env, at("2026-11-07", "18:00"));
  assert.equal(sent.length, 0, "no automatic 'you're in' on Friday any more");
  assert.equal(env.db.prepare("SELECT priority_open FROM games WHERE date='2026-11-08'").get().priority_open, 1);
});

test("nothing is sent while texts are turned off", async () => {
  const env = setup();
  env.db.exec(`UPDATE players SET text_opt_in_at = 1; UPDATE settings SET value='{"enabled":false}' WHERE key='texts'`);
  await tick(env, at("2026-11-02", "09:00"));
  assert.equal(sent.length, 0);
});

test("toggling in and out can't make the app text a drop-in over and over", async () => {
  const env = setup();
  env.db.exec(`UPDATE players SET text_opt_in_at = 1`);
  await tick(env, at("2026-11-03", "10:00"));
  const g = env.db.prepare("SELECT id FROM games WHERE date='2026-11-08'").get().id;
  env.db.exec(`UPDATE games SET priority_open = 0, cap = 2 WHERE id = ${g}`);
  env.db.exec(`INSERT INTO signups VALUES (${g},1,'in',1),(${g},3,'requested',2)`);   // Ben out of the picture; Sam has the 2nd spot
  sent = [];
  let t = at("2026-11-03", "11:00");
  for (let i = 0; i < 10; i++) {                       // Ben flips in and out ten times
    await hook(env, { From: "+16135550102", Body: i % 2 ? "OUT" : "IN" }, t); t += 1000;
  }
  const toSam = sent.filter(m => m.to === "+16135550121");
  assert.ok(toSam.length <= 1, `Sam got ${toSam.length} texts`);
});
