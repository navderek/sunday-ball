// Local-time helpers. The Worker runs in UTC; everything the group sees
// (and the weekly schedule) is in the time zone TZ, including DST changes.
export const TZ = "America/Toronto";

const fmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", hourCycle: "h23", weekday: "short",
});
const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Local wall-clock parts for a UTC timestamp. */
export function localParts(ms) {
  const o = {};
  for (const p of fmt.formatToParts(new Date(ms))) o[p.type] = p.value;
  return { y: +o.year, m: +o.month, d: +o.day, h: +o.hour % 24, mi: +o.minute, wd: WD.indexOf(o.weekday) };
}

export const ymd = (y, m, d) => `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
export const localDate = ms => { const p = localParts(ms); return ymd(p.y, p.m, p.d); };

/** Add days to a YYYY-MM-DD date (calendar arithmetic, no time zone involved). */
export function addDays(date, n) {
  const [y, m, d] = date.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return ymd(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}

/** UTC timestamp for a local date + "HH:MM" in TZ. */
export function localToUtc(date, hhmm) {
  const [y, m, d] = date.split("-").map(Number);
  const [h, mi] = hhmm.split(":").map(Number);
  const want = Date.UTC(y, m - 1, d, h, mi);
  let guess = want;
  for (let i = 0; i < 3; i++) {
    const p = localParts(guess);
    const diff = Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi) - want;
    if (!diff) break;
    guess -= diff;
  }
  return guess;
}

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
export const dayName = wd => DAY_NAMES[((wd % 7) + 7) % 7];

/** Day of the week (0 = Sunday) of a YYYY-MM-DD date. */
export function weekdayOf(date) {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}
/** Monday of the week containing `date` (weeks run Monday to Sunday). */
export const mondayOf = date => addDays(date, -((weekdayOf(date) + 6) % 7));
/** The date in the week starting `monday` that falls on weekday `wd`. */
export const dateInWeek = (monday, wd) => addDays(monday, (wd + 6) % 7);

/**
 * The default week. Each step is given as days before the game plus a local time,
 * so it follows the game if the game day changes.
 */
export const DEFAULT_SCHEDULE = {
  weekday: 0,            // Sunday
  start: "20:00",
  end: "22:00",
  cap: 15,
  open:        { before: 6, time: "09:00" },
  reminder:    { before: 3, time: "19:00" },
  priorityEnd: { before: 2, time: "18:00" },   // no longer used: priority stays on until an admin turns it off
  lock:        { before: 0, time: "19:00" },
};
export const STEP_LABELS = {
  open: "Week opens",
  reminder: "Reminder to no-replies",
  lock: "List locks",
};

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const mins = t => { const [h, m] = t.split(":").map(Number); return h * 60 + m; };

/** Checks a schedule; returns an error message or null. */
export function scheduleError(s) {
  if (!Number.isInteger(s.weekday) || s.weekday < 0 || s.weekday > 6) return "Pick a day of the week.";
  if (!HHMM.test(s.start) || !HHMM.test(s.end)) return "Times must look like 20:00.";
  if (mins(s.end) <= mins(s.start)) return "The game has to end after it starts, on the same day.";
  if (!Number.isInteger(s.cap) || s.cap < 6 || s.cap > 30) return "Spots must be between 6 and 30.";
  for (const k of Object.keys(STEP_LABELS)) {
    const st = s[k];
    if (!st || !Number.isInteger(st.before) || st.before < 0 || st.before > 7 || !HHMM.test(st.time)) return `Check the time for "${STEP_LABELS[k]}".`;
  }
  // Steps must happen in order, all before tip-off.
  const rel = st => -st.before * 1440 + mins(st.time);
  const order = [["open", rel(s.open)], ["reminder", rel(s.reminder)], ["lock", rel(s.lock)]];
  for (let i = 1; i < order.length; i++) {
    if (order[i][1] < order[i - 1][1]) return `"${STEP_LABELS[order[i][0]]}" has to come after "${STEP_LABELS[order[i - 1][0]]}".`;
  }
  if (rel(s.lock) > mins(s.start)) return "The list has to lock before tip-off.";
  if (rel(s.open) < -7 * 1440) return "The week can open at most 7 days before the game.";
  return null;
}

/** UTC timestamps of every step for a game on `date` from `start` to `end`. */
export function computeTimes(date, start, end, s) {
  const step = st => localToUtc(addDays(date, -st.before), st.time);
  return {
    open: step(s.open), reminder: step(s.reminder), priorityEnd: step(s.priorityEnd), lock: step(s.lock),
    start: localToUtc(date, start), end: localToUtc(date, end),
  };
}

/** Season runs Sept 1 → Aug 31. */
export function seasonStart(now) {
  const p = localParts(now);
  return p.m >= 9 ? ymd(p.y, 9, 1) : ymd(p.y - 1, 9, 1);
}
