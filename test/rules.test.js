import { test } from "node:test";
import assert from "node:assert/strict";
import { computeRoster } from "../src/roster.js";
import { computeTimes, scheduleError, mondayOf, dateInWeek, DEFAULT_SCHEDULE } from "../src/time.js";

const P = (id, type) => ({ id, type, active: 1 });
const players = [...Array(13)].map((_, i) => P(i + 1, "ft")).concat([...Array(6)].map((_, i) => P(20 + i, "di")));
const S = (player_id, answer, answered_at) => ({ player_id, answer, answered_at });

test("full-timers first, drop-ins fill the rest in order, extras wait", () => {
  const signups = [...Array(11)].map((_, i) => S(i + 1, "in", i)).concat([S(12, "out", 50)],
    [20, 21, 22, 23, 24].map((id, i) => S(id, "requested", 100 + i)));
  const r = computeRoster({ cap: 15, priority_open: 0 }, players, signups);
  assert.equal(r.ftPlay.length, 11);
  assert.deepEqual(r.diPlay, [20, 21, 22, 23]);
  assert.deepEqual(r.wait, [24]);
  assert.deepEqual(r.none, [13]);
  assert.deepEqual(r.out, [12]);
});

test("during priority, drop-ins are all pending", () => {
  const r = computeRoster({ cap: 15, priority_open: 1 }, players, [S(1, "in", 1), S(20, "requested", 2)]);
  assert.deepEqual(r.diPlay, []);
  assert.deepEqual(r.wait, [20]);
});

test("a late full-timer bumps the last drop-in", () => {
  const signups = [...Array(11)].map((_, i) => S(i + 1, "in", i)).concat(
    [20, 21, 22, 23].map((id, i) => S(id, "requested", 100 + i)), [S(13, "in", 999)]);
  const r = computeRoster({ cap: 15, priority_open: 0 }, players, signups);
  assert.equal(r.ftPlay.length, 12);
  assert.deepEqual(r.diPlay, [20, 21, 22]);
  assert.deepEqual(r.wait, [23]);
});

test("schedule follows local time across daylight saving", () => {
  // Oct 25 2026 is EDT (UTC-4); Nov 8 2026 is EST (UTC-5).
  assert.equal(new Date(computeTimes("2026-10-25", "20:00", "22:00", DEFAULT_SCHEDULE).start).toISOString(), "2026-10-26T00:00:00.000Z");
  assert.equal(new Date(computeTimes("2026-11-08", "20:00", "22:00", DEFAULT_SCHEDULE).start).toISOString(), "2026-11-09T01:00:00.000Z");
  assert.equal(new Date(computeTimes("2026-11-08", "20:00", "22:00", DEFAULT_SCHEDULE).open).toISOString(), "2026-11-02T14:00:00.000Z");
});

test("schedule checks", () => {
  assert.equal(scheduleError(DEFAULT_SCHEDULE), null);
  assert.match(scheduleError({ ...DEFAULT_SCHEDULE, end: "19:00" }), /end after it starts/);
  assert.match(scheduleError({ ...DEFAULT_SCHEDULE, lock: { before: 0, time: "21:00" } }), /before tip-off/);
  assert.match(scheduleError({ ...DEFAULT_SCHEDULE, reminder: { before: 6, time: "08:00" } }), /has to come after/);
  assert.equal(scheduleError({ ...DEFAULT_SCHEDULE, weekday: 6, start: "19:00", end: "21:00" }), null);
  assert.equal(mondayOf("2026-11-08"), "2026-11-02");
  assert.equal(dateInWeek("2026-11-02", 6), "2026-11-07");
});
