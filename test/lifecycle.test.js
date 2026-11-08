// Runs the weekly lifecycle and schedule changes against a real SQLite database
// at simulated local times, using Node's built-in sqlite as a stand-in for D1.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeD1 as makeD1 } from "./helpers.js";
import { tick, updateSchedule, updateGame } from "../src/worker.js";
import { localToUtc } from "../src/time.js";

function fakeD1() {
  const env = makeD1();
  env.db.exec(`INSERT INTO players (id,name,type,is_admin,created_at) VALUES (1,'A','ft',1,0),(2,'B','di',0,0),(3,'C','di',0,0)`);
  return env;
}
const at = (d, t) => localToUtc(d, t);
const game = (env, date) => env.db.prepare("SELECT * FROM games WHERE date = ?").get(date);
const dates = env => env.db.prepare("SELECT date FROM games WHERE finished_at IS NULL ORDER BY starts_at").all().map(r => r.date);
const ME = { id: 1 };

test("plans 10 weeks ahead and runs a week start to finish exactly once", async () => {
  const env = fakeD1();
  await tick(env, at("2026-11-02", "08:00"));
  assert.equal(dates(env).length, 10);
  assert.deepEqual(dates(env).slice(0, 2), ["2026-11-08", "2026-11-15"]);
  const g = game(env, "2026-11-08");
  assert.equal(g.opens_at, at("2026-11-02", "09:00"));
  env.db.exec(`INSERT INTO signups VALUES (${g.id},1,'in',1),(${g.id},2,'requested',2),(${g.id},3,'requested',3)`);

  await tick(env, at("2026-11-07", "18:00"));
  assert.equal(game(env, "2026-11-08").priority_open, 1, "full-timer priority stays on until an admin turns it off");
  env.db.exec(`UPDATE games SET priority_open = 0 WHERE id = ${g.id}`);   // an admin turned it off
  await tick(env, at("2026-11-07", "18:15"));
  assert.equal(game(env, "2026-11-08").priority_open, 0, "and the schedule never turns it back on");

  await tick(env, at("2026-11-08", "19:00"));
  assert.equal(game(env, "2026-11-08").locked, 1, "locks Sunday 7 PM");
  await tick(env, at("2026-11-08", "22:00"));
  assert.ok(game(env, "2026-11-08").finished_at);
  assert.equal(env.db.prepare("SELECT COUNT(*) n FROM attendance").get().n, 3);
  await tick(env, at("2026-11-08", "22:15"));
  assert.equal(env.db.prepare("SELECT COUNT(*) n FROM attendance").get().n, 3, "no double counting");
  assert.equal(dates(env).length, 9, "planning rolls forward week by week (10 calendar weeks incl. this one)");
});

test("a skipped date counts no attendance", async () => {
  const env = fakeD1();
  await tick(env, at("2026-11-02", "10:00"));
  const g = game(env, "2026-11-08");
  env.db.exec(`INSERT INTO signups VALUES (${g.id},1,'in',1)`);
  await updateGame(env, ME, g.id, { status: "cancelled", note: "Gym closed" }, at("2026-11-02", "10:00"));
  assert.equal(game(env, "2026-11-08").note, "Gym closed");
  await tick(env, at("2026-11-08", "23:00"));
  assert.equal(env.db.prepare("SELECT COUNT(*) n FROM attendance").get().n, 0);
});

test("changing the default day moves untouched future games only", async () => {
  const env = fakeD1();
  const now = at("2026-11-03", "12:00");
  await tick(env, now);
  const skip = game(env, "2026-12-27");
  await updateGame(env, ME, skip.id, { status: "cancelled", note: "Christmas" }, now);
  await updateSchedule(env, ME, { weekday: 6, start: "19:00", end: "21:00" }, now);
  const d = dates(env);
  assert.equal(d[0], "2026-11-08", "the open game stays put");
  assert.equal(d[1], "2026-11-14", "next week moves to Saturday");
  assert.ok(d.includes("2026-12-27"), "the skipped Christmas date stays");
  const sat = game(env, "2026-11-14");
  assert.equal(sat.start_time, "19:00");
  assert.equal(sat.starts_at, at("2026-11-14", "19:00"));
  assert.equal(sat.opens_at, at("2026-11-08", "09:00"), "opens 6 days before, at 9 AM");
  await assert.rejects(updateSchedule(env, ME, { end: "18:00" }, now), /end after it starts/);
});

test("moving one game keeps its week, moves its steps, and can't jump over a neighbour", async () => {
  const env = fakeD1();
  const now = at("2026-11-08", "19:30");   // the Nov 8 list has already locked
  await tick(env, now);
  const g = game(env, "2026-11-08");
  assert.equal(g.locked, 1);
  await updateGame(env, ME, g.id, { date: "2026-11-09", start: "20:30", end: "22:30" }, now);
  const moved = env.db.prepare("SELECT * FROM games WHERE id = ?").get(g.id);
  assert.equal(moved.date, "2026-11-09");
  assert.equal(moved.custom, 1);
  assert.equal(moved.locked, 0, "the lock is undone until its new time");
  assert.equal(moved.locks_at, at("2026-11-09", "19:00"));
  await tick(env, at("2026-11-09", "08:00"));
  assert.equal(dates(env).filter(x => x === "2026-11-15").length, 1, "no extra game is created for that week");
  await assert.rejects(updateGame(env, ME, g.id, { date: "2026-11-15" }, now), /before the next game/);
  await updateGame(env, ME, g.id, { reset: true }, now);
  assert.equal(env.db.prepare("SELECT date, custom FROM games WHERE id = ?").get(g.id).date, "2026-11-08");
});
