// The rules for who plays. Nothing about the 15-spot list is stored: it's
// worked out from the sign-ups every time.
//   1. Full-timers who said "in" come first, in the order they answered.
//   2. While full-timer priority is on, drop-ins wait (they're "pending").
//   3. After that, drop-ins fill open spots in the order they asked.
//   4. Everyone left over is on the waitlist.
export function computeRoster(game, players, signups) {
  const ans = new Map(signups.map(s => [s.player_id, s]));
  const active = players.filter(p => p.active);
  const byTime = (a, b) => ans.get(a.id).answered_at - ans.get(b.id).answered_at || a.id - b.id;

  const ft = active.filter(p => p.type === "ft");
  const ftIn = ft.filter(p => ans.get(p.id)?.answer === "in").sort(byTime);
  const ftPlay = ftIn.slice(0, game.cap);
  const ftOver = ftIn.slice(game.cap);

  const reqs = active.filter(p => p.type === "di" && ans.get(p.id)?.answer === "requested").sort(byTime);
  const open = Math.max(0, game.cap - ftPlay.length);
  const diPlay = game.priority_open ? [] : reqs.slice(0, open);
  const diWait = game.priority_open ? reqs : reqs.slice(open);

  const ids = arr => arr.map(p => p.id);
  return {
    ftPlay: ids(ftPlay),
    diPlay: ids(diPlay),
    wait: ids([...ftOver, ...diWait]),
    out: ids(ft.filter(p => ans.get(p.id)?.answer === "out")),
    none: ids(ft.filter(p => !ans.has(p.id))),
  };
}
