// Sunday Ball: the app's screens, driven by /api/state.
// The group's name, from the page (a deployment can set its own: see src/brand.js).
const GROUP = document.querySelector('meta[name="application-name"]')?.content || "Sunday Ball";
const TZ = "America/Toronto";
const $ = id => document.getElementById(id);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const ini = n => esc(String(n).split(/[\s-]+/).filter(Boolean).map(s => s[0]).join("").slice(0, 2).toUpperCase());

let D = null;                       // latest state from the server

// Profile pictures: an uploaded photo, a built-in avatar (emoji), or initials.
function avInner(p) {
  if (!p) return "";
  if (p.avatar_kind === "photo" && p.avatar_v) return `<img src="/api/avatar/${p.id}?v=${p.avatar_v}" alt="" loading="lazy" decoding="async">`;
  if (p.avatar_kind === "emoji" && p.avatar_emoji) return `<span class="emo">${esc(p.avatar_emoji)}</span>`;
  return ini(p.name);
}
const avatarHTML = (p, extra = "") => `<div class="avatar ${p?.type === "ft" ? "ft" : p?.type === "di" ? "di" : ""} ${p?.avatar_kind ? "pic" : ""} ${extra}">${avInner(p)}</div>`;
const meP = () => ({ ...D.me, ...(D.players.find(x => x.id === D.me.id) || {}) });
const UI = { tab: "sunday", filter: "all", sheet: null, busy: false, confirmCancel: false };
const TABS = ["sunday", "players", "season", "admin", "guide"];
const NAV_TABS = ["sunday", "players", "season", "admin"];
const ADMIN_ONLY = ["admin", "guide"];

// ---------- dates (always the group's local time) ----------
const dayFmt = new Intl.DateTimeFormat("en-CA", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" });
const fmtSunday = date => dayFmt.format(new Date(date + "T12:00:00Z")).replace(".", "");
const fmtShort = date => new Intl.DateTimeFormat("en-CA", { timeZone: "UTC", month: "short", day: "numeric" }).format(new Date(date + "T12:00:00Z")).replace(".", "");
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const weekdayOf = date => new Date(date + "T12:00:00Z").getUTCDay();
const dayOf = g => DAYS[weekdayOf(g.date)];
const fmtClock = hhmm => { const [h, m] = hhmm.split(":").map(Number); return `${h % 12 || 12}${m ? ":" + String(m).padStart(2, "0") : ""}`; };
const ampm = hhmm => (Number(hhmm.split(":")[0]) < 12 ? "AM" : "PM");
const fmtRange = (a, b) => ampm(a) === ampm(b) ? `${fmtClock(a)}–${fmtClock(b)} ${ampm(b)}` : `${fmtClock(a)} ${ampm(a)}–${fmtClock(b)} ${ampm(b)}`;
const fmtWhen = ms => new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "short", hour: "numeric", minute: "2-digit" }).format(ms).replace(":00", "");
const localDate = ms => new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(ms);
const fmtAgo = ms => {
  const m = Math.round((Date.now() - ms) / 60000);
  if (m < 1) return "just now"; if (m < 60) return m + " min ago";
  const h = Math.round(m / 60); if (h < 24) return h + " h ago";
  return Math.round(h / 24) + " d ago";
};
function daysUntil(date) {
  const a = new Date(localDate(Date.now()) + "T00:00:00Z"), b = new Date(date + "T00:00:00Z");
  return Math.round((b - a) / 86400000);
}

// ---------- server calls ----------
class SignedOut extends Error {}
async function call(path, body) {
  const opts = body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
  let r;
  try { r = await fetch(path, opts); }
  catch { throw new Error("Can't reach the app. Check your connection and try again."); }
  const data = await r.json().catch(() => ({}));
  if (r.status === 401) { D = null; renderSignedOut(); throw new SignedOut(); }
  if (!r.ok) throw new Error(data.error || "Something went wrong. Try again.");
  return data;
}

async function load() {
  try {
    D = await call("/api/state"); render();
    // First time in: offer to add a mobile number for game texts (once), after the tip-off intro.
    if (D.me.show_intro && D.texts.number && !UI.introShown && !UI.sheet && !UI.tipoff) { UI.introShown = true; openSheet({ kind: "intro" }); }
  }
  catch (e) { if (!(e instanceof SignedOut)) toast(e.message); }
}

// Run an action, show what changed for other people too.
async function act(path, body, msg) {
  if (UI.busy) return null;
  UI.busy = true;
  const before = D;
  try {
    const res = await call(path, body);
    D = res.state || res;
    render();
    if (UI.sheet) renderSheet();   // show the saved values in an open sheet
    const moved = [];
    if (before?.roster && D.roster) {
      const wasIn = new Set([...before.roster.ftPlay, ...before.roster.diPlay]);
      const nowIn = new Set([...D.roster.ftPlay, ...D.roster.diPlay]);
      D.roster.diPlay.forEach(id => { if (!wasIn.has(id) && id !== D.me.id) moved.push(name(id) + " moved into a spot"); });
      before.roster.diPlay.forEach(id => { if (!nowIn.has(id) && D.signups[id] === "requested" && id !== D.me.id) moved.push(name(id) + " moved to the waitlist"); });
    }
    const all = [typeof msg === "function" ? msg(res) : msg, ...moved].filter(Boolean);
    if (all.length) toast(all.join(" · "));
    return res;
  } catch (e) {
    if (!(e instanceof SignedOut)) toast(e.message);
    return null;
  } finally { UI.busy = false; }
}

// ---------- helpers ----------
const P = id => D.players.find(p => p.id === id);
const name = id => P(id)?.name ?? "Someone";
const isAdmin = () => D?.me.is_admin;
const playing = () => D.roster ? D.roster.ftPlay.length + D.roster.diPlay.length : 0;
let toastTimer;
function toast(msg) {
  const t = $("toast"); t.textContent = msg; t.classList.add("show");
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove("show"), 3200);
}
async function copy(text, el) {
  try { await navigator.clipboard.writeText(text); toast("Copied"); }
  catch {
    if (el) { const r = document.createRange(); r.selectNodeContents(el); const s = getSelection(); s.removeAllRanges(); s.addRange(r); }
    toast("Text selected. Copy it from your phone's menu.");
  }
}

function rowHTML(id, right = "") {
  const p = P(id); if (!p) return "";
  const me = id === D.me.id;
  const sub = [p.type === "ft" ? "Full-timer" : "Drop-in", p.is_admin ? "Admin" : null, isAdmin() && !p.signed_in ? "Not signed in yet" : null].filter(Boolean).join(" · ");
  const inner = `${avatarHTML(p)}
    <div class="name">${esc(p.name)}${me ? '<span class="you">YOU</span>' : ""}<small>${sub}</small></div>${right}`;
  if (!isAdmin()) return `<div class="row">${inner}</div>`;
  const main = `${avatarHTML(p)}
    <div class="name">${esc(p.name)}${me ? '<span class="you">YOU</span>' : ""}<small>${sub}</small></div>`;
  return `<div class="row"><button class="rowmain" data-act="sheet" data-id="${id}" aria-label="Options for ${esc(p.name)}">${main}</button>${right}</div>`;
}
const list = (title, ids, right) =>
  `<div class="list"><h4>${title}<span>${ids.length}</span></h4>${ids.length ? ids.map(id => rowHTML(id, right ? right(id) : "")).join("") : `<p class="empty">Nobody</p>`}</div>`;

// ---------- Sunday ----------
function meCard() {
  const g = D.game, me = D.me, r = D.roster;
  if (g.status === "cancelled") return cancelledBanner(g);
  const ans = D.signups[me.id];
  if (g.locked && !(me.type === "di" && !ans)) {
    const where = r.ftPlay.includes(me.id) || r.diPlay.includes(me.id) ? "You're playing." : ans === "out" ? "You're out this week." : r.wait.includes(me.id) ? `You're #${r.wait.indexOf(me.id) + 1} on the waitlist.` : "You didn't answer this week.";
    return `<div class="card mecard"><h3>The list is locked</h3><p>${where} If something changed, message an admin.</p></div>`;
  }
  if (me.type === "ft") {
    if (ans === "in") {
      if (r.wait.includes(me.id)) return `<div class="card mecard"><h3>You're in, on the waitlist <span class="pill warn">#${r.wait.indexOf(me.id) + 1}</span></h3><p>More full-timers said in than there are spots. You'll move up if someone drops.</p><div class="btnrow"><button class="btn ghost" data-act="answer" data-v="out">Can't make it</button></div></div>`;
      return `<div class="card mecard"><h3>You're in <span class="pill good">Confirmed</span></h3><p>Your spot is held. If plans change, mark yourself out so a drop-in can take it.</p><div class="btnrow"><button class="btn ghost" data-act="answer" data-v="out">Can't make it</button></div></div>`;
    }
    if (ans === "out") {
      const open = g.cap - playing();
      return `<div class="card mecard"><h3>You're out this week</h3><p>${open > 0 ? `${open === 1 ? "1 spot is" : open + " spots are"} open if you change your mind.` : "Full-timers still come first if you change your mind. The last drop-in would go to the waitlist."}</p><div class="btnrow"><button class="btn primary" data-act="answer" data-v="in">I'm in after all</button></div></div>`;
    }
    return `<div class="card mecard"><h3>Are you in ${dayOf(g)}?</h3><p>Full-timers get first dibs on all ${g.cap} spots.</p><div class="btnrow"><button class="btn primary" data-act="answer" data-v="in">I'm in</button><button class="btn ghost" data-act="answer" data-v="out">I'm out</button></div></div>`;
  }
  // drop-in
  if (ans === "requested") {
    if (r.diPlay.includes(me.id)) return `<div class="card mecard"><h3>You're playing <span class="pill good">Confirmed</span></h3><p>You got a drop-in spot. Withdraw if you can't make it so the next person moves up.</p><div class="btnrow"><button class="btn ghost" data-act="answer" data-v="">Withdraw</button></div></div>`;
    const w = r.wait.indexOf(me.id) + 1;
    if (g.priority_open) return `<div class="card mecard"><h3>You're on the drop-in list <span class="pill warn">#${w}</span></h3><p>Full-timers have first dibs. If spots are left, the admins open them to drop-ins and you're placed in sign-up order.</p><div class="btnrow"><button class="btn ghost" data-act="answer" data-v="">Take my name off</button></div></div>`;
    return `<div class="card mecard"><h3>You're on the waitlist <span class="pill warn">#${w}</span></h3><p>You'll move up automatically if someone drops. Check back before ${dayOf(g)}.</p><div class="btnrow"><button class="btn ghost" data-act="answer" data-v="">Leave waitlist</button></div></div>`;
  }
  if (g.locked) return `<div class="card mecard"><h3>Sign-ups are closed</h3><p>The list is locked for this week.</p></div>`;
  if (g.priority_open) return `<div class="card mecard"><h3>Want to drop in?</h3><p>Full-timers have first dibs. Add your name now: if the admins open spots to drop-ins, you're placed in sign-up order.</p><div class="btnrow"><button class="btn dark" data-act="answer" data-v="requested">Add me to the list</button></div></div>`;
  const open = g.cap - playing();
  if (open > 0) return `<div class="card mecard"><h3>${open} spot${open > 1 ? "s" : ""} open</h3><p>Full-timer priority is over. First come, first served.</p><div class="btnrow"><button class="btn primary" data-act="answer" data-v="requested">Grab a spot</button></div></div>`;
  return `<div class="card mecard"><h3>Game is full</h3><p>All ${g.cap} spots are taken. Join the waitlist and you'll move up if anyone drops.</p><div class="btnrow"><button class="btn dark" data-act="answer" data-v="requested">Join the waitlist</button></div></div>`;
}

function cancelledBanner(g) {
  const next = D.upcoming.slice(1).find(x => x.status === "open");
  return `<div class="banner"><strong>No game ${dayOf(g)}, ${fmtShort(g.date)}${g.note ? ` (${esc(g.note)})` : ""}.</strong> ${next ? `Next game: ${fmtSunday(next.date)}, ${fmtRange(next.start_time, next.end_time)}. Sign-ups open ${fmtWhen(next.opens_at)}.` : ""}</div>`;
}

const fmtPhone = n => { const d = String(n || "").replace(/\D/g, ""); return d.length === 11 && d[0] === "1" ? `+1 ${d.slice(1, 4)} ${d.slice(4, 7)} ${d.slice(7)}` : n; };

// One-tap WhatsApp: opens WhatsApp on this phone with the message written; the admin taps Send.
const waDigits = phone => String(phone || "").replace(/\D/g, "");
const waLink = (phone, text) => `https://wa.me/${phone ? waDigits(phone) : ""}?text=${encodeURIComponent(text)}`;
/**
 * A WhatsApp button for a player. Players who allow DMs get a button the server
 * turns into a direct chat link at tap time, so their number never sits in the app.
 * Everyone else gets a plain link that opens WhatsApp to pick the chat.
 */
const waButton = (id, text, label, cls = "btn ghost small wa") => P(id)?.wa_dm
  ? `<a class="${cls}" href="#" data-act="wa-dm" data-id="${id}" data-text="${esc(text)}" title="Opens a WhatsApp chat with ${esc(name(id))}">${WA_ICON}${label}</a>`
  : `<a class="${cls}" href="${waLink("", text)}" target="_blank" rel="noopener" title="Opens WhatsApp: pick them in your chats">${WA_ICON}${label}</a>`;
const WA_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3a9 9 0 0 0-7.8 13.5L3 21l4.6-1.2A9 9 0 1 0 12 3z"/><path d="M8.5 8.5c.3 2.6 2.4 5 5 5.6l1.3-1.2 1.8.9c-.2 1-1 1.7-2 1.7-3.6-.2-6.6-3.2-6.8-6.8 0-1 .7-1.8 1.7-2l.9 1.8z"/></svg>';
const nudgeText = id => `Hi ${name(id).split(" ")[0]}, are you in for ${D.game ? `${fmtSunday(D.game.date)} (${fmtRange(D.game.start_time, D.game.end_time)})` : "the next game"}? Answer here: ${location.origin}`;

const textsNumber = () => esc(fmtPhone(D.texts.number));
function myTextStatus() {
  const me = D.me;
  if (!me.has_phone) return { title: "Get game updates by text", text: "Add your mobile number to get a text when sign-ups open, and reply IN or OUT.", action: `<button class="btn dark block" data-act="me-open">Add my number</button>` };
  if (!me.phone_verified) return { title: "Confirm your number", text: `Text <b>JOIN</b> to <b>${textsNumber()}</b> from your phone (ending in ${esc(me.phone_last4)}) to confirm it and turn on game texts.`, action: "" };
  return null;
}
function textCard() {
  if (!D.texts.number) return "";
  const st = myTextStatus();
  if (st) return `<div class="card"><h3>${st.title}</h3><p style="margin-bottom:${st.action ? "12px" : "0"}">${st.text}</p>${st.action}</div>`;
  return `<div class="card"><div class="setting" style="padding:0"><div><b>Game reminders by text</b><small>${D.me.texts_on ? (D.texts.live ? "On. Reply IN or OUT to the texts to answer." : "On. Texts start once the admins switch them on.") : "Off. Turn on to get a text when sign-ups open."}</small></div>
    <button class="switch" role="switch" aria-checked="${D.me.texts_on}" aria-label="Game reminders by text" data-act="my-texts" data-v="${D.me.texts_on ? 0 : 1}"></button></div>
    <p style="margin-top:8px">Change your number any time: tap your initials at the top right.</p></div>`;
}

function comingUp() {
  const rest = D.upcoming.slice(1, 5);
  if (!rest.length) return "";
  return `<div class="list"><h4>Coming up</h4>${rest.map(x => `<div class="row"><div class="name">${fmtSunday(x.date)}<small>${x.status === "cancelled" ? `No game${x.note ? " · " + esc(x.note) : ""}` : fmtRange(x.start_time, x.end_time)}</small></div>${x.status === "cancelled" ? `<span class="pill court">Skipped</span>` : isChanged(x) ? `<span class="pill blue">Changed</span>` : ""}</div>`).join("")}</div>`;
}

// ---------- notices, gym, money, calendar ----------
const money = c => `$${(c / 100).toFixed(c % 100 ? 2 : 0)}`;
const PIN_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21s-7-6.2-7-11.5A7 7 0 0 1 19 9.5C19 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/></svg>';
const CAL_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="5" width="17" height="15" rx="2"/><path d="M3.5 10h17M8 3v4M16 3v4"/></svg>';
function announcementHTML() {
  const a = D.announcement;
  return a ? `<div class="notice" role="note"><b>Announcement</b><p>${esc(a.text)}</p><small>${esc(a.by || "Admins")} · ${fmtAgo(a.at)}</small></div>` : "";
}
function venueHTML() {
  const v = D.venue;
  if (!v || (!v.name && !v.address)) return "";
  return `<button class="venue" data-act="gym-open" aria-label="Getting there: ${esc(v.name)}">${PIN_ICON}<div><b>${esc(v.name)}</b>${v.address ? `<span>${esc(v.address)}</span>` : ""}${v.notes || v.photo_url || v.map_url ? `<em>How to get in ›</em>` : ""}</div></button>`;
}
function owedHTML() {
  const o = D.owed;
  if (!o || !o.cents) return "";
  return `<div class="card owe"><h3>You owe ${money(o.cents)}</h3><p>For ${o.games} game${o.games > 1 ? "s" : ""} as a drop-in (${money(D.dropin_fee_cents)} a game). Pay an admin by e-Transfer or cash, and they'll mark it paid.</p></div>`;
}
const calButton = () => D.game ? `<button class="btn ghost small cal" data-act="cal-open">${CAL_ICON}Add to calendar</button>` : "";

function sunday() {
  if (!D.game) return `<div class="card mecard"><h3>No games planned</h3><p>The admins haven't scheduled any upcoming games.</p></div>`;
  if (D.game.status === "cancelled") {
    return `${announcementHTML()}<div class="hero"><div class="when">This week</div><h2>${fmtSunday(D.game.date)}</h2></div>${cancelledBanner(D.game)}${owedHTML()}${comingUp()}`;
  }
  if (!D.open) {
    const g = D.game;
    return `${announcementHTML()}<div class="hero"><div class="when">Next game</div><h2>${fmtSunday(g.date)}</h2><div class="when">${fmtRange(g.start_time, g.end_time)} ET</div></div>
      <div class="herobar">${venueHTML()}${calButton()}</div>
      <div class="card mecard"><h3>Sign-ups open ${fmtWhen(D.times.open)}</h3><p>Full-timers can answer in or out from then. Drop-ins can add their name too.</p></div>${owedHTML()}${comingUp()}${textCard()}`;
  }
  const g = D.game, r = D.roster, n = playing();
  const d = daysUntil(g.date);
  const rel = d <= 0 ? "Tip-off tonight" : d === 1 ? "Tip-off tomorrow" : `Tip-off in ${d} days`;
  const status = g.status === "cancelled" ? `<span class="pill court">Cancelled</span>`
    : n >= g.cap ? `<span class="pill good">Full${r.wait.length ? ` · ${r.wait.length} waiting` : ""}</span>`
    : n >= 10 ? `<span class="pill warn">${g.cap - n} spot${g.cap - n > 1 ? "s" : ""} open</span>`
    : `<span class="pill court">Need ${10 - n} more for 5-on-5</span>`;
  const slots = [];
  r.ftPlay.forEach(id => slots.push(`<div class="slot ft ${P(id)?.avatar_kind ? "pic" : ""} ${id === D.me.id ? "me" : ""}" title="${esc(name(id))}">${avInner(P(id))}</div>`));
  r.diPlay.forEach(id => slots.push(`<div class="slot di ${P(id)?.avatar_kind ? "pic" : ""} ${id === D.me.id ? "me" : ""}" title="${esc(name(id))} (drop-in)">${avInner(P(id))}</div>`));
  for (let i = slots.length; i < g.cap; i++) slots.push(`<div class="slot open">${i + 1}</div>`);
  const prioDone = !g.priority_open;
  return `
  ${announcementHTML()}
  <div class="hero"><div class="when"><span>${rel}</span>${status}</div><h2>${fmtSunday(g.date)}</h2><div class="when">${fmtRange(g.start_time, g.end_time)} ET</div></div>
  <div class="herobar">${venueHTML()}${calButton()}</div>
  <div class="track">
    <div class="done"><b>${fmtWhen(D.times.open)}</b>Week opened</div>
    <div class="${prioDone ? "done" : "now"}"><b>${prioDone ? "Drop-ins open" : "Full-timers first"}</b>${prioDone ? "Spots open to drop-ins" : "Until admins open spots"}</div>
    <div class="${prioDone ? "now" : ""}"><b>${fmtWhen(D.times.start)}</b>Tip-off</div>
  </div>
  ${meCard()}
  ${owedHTML()}
  <div class="meter">
    <div class="holo-ring" aria-hidden="true"><span></span></div>
    <div class="meter-head"><div class="count">${n}<small> / ${g.cap}</small></div><div class="legend"><span class="l-ft">Full-time</span><span class="l-di">Drop-in</span></div></div>
    <div class="slots">${slots.join("")}</div>
  </div>
  ${list("Full-timers playing", r.ftPlay)}
  ${list("Drop-ins playing", r.diPlay)}
  ${list(g.priority_open ? "Drop-in list (placed after priority ends)" : "Waitlist", r.wait, id => `<span class="pill warn">#${r.wait.indexOf(id) + 1}</span>`)}
  ${list("No reply yet", r.none, isAdmin() ? id => P(id)?.wa_dm
    ? waButton(id, nudgeText(id), "Nudge")
    : `<button class="btn ghost small wa off" data-act="wa-off" data-id="${id}" aria-disabled="true" title="${esc(name(id))} hasn't turned on WhatsApp messages">${WA_ICON}Nudge</button>` : null)}
  ${list("Out this week", r.out)}
  ${comingUp()}
  ${textCard()}
  ${isAdmin() ? `<p class="empty">Tap a name to change their answer or send them a new link.</p>` : ""}`;
}

// ---------- Players ----------
function players() {
  const all = D.players;
  const arr = all.filter(p => UI.filter === "all" || p.type === UI.filter)
    .sort((a, b) => (a.type === b.type ? 0 : a.type === "ft" ? -1 : 1) || b.att - a.att || a.name.localeCompare(b.name));
  const nFt = all.filter(p => p.type === "ft").length;
  const games = D.season.games;
  return `
  <h3 class="sec">Players</h3>
  <div class="seg" role="group" aria-label="Filter players">
    <button data-act="filter" data-v="all" aria-pressed="${UI.filter === "all"}">All ${all.length}</button>
    <button data-act="filter" data-v="ft" aria-pressed="${UI.filter === "ft"}">Full-time ${nFt}</button>
    <button data-act="filter" data-v="di" aria-pressed="${UI.filter === "di"}">Drop-ins ${all.length - nFt}</button>
  </div>
  ${isAdmin() ? `<button class="btn dark" data-act="add-open">+ Add a player</button>` : ""}
  <div class="list"><h4>Games played this season<span>${games ? "of " + games : ""}</span></h4>
  ${arr.map(p => rowHTML(p.id, games ? `<div class="attbar"><i style="width:${Math.round(p.att / games * 100)}%"></i></div><span class="att">${p.att}/${games}</span>` : "")).join("")}
  </div>`;
}

// ---------- Season ----------
function season() {
  const h = D.season.history;
  if (!h.length) return `<h3 class="sec">Season</h3><div class="card"><h3>No games played yet</h3><p>Turnout and attendance show up here after the first game is played.</p></div>`;
  const max = Math.max(15, ...h.map(w => w.ft + w.di));
  const cols = `grid-template-columns:repeat(${h.length},1fr)`;
  const bars = h.map(w => { const t = w.ft + w.di; return `<div class="bar" title="${fmtShort(w.date)}: ${w.ft} full-time, ${w.di} drop-in"><div class="b-ft" style="height:${w.ft / max * 100}%"></div><div class="b-di" style="height:${w.di / max * 100}%"></div><span class="n" style="bottom:calc(${t / max * 100}% + 2px)">${t}</span></div>`; }).join("");
  const top = [...D.players].sort((a, b) => b.att - a.att).slice(0, 5);
  const total = h.reduce((s, w) => s + w.ft + w.di, 0);
  return `
  <h3 class="sec">Season</h3>
  <div class="stat3"><div><b>${(total / h.length).toFixed(1)}</b><span>avg players</span></div><div><b>${h.filter(w => w.ft + w.di >= 15).length}/${h.length}</b><span>games full</span></div><div><b>${h.reduce((s, w) => s + w.di, 0)}</b><span>drop-in spots used</span></div></div>
  <div class="card"><div class="list"><h4>Turnout, last ${h.length} games<span class="legend"><span class="l-ft">Full-time</span><span class="l-di">Drop-in</span></span></h4></div>
    <div class="chart" style="${cols}"><div class="cap" style="top:calc(18px + ${(1 - 15 / max) * 100}% * (152 / 170))"><span>15</span></div>${bars}</div>
    <div class="xlabels" style="${cols}">${h.map(w => `<span>${fmtShort(w.date).replace(" ", "<br>")}</span>`).join("")}</div></div>
  <div class="list"><h4>Most games played<span>of ${D.season.games}</span></h4>
  ${top.map((p, i) => `<div class="row"><span class="rank">${i + 1}</span>${avatarHTML(p)}<div class="name">${esc(p.name)}</div><span class="att">${p.att}/${D.season.games}</span></div>`).join("")}</div>`;
}

// ---------- Admin ----------
function waText() {
  const L = [`🏀 *${GROUP}*`];
  const g = D.game;
  if (!g) return [...L, `No games scheduled right now.`].join("\n");
  const when = `${fmtSunday(g.date)} · ${fmtRange(g.start_time, g.end_time)}`;
  if (g.status === "cancelled") {
    const next = D.upcoming.slice(1).find(x => x.status === "open");
    return [...L, when, ``, `❌ No game this week${g.note ? ` (${g.note})` : ""}.`, ...(next ? [`Next game: ${fmtSunday(next.date)}, ${fmtRange(next.start_time, next.end_time)}.`] : [])].join("\n");
  }
  if (!D.open) return [...L, when, ``, `Sign-ups open ${fmtWhen(D.times.open)}.`, location.origin].join("\n");
  const r = D.roster, n = playing();
  L.push(when, ``, `*Playing (${n}/${g.cap})*`);
  [...r.ftPlay, ...r.diPlay].forEach((id, i) => L.push(`${i + 1}. ${name(id)}${P(id).type === "di" ? " (drop-in)" : ""}`));
  if (n < g.cap) L.push(``, `🟠 ${g.cap - n} spot${g.cap - n > 1 ? "s" : ""} open.${g.priority_open ? "" : " Drop-ins, grab one in the app."}`);
  if (r.wait.length) L.push(``, `*${g.priority_open ? "Drop-in list" : "Waitlist"}:* ${r.wait.map(name).join(", ")}`);
  if (r.none.length) L.push(`*No reply yet:* ${r.none.map(name).join(", ")}`);
  L.push(``, `Answer in the app: ${location.origin}`);
  if (D.texts.live) L.push(`Game reminders by text: text JOIN to ${fmtPhone(D.texts.number)} (save it as a contact so the texts don't land in spam)`);
  return L.join("\n");
}

/** A game differs from the default schedule (moved, re-timed, or left over from an older default). */
const isChanged = x => !!x.custom || weekdayOf(x.date) !== D.schedule.weekday || x.start_time !== D.schedule.start || x.end_time !== D.schedule.end;

const MSG_STATUS = { queued: "warn", accepted: "warn", sending: "warn", sent: "blue", delivered: "good", read: "good", failed: "court", undelivered: "court" };
function textAdminCard() {
  const t = D.texts, a = t.admin;
  const on = D.players.filter(p => p.texts === "on").length;
  return `<div class="card">
    <div class="list"><h4>Text messages</h4></div>
    <div class="setting"><div><b>Twilio connected</b><small>${a.ready ? `Texts come from ${esc(fmtPhone(t.number))}` : "Keys and phone number not added yet"}</small></div><span class="pill ${a.ready ? "good" : "warn"}">${a.ready ? "Done" : "Not yet"}</span></div>
    ${a.problems?.length ? `<div class="banner" style="margin:8px 0">${a.problems.map(esc).join("<br>")} Re-enter it with <code>npx wrangler secret put</code>.</div>` : ""}
    <div class="setting"><div><b>Send text messages</b><small>${a.enabled ? "On. Reminders and updates go to players who turned texts on." : "Off. Nothing is sent."}</small></div>
      <button class="switch" role="switch" aria-checked="${a.enabled}" aria-label="Send text messages" data-act="texts-enabled" data-v="${a.enabled ? 0 : 1}" ${a.ready ? "" : "disabled"}></button></div>
    <div class="setting"><div><b>${on} of ${D.players.length} players</b><small>have texts turned on. Players text JOIN, or turn it on in the app.</small></div></div>
    <button class="btn ghost block" data-act="texts-test" ${a.ready ? "" : "disabled"}>Send me a test text</button>
    ${a.recent.length ? `<div class="list" style="margin-top:12px"><h4>Recent texts</h4>${a.recent.map(m => `<div class="row"><div class="name">${esc(m.name || "")}<small>${esc(a.kinds[m.kind] || m.kind)} · ${fmtAgo(m.sent_at)}${m.error ? " · " + esc(m.error) : ""}</small></div><span class="pill ${MSG_STATUS[m.status] || "warn"}">${esc(m.status)}</span></div>`).join("")}</div>` : ""}
  </div>`;
}

const stepText = k => {
  const st = D.schedule[k], wd = (D.schedule.weekday - st.before + 7) % 7;
  return `${st.before === 0 ? "Game day" : DAYS[wd].slice(0, 3)} ${fmtClock(st.time)} ${ampm(st.time)}`;
};

function announcementAdminCard() {
  const a = D.announcement;
  return `<form class="card" id="annform">
    <div class="list"><h4>Announcement</h4></div>
    <p style="margin-bottom:10px">${a ? "Showing at the top of This week for everyone." : "Post a short notice at the top of This week, like a gym change or a reminder."}</p>
    <label class="field"><textarea id="ann-text" maxlength="280" rows="3" placeholder="Gym B tonight. Use the side door.">${esc(a?.text || "")}</textarea></label>
    <label class="check"><input type="checkbox" id="ann-until" checked> Remove it automatically after the next game</label>
    <div class="btnrow" style="margin-top:10px"><button class="btn primary" type="submit">${a ? "Update" : "Post"}</button>${a ? `<button class="btn ghost" type="button" data-act="ann-clear">Remove</button>` : ""}</div>
  </form>`;
}
function paymentsAdminCard() {
  const P0 = D.payments;
  const owing = {};
  for (const c of P0.charges) if (!c.paid_at) (owing[c.player_id] ||= { name: c.player, cents: 0, games: 0 }, owing[c.player_id].cents += c.amount_cents, owing[c.player_id].games++);
  const rows = Object.entries(owing).sort((a, b) => b[1].cents - a[1].cents);
  const total = rows.reduce((t, [, o]) => t + o.cents, 0);
  return `<div class="card">
    <div class="list"><h4>Drop-in payments${total ? `<span>${money(total)} owed</span>` : ""}</h4></div>
    ${rows.length ? rows.map(([id, o]) => `<button class="row" data-act="charges-open" data-id="${id}">${avatarHTML(P(Number(id)) || { name: o.name, type: "di" })}<div class="name">${esc(o.name)}<small>${o.games} unpaid game${o.games > 1 ? "s" : ""}</small></div><span class="pill court">${money(o.cents)}</span></button>`).join("")
      : `<p class="empty">Nobody owes anything.</p>`}
    <form id="feeform" class="setting" style="margin-top:6px"><div><b>Drop-in fee</b><small>Charged to each drop-in who plays, when the game ends</small></div>
      <span class="feebox">$<input id="fee" type="number" inputmode="decimal" min="0" max="100" step="0.5" value="${(P0.fee_cents / 100).toString()}" aria-label="Drop-in fee in dollars"><button class="btn ghost small" type="submit">Save</button></span></form>
  </div>`;
}

function admin() {
  if (!isAdmin()) return `<div class="card"><h3>Admins only</h3><p>Ask an admin if you need something changed.</p></div>`;
  const g = D.game;
  const sw = (field, on, label, sub) => `<div class="setting"><div><b>${label}</b><small>${sub}</small></div><button class="switch" role="switch" aria-checked="${on}" aria-label="${label}" data-act="game" data-field="${field}" data-v="${on ? 0 : 1}"></button></div>`;
  const week = g && D.open ? `
    ${sw("priority_open", !!g.priority_open, "Full-timer priority", g.priority_open ? "On. Drop-ins wait until you turn this off" : "Off. Drop-ins can fill open spots")}
    ${sw("locked", !g.locked, "Sign-ups open", g.locked ? "Locked. Players can't change their answer" : `Players can join or drop out until ${fmtWhen(D.times.lock)}`)}
    <div class="setting"><div><b>Spots</b><small>The waitlist adjusts automatically</small></div>
      <div class="stepper"><button data-act="cap" data-v="-1" aria-label="Fewer spots">−</button><output>${g.cap}</output><button data-act="cap" data-v="1" aria-label="More spots">+</button></div></div>
    <div class="setting"><div><b>${g.status === "cancelled" ? "This game is cancelled" : "Cancel this game"}</b><small>${g.status === "cancelled" ? "Players see a no-game notice" : "Gym closed, holiday, etc."}</small></div>
      ${g.status === "cancelled" ? `<button class="btn ghost small" data-act="game" data-field="status" data-v="open">Restore</button>`
        : UI.confirmCancel ? `<span class="btnrow"><button class="btn danger small" data-act="game" data-field="status" data-v="cancelled">Cancel game</button><button class="btn ghost small" data-act="cancel-no">Keep</button></span>`
        : `<button class="btn ghost small" data-act="cancel-ask">Cancel…</button>`}</div>`
    : g ? `<p class="empty">Sign-ups for ${fmtSunday(g.date)} open ${fmtWhen(D.times.open)}. These settings appear then.</p>` : `<p class="empty">No games planned.</p>`;
  const admins = D.players.filter(p => p.is_admin);
  return `
  <h3 class="sec">Admin</h3>
  <button class="card guidelink" data-act="tab" data-v="guide"><span><b>Admin guide</b><small>How to run the group with this app</small></span><span aria-hidden="true">→</span></button>
  ${announcementAdminCard()}
  ${paymentsAdminCard()}
  <div class="card"><div class="list"><h4>This week${g ? " · " + fmtShort(g.date) : ""}</h4></div>${week}</div>
  <div class="card">
    <div class="list"><h4>Post to WhatsApp</h4></div>
    <pre class="copybox" id="wa">${esc(waText())}</pre>
    <div class="btnrow" style="margin-top:10px"><a class="btn primary wa" href="${waLink("", waText())}" target="_blank" rel="noopener">${WA_ICON}Share in WhatsApp</a><button class="btn ghost" data-act="copy-wa" style="flex:none;padding-inline:20px">Copy</button></div>
    <p class="empty" style="margin-top:8px">Opens WhatsApp with the post written. Pick the Sunday Ball group and tap Send.</p>
  </div>
  ${textAdminCard()}
  <form class="card" id="venueform">
    <div class="list"><h4>Gym info</h4></div>
    <p style="margin-bottom:10px">Shown on This week and added to calendar events.</p>
    <label class="field">Name<input id="v-name" maxlength="80" value="${esc(D.venue?.name || "")}"></label>
    <label class="field" style="margin-top:8px">Address<input id="v-address" maxlength="160" value="${esc(D.venue?.address || "")}"></label>
    <label class="field" style="margin-top:8px">How to get in (optional)<textarea id="v-notes" maxlength="1000" rows="4" placeholder="Parking, which door, house rules">${esc(D.venue?.notes || "")}</textarea></label>
    <button class="btn ghost block" type="submit" style="margin-top:10px">Save gym info</button>
    <div class="group" style="margin-top:14px"><b>Photo</b>
      ${D.venue?.photo_url ? `<img class="gymphoto" src="${esc(D.venue.photo_url)}" alt="" loading="lazy">` : `<p>No photo.</p>`}
      <div class="btnrow">
        <label class="btn ghost" for="gym-photo">${D.venue?.photo_url ? "Replace photo" : "Add a photo"}</label>
        <input id="gym-photo" type="file" accept="image/*" hidden>
        ${D.venue?.photo_url ? `<button class="btn ghost" type="button" data-act="gym-photo" data-v="remove">Remove</button>` : ""}
      </div>
    </div>
    <div class="group" style="margin-top:14px"><b>Map</b>
      ${D.venue?.map_url ? `<img class="gymmap" src="${esc(D.venue.map_url)}" alt="" loading="lazy">` : `<p>Add a screenshot of a map showing the way in, for example the route from the street to the right door.</p>`}
      <div class="btnrow">
        <label class="btn ghost" for="gym-map">${D.venue?.map_url ? "Replace map" : "Add a map"}</label>
        <input id="gym-map" type="file" accept="image/*" hidden>
        ${D.venue?.map_url ? `<button class="btn ghost" type="button" data-act="gym-map-remove">Remove</button>` : ""}
      </div>
    </div>
  </form>
  <div class="card">
    <div class="list"><h4>Default schedule</h4></div>
    <dl class="sched"><dt>Game</dt><dd>${DAYS[D.schedule.weekday]}s, ${fmtRange(D.schedule.start, D.schedule.end)}</dd><dt>Spots</dt><dd>${D.schedule.cap}</dd>${["open", "reminder", "lock"].map(k => `<dt>${D.stepLabels[k]}</dt><dd>${stepText(k)}</dd>`).join("")}</dl>
    <button class="btn ghost block" style="margin-top:12px" data-act="sched-open">Change default schedule</button>
  </div>
  <div class="card">
    <div class="list"><h4>Upcoming games<span>${D.upcoming.length}</span></h4>
    ${D.upcoming.map(x => `<button class="row" data-act="game-open" data-id="${x.id}"><div class="name">${fmtSunday(x.date)}<small>${x.status === "cancelled" ? (x.note ? esc(x.note) : "No game") : fmtRange(x.start_time, x.end_time)}</small></div>${x.status === "cancelled" ? `<span class="pill court">Skipped</span>` : isChanged(x) ? `<span class="pill blue">Changed</span>` : ""}</button>`).join("")}</div>
    <p class="empty">Tap a date to move it, change its time, or skip it.</p>
  </div>
  <div class="card">
    <div class="list"><h4>Admins<span>${admins.length}</span></h4>${admins.map(p => rowHTML(p.id)).join("")}</div>
    <p class="empty">To add an admin, tap their name on the Players screen.</p>
  </div>
  ${D.audit?.length ? `<div class="card"><div class="list"><h4>Recent changes</h4></div><div class="log">${D.audit.map(a => `<div><b>${esc(a.actor || "System")}</b> ${esc(a.detail || a.action)} · ${fmtAgo(a.at)}</div>`).join("")}</div></div>` : ""}`;
}

// ---------- Admin guide ----------
// Keep this in step with the app: update it whenever an admin-facing feature changes.
const GUIDE_UPDATED = "Nov 8, 2026";
function guide() {
  const sc = D.schedule, day = DAYS[sc.weekday];
  const st = k => stepText(k).replace("Game day", `${day}`);
  const sec = (title, body, open) => `<details class="gsec"${open ? " open" : ""}><summary>${title}</summary><div class="gbody">${body}</div></details>`;
  return `
  <button class="linkbtn back" data-act="tab" data-v="admin">← Back to Admin</button>
  <h3 class="sec">Admin guide</h3>
  <p class="empty">Only admins can see this page. Last updated ${GUIDE_UPDATED}.</p>

  ${sec("How a week works", `
    <p>Games are on <b>${day}s, ${fmtRange(sc.start, sc.end)}</b> unless you change a date. The times below come from the default schedule.</p>
    <ol>
      <li><b>${st("open")}:</b> sign-ups open for the next game. Full-timers can answer <em>in</em> or <em>out</em>, and drop-ins can add their name.</li>
      <li><b>Full-timer priority is on every week.</b> All spots are held for full-timers. Drop-ins who sign up wait on the drop-in list in the order they asked.</li>
      <li><b>When you decide:</b> turn <b>Full-timer priority</b> off (Admin screen, <em>This week</em>). Drop-ins then fill any open spots in sign-up order, everyone else goes on the waitlist, and drop-ins get a text that spots are open. It only ends when an admin turns it off.</li>
      <li><b>Any time before the list locks:</b> if someone drops, the first person on the waitlist moves up automatically. A full-timer who says in late still gets a spot, and the last drop-in moves back to the waitlist.</li>
      <li><b>${st("lock")}:</b> the list locks, and players can't change their answer anymore. Admins still can.</li>
      <li><b>When the game ends:</b> it's recorded and counts toward season stats.</li>
    </ol>
    <p>All of this happens on its own. You only step in for the exceptions below.</p>`, true)}

  ${sec("Changing the default schedule", `
    <p>On the <b>Admin</b> screen, under <em>Default schedule</em>, tap <b>Change default schedule</b>. You can set:</p>
    <ul>
      <li>The <b>game day</b>, and the <b>start and end time</b>.</li>
      <li>The <b>number of spots</b> each game starts with.</li>
      <li>When the <b>week opens</b>, when the <b>list locks</b>, and when the <b>reminder</b> goes out (reminders start with the WhatsApp update). Each one is set as days before the game plus a time, so it moves with the game day.</li>
    </ul>
    <p>The change applies to every upcoming game whose sign-ups haven't opened yet. It doesn't change the game that's open now, or any date you've moved, changed or skipped.</p>`)}

  ${sec("Moving a game or changing its time", `
    <p>Under <em>Upcoming games</em> on the Admin screen, tap a date. You can:</p>
    <ul>
      <li><b>Move it to another day</b>, anywhere between the game before and the game after.</li>
      <li><b>Change the start or end time</b> for just that game.</li>
    </ul>
    <p>Sign-up times (week opens, priority ends, list locks) move with the game. If you move a game later, steps that had already happened, like the list locking, are undone until their new time.</p>
    <p>Changed games show a <b>Changed</b> tag. Tap <b>Back to the default day and time</b> to undo.</p>`)}

  ${sec("Skipping a date (holidays and so on)", `
    <p>Tap the date under <em>Upcoming games</em>, optionally type a reason like “Christmas”, and tap <b>Skip</b>. You can skip dates weeks ahead.</p>
    <ul>
      <li>Players see “No game” with your reason, plus when the next game is.</li>
      <li>Skipped dates show in <em>Coming up</em> on the This week screen, so players know in advance.</li>
      <li>Tap the date again and choose <b>Put the game back on</b> to undo.</li>
    </ul>
    <p>For the game that's open now, you can also use <b>Cancel this game</b> under <em>This week</em>. It does the same thing.</p>`)}

  ${sec("Putting the app on your home screen", `
    <p>The app works best added to the phone's home screen. It then opens full screen like a regular app, with its own icon.</p>
    <ul>
      <li><b>Android (Chrome):</b> open your link, tap the <b>⋮</b> menu, then <b>Add to Home screen</b> or <b>Install app</b>.</li>
      <li><b>iPhone (Safari):</b> open your link, tap <b>Share</b>, then <b>Add to Home Screen</b>.</li>
    </ul>
    <p>Do it after opening the personal link, so the phone is already signed in. The phone's Back button closes any open menu first, and the screen doesn't zoom.</p>
    <p>Players can also tap their initials, then <b>Add to home screen</b>. On Android it opens the phone's install prompt. On iPhone it shows the steps.</p>
    <p>The sun/moon button at the top right switches between light and dark mode. Each phone remembers its own choice.</p>
    <p>Every time the app is opened fresh, a short tip-off intro plays: a flaming ball swishes through the logo, which burns away to reveal the app. It takes about five seconds, and it can be replayed from My details. Switching back to an app that's already open doesn't replay it. Phones set to reduce motion skip it, and the swish sound only plays where the phone allows sound.</p>`)}

  ${sec("Getting players into the app", `
    <p>Every player has a personal link. Opening it once signs in that phone, and it stays signed in as long as they open the app at least once a year. There are no passwords or accounts.</p>
    <ol>
      <li>Go to <b>Players</b> and tap <b>+ Add a player</b>. Enter their name and pick Full-timer or Drop-in.</li>
      <li>The app shows a ready-made message with their link. Tap <b>Copy message</b> and send it to them in a WhatsApp DM. Don't post it in the group chat, since anyone who taps it is signed in as that player.</li>
      <li>On the Players screen, “Not signed in yet” shows who hasn't opened their link.</li>
    </ol>
    <p>For a player who's already on the roster, tap their name and choose <b>Get a new link</b>.</p>
    <p><b>Send in WhatsApp</b> opens WhatsApp with their link written. Pick them in your chats and tap Send.</p>
    <p>The first time a player opens the app, it offers to add their mobile number for game texts. They can skip it and add it later by tapping their initials at the top right.</p>`)}

  ${sec("Changing someone's answer", `
    <p>If a player tells you in the group chat that they're in or out, tap their name on the <b>This week</b> screen. You'll see <b>In</b>, <b>Out</b> or <b>No reply</b> for a full-timer, and <b>Add to</b> or <b>Take off</b> this week's list for a drop-in.</p>
    <p>This works even after the list is locked. The waitlist updates right away.</p>`)}

  ${sec("Lost phone or forwarded link", `
    <p>Tap the player's name, then:</p>
    <ul>
      <li><b>Get a new link</b> makes a fresh link and stops the old one working. Phones already signed in stay signed in.</li>
      <li><b>Lost phone? New link and sign out every phone</b> also signs out every phone they're signed in on. Use it if a phone is lost or the link was shared.</li>
    </ul>`)}

  ${sec("Full-timers and drop-ins", `
    <p>Tap the player's name, then <b>Make drop-in…</b> or <b>Make full-timer…</b>. A confirmation window shows what changes before anything happens.</p>
    <ul>
      <li>Their answer for this week is cleared, so they'll need to answer again under their new role.</li>
      <li>A full-timer moved to drop-in who was playing gives up their spot, and the waitlist moves up.</li>
    </ul>`)}

  ${sec("This week's settings", `
    <p>These are on the <b>Admin</b> screen under <em>This week</em>. They appear once sign-ups open, and they only change the current game.</p>
    <ul>
      <li><b>Full-timer priority:</b> on by default every week. Turn it off to let drop-ins into open spots, or back on to hold spots for full-timers again. It never turns off on its own.</li>
      <li><b>Sign-ups open:</b> turn it off to lock the list early, or on to reopen it after it locks.</li>
      <li><b>Spots:</b> from 6 to 30, for this game only. The waitlist adjusts right away. Future games use the number in the default schedule.</li>
      <li><b>Cancel this game:</b> for a closed gym, a holiday and so on. Players see a no-game notice. Tap <b>Restore</b> to undo.</li>
    </ul>`)}

  ${sec("Drop-in payments", `
    <p>Drop-ins pay <b>${money(D.payments?.fee_cents ?? 1200)}</b> a game. When a game ends, every drop-in who played is charged automatically. Full-timers are never charged.</p>
    <ul>
      <li><b>Who owes what:</b> the <em>Drop-in payments</em> card on the Admin screen lists everyone with an unpaid balance and the total owed.</li>
      <li><b>Recording a payment:</b> tap a name, then <b>Mark paid</b> next to each game, or <b>Mark all paid</b> to clear their balance. A mistaken tick can be undone for 60 days.</li>
      <li><b>What players see:</b> a drop-in with a balance sees “You owe $X” on This week, and only their own balance. Nobody else sees it.</li>
      <li><b>Changing the fee:</b> edit it on the same card. It applies to games that end after the change; past charges keep their amount.</li>
    </ul>
    <p>A drop-in who pays at the gym can be marked paid once the game ends (10 PM), when the charge appears.</p>`)}

  ${sec("Announcements", `
    <p>Post a short notice (up to 280 characters) from the <em>Announcement</em> card on the Admin screen. It shows at the top of This week for everyone, with your name.</p>
    <p>Leave <b>Remove it automatically after the next game</b> ticked for one-off notices, or untick it to keep it up until you tap <b>Remove</b>. Announcements don't send texts.</p>`)}

  ${sec("Gym info and calendars", `
    <p>The gym's name and address show on This week and go into calendar events. Tapping them opens <b>Getting there</b>, with the gym photo, the <em>How to get in</em> notes and a map of the way in. Edit all of it, and add, replace or remove the photo and the map, on the <em>Gym info</em> card.</p>
    <p>Everyone can tap <b>Add to calendar</b> on This week to add the game to Google Calendar, Outlook / Hotmail or Apple Calendar. They can also subscribe to every game, so new weeks appear on their own, moved games move, and skipped dates show as cancelled.</p>
    <p>Subscribing works in one tap on iPhones. Google Calendar and Outlook only allow it from a computer, so the app gives a <b>Copy calendar link</b> button and short steps for each. Once added on a computer, it syncs to the phone.</p>`)}

  ${sec("Posting to the WhatsApp group", `
    <p>On the <b>Admin</b> screen, <b>Share in WhatsApp</b> opens WhatsApp with the current list written: who's playing, open spots, the waitlist, and who hasn't answered, plus a link to the app. <b>Copy</b> copies the same text if you'd rather paste it.</p>
    <p>Post it before the game with the final list. When texts are on, the post also says how to text JOIN.</p>`)}

  ${sec("Admins and the roster", `
    <ul>
      <li><b>Make someone an admin:</b> tap their name on the Players screen, then <b>Make admin</b>. They see the Admin tab and this guide the next time they open the app.</li>
      <li><b>Remove admin rights:</b> same place. The group always keeps at least one admin.</li>
      <li><b>Profile pictures:</b> players pick a built-in avatar or upload a photo by tapping their initials (or picture) at the top right. If a picture isn't appropriate, tap the player's name and choose <b>Remove profile picture</b>. It goes back to their initials.</li>
      <li><b>Names:</b> players can change their own name by tapping their initials at the top right. Admins can also fix someone's name: tap it, then <em>Details</em>. Mobile numbers are only ever changed by the player.</li>
      <li><b>Remove from group:</b> signs them out and hides them from the app. Their past attendance stays in the season stats. You need to remove their admin rights first if they have them.</li>
      <li><b>Recent changes</b> at the bottom of the Admin screen shows what each admin changed and when, including schedule changes.</li>
    </ul>`)}

  ${sec("Sharing in WhatsApp (one tap)", `
    <p>These buttons open WhatsApp on your phone with the message already written. You pick the chat and tap Send. Nothing is sent automatically.</p>
    <ul>
      <li><b>Share in WhatsApp</b> (Admin screen, under <em>Post to WhatsApp</em>): the current roster. Pick the Sunday Ball group.</li>
      <li><b>Nudge</b> (This week screen, next to each full-timer under <em>No reply yet</em>): opens a WhatsApp chat with them asking if they're in, with a link to the app. It's grayed out for players who haven't turned on <em>Let admins message me on WhatsApp</em>.</li>
      <li><b>Send in WhatsApp</b> (after <em>Get a new link</em> or adding a player): opens WhatsApp with their personal link written, to send in a private chat.</li>
    </ul>
    <p>If the player turned on <em>Let admins message me on WhatsApp</em> (under their initials), these buttons open a chat with them directly. Their player menu also gets a <b>Message on WhatsApp</b> button, and shows “WhatsApp DM on”. Otherwise WhatsApp opens and you pick them in your chats. The app still never shows anyone's number.</p>`)}

  ${sec("Text messages (automatic)", `
    <p>When <b>Send text messages</b> is on (Admin screen), the app texts players from ${D.texts.number ? `<b>${esc(fmtPhone(D.texts.number))}</b>` : "the group's Twilio number"}:</p>
    <ul>
      <li><b>${st("open")}:</b> full-timers who haven't answered get “Sign-ups are open. Reply IN or OUT.”</li>
      <li><b>${st("reminder")}:</b> full-timers who still haven't answered get a reminder.</li>
      <li><b>When an admin turns full-timer priority off:</b> drop-ins who got a spot hear they're in. If spots are still open, the other drop-ins get “Reply SPOT to grab one.”</li>
      <li><b>Any time:</b> a drop-in who moves up or gets bumped to the waitlist hears about it right away. If you cancel or move an open game, everyone who said in gets a text.</li>
    </ul>
    <p>Players answer by replying <b>IN</b> or <b>OUT</b> (drop-ins can also reply <b>SPOT</b>), and they get a confirmation back. Every text and reply includes a link to the app, so they can jump in from there.</p>
    <p>Texts only go to players who turned them on themselves:</p>
    <ul>
      <li>They text <b>JOIN</b> to the number. They also get their personal app link back, so this is an easy way to onboard someone.</li>
      <li>Or, once their number is confirmed, they switch <em>Game reminders by text</em> on or off on the This week screen or under their initials.</li>
      <li>Replying <b>STOP</b> turns texts off, and <b>START</b> turns them back on.</li>
    </ul>
    <p><b>Tip:</b> phones often put texts from a new number in spam or “Unknown senders”. Ask players to save ${D.texts.number ? esc(fmtPhone(D.texts.number)) : "the number"} as a contact called “Sunday Ball”. The roster post reminds them.</p>
    <p><b>Numbers are private.</b> Players add, change or remove their own number by tapping their initials at the top right. Admins never see it, and the Players screen only shows whether texts are on. Even the player only ever sees its last four digits. A new number gets no texts until the player confirms it by texting JOIN from that phone, so a typo or someone else's number never gets texted.</p>
    <p>The Admin screen shows how many players have texts on, and a log of recent texts with their delivery status. <b>Send me a test text</b> checks that everything works (add your own number first).</p>`)}`;
}

// ---------- sheets (bottom dialogs) ----------
function sheetHTML() {
  const s = UI.sheet; if (!s) return "";
  const wrap = (inner, label) => `<div class="modal" data-act="close-bg"><div class="dialog" role="dialog" aria-modal="true" aria-label="${esc(label)}"><button class="sheet-x" data-act="close" aria-label="Close">×</button>${inner}</div></div>`;
  const p = s.id != null ? P(s.id) : null;

  if (s.kind === "player" && p) {
    const g = D.game, ans = D.signups[p.id];
    let week = "";
    if (g && g.status === "open") {
      week = p.type === "ft"
        ? `<div class="btnrow"><button class="btn ${ans === "in" ? "dark" : "ghost"}" data-act="admin-answer" data-v="in">In</button><button class="btn ${ans === "out" ? "dark" : "ghost"}" data-act="admin-answer" data-v="out">Out</button>${ans ? `<button class="btn ghost" data-act="admin-answer" data-v="">No reply</button>` : ""}</div>`
        : ans === "requested" ? `<button class="btn ghost block" data-act="admin-answer" data-v="">Take off this week's list</button>`
        : `<button class="btn dark block" data-act="admin-answer" data-v="requested">Add to this week's list</button>`;
      week = `<div class="group"><b>This week</b>${week}</div>`;
    }
    return wrap(`
      <div class="who">${avatarHTML(p)}<span>${esc(p.name)}</span><span class="arrow">${p.type === "ft" ? "Full-timer" : "Drop-in"}${p.is_admin ? " · Admin" : ""} · ${p.signed_in ? "Signed in" : "Not signed in yet"} · ${p.texts === "on" ? "Texts on" : p.texts === "stopped" ? "Texts stopped" : p.has_phone ? "Texts not on yet" : "No number added"}${p.wa_dm ? " · WhatsApp DM on" : ""}</span></div>
      ${p.wa_dm ? waButton(p.id, `Hi ${p.name.split(" ")[0]}, `, "Message on WhatsApp", "btn ghost wa block") : ""}
      ${week}
      <div class="group"><b>Sign-in link</b>
        <p>Make a new personal link to send them. Their old link stops working. Phones already signed in stay signed in.</p>
        <button class="btn primary block" data-act="link" data-v="0">Get a new link</button>
        <button class="linkbtn" data-act="link" data-v="1">Lost phone? New link and sign out every phone</button></div>
      <form class="group" id="editform"><b>Details</b>
        <label class="field">Name<input id="ed-name" value="${esc(p.name)}" maxlength="40" autocomplete="off"></label>
        <p>Players add and change their own mobile number. It's private, so admins can't see it.</p>
        <button class="btn ghost block" type="submit">Save name</button></form>
      <div class="group"><b>Role</b>
        <button class="btn ghost block" data-act="sheet-swap">${p.type === "ft" ? "Make drop-in…" : "Make full-timer…"}</button>
        ${p.avatar_kind ? `<button class="btn ghost block" data-act="avatar-reset">Remove profile picture</button>` : ""}
        <button class="btn ghost block" data-act="admin-toggle">${p.is_admin ? "Remove admin rights" : "Make admin"}</button>
        ${p.id !== D.me.id && !p.is_admin ? `<button class="btn ghost block" data-act="sheet-remove" style="color:var(--bad)">Remove from group…</button>` : ""}</div>
      <button class="btn ghost" data-act="close">Done</button>`, `Options for ${p.name}`);
  }

  if (s.kind === "swap" && p) {
    const toFt = p.type === "di", r = D.roster;
    const inGame = r && (r.ftPlay.includes(p.id) || r.diPlay.includes(p.id));
    const effects = toFt
      ? [`${esc(p.name)} gets first dibs on a spot every week`, `They'll be asked "in or out?" each week`, D.signups[p.id] ? `Their drop-in sign-up for this week is cleared, so they'll need to answer in or out` : null]
      : [`${esc(p.name)} loses first dibs and signs up as a drop-in from now on`, inGame ? `They're playing this week. Their spot is released and the next person on the waitlist moves up` : `Their answer for this week is cleared`];
    return `<div class="modal" data-act="close-bg"><div class="dialog" role="alertdialog" aria-modal="true" aria-labelledby="dlg-title">
      <h3 id="dlg-title">Make ${esc(p.name)} a ${toFt ? "full-timer" : "drop-in"}?</h3>
      <div class="who">${avatarHTML(p)}<span>${esc(p.name)}</span><span class="arrow">${toFt ? "Drop-in → Full-timer" : "Full-timer → Drop-in"}</span></div>
      <ul>${effects.filter(Boolean).map(x => `<li>${x}</li>`).join("")}</ul>
      ${toFt ? `<p>That makes ${D.players.filter(x => x.type === "ft").length + 1} full-timers for ${D.game?.cap ?? 15} spots.</p>` : ""}
      <div class="btnrow"><button class="btn ghost" data-act="close" data-autofocus>Cancel</button><button class="btn ${toFt ? "primary" : "danger"}" data-act="swap-yes">Make ${toFt ? "full-timer" : "drop-in"}</button></div>
    </div></div>`;
  }

  if (s.kind === "remove" && p) {
    return `<div class="modal" data-act="close-bg"><div class="dialog" role="alertdialog" aria-modal="true" aria-labelledby="dlg-title">
      <h3 id="dlg-title">Remove ${esc(p.name)} from the group?</h3>
      <p>They'll be signed out, their link stops working, and they won't show up in the app. Their past attendance stays in the season stats.</p>
      <div class="btnrow"><button class="btn ghost" data-act="close" data-autofocus>Cancel</button><button class="btn danger" data-act="remove-yes">Remove</button></div>
    </div></div>`;
  }

  if (s.kind === "add") {
    return wrap(`<h3>Add a player</h3>
      <form id="addform" class="group" style="border:none;padding:0">
        <label class="field">Name<input id="add-name" maxlength="40" autocomplete="off" autocapitalize="words" required data-autofocus></label>
        <p>They'll add their own mobile number the first time they open the app.</p>
        <div class="seg" role="group" aria-label="Player type"><button type="button" data-act="add-type" data-v="ft" aria-pressed="${s.type === "ft"}">Full-timer</button><button type="button" data-act="add-type" data-v="di" aria-pressed="${s.type !== "ft"}">Drop-in</button></div>
        <div class="btnrow"><button class="btn ghost" type="button" data-act="close">Cancel</button><button class="btn primary" type="submit">Add player</button></div>
      </form>`, "Add a player");
  }

  if (s.kind === "link") {
    const msg = `Hi ${s.name}! Here's your personal link for ${GROUP}:\n${s.url}\n\nTap it once and you're signed in on that phone. Please don't share it, it's just for you.`;
    s.msg = msg;
    return wrap(`<h3>Send this to ${esc(s.name)}</h3>
      <p>${s.isNew ? "They're on the roster." : "Their old link no longer works."} Send them this message in a private chat, not the group.</p>
      <pre class="copybox" id="linkmsg">${esc(msg)}</pre>
      ${waButton(s.id, msg, "Send in WhatsApp", "btn primary wa block")}
      <p class="fine">${P(s.id)?.wa_dm ? `Opens your WhatsApp chat with ${esc(s.name)}.` : `Opens WhatsApp. Pick ${esc(s.name)} in your chats. (They haven't turned on WhatsApp messages from admins.)`}</p>
      <div class="btnrow"><button class="btn ghost" data-act="close">Done</button><button class="btn ghost" data-act="copy-link">Copy message</button></div>`, `Link for ${s.name}`);
  }

  if (s.kind === "intro" || s.kind === "me") {
    const me = D.me, intro = s.kind === "intro";
    const privacy = `<p class="fine">Your number is private: admins can't see it, and the app only ever shows its last four digits, even to you. It's used only for Sunday Ball texts.</p>`;
    const form = `<form id="phoneform" class="group" style="${intro ? "border:none;padding:0" : ""}">
        ${intro ? "" : "<b>Mobile number</b>"}
        <label class="field">${intro ? "Mobile number" : ""}<input id="my-phone" type="tel" inputmode="tel" autocomplete="tel" placeholder="${me.has_phone ? `Ending in ${esc(me.phone_last4)}. Type a new one to change it` : "613-555-0123"}"></label>
        <button class="btn primary block" type="submit">${intro ? "Add my number" : me.has_phone ? "Change number" : "Add my number"}</button>
        ${!intro && me.has_phone ? `<button class="linkbtn" type="button" data-act="phone-remove">Remove my number</button>` : ""}
      </form>`;
    if (intro) {
      return wrap(`<h3>Welcome, ${esc(me.name.split(" ")[0])}!</h3>
        <p>Want game updates by text? Add your mobile number and you'll get a text when sign-ups open. Reply <b>IN</b> or <b>OUT</b> right from your messages, and hear about open spots and changes.</p>
        ${form}
        ${privacy}
        <button class="btn ghost" data-act="close">No thanks</button>
        <p class="fine">Changed your mind later? Tap your initials at the top right of the app any time to add or change your number.</p>`, "Welcome");
    }
    const st = myTextStatus();
    const mp = meP();
    return wrap(`<div class="who">${avatarHTML(mp, "big")}<span>${esc(me.name)}</span><span class="arrow">${me.type === "ft" ? "Full-timer" : "Drop-in"}${me.is_admin ? " · Admin" : ""}</span></div>
      <div class="group"><b>Profile picture</b>
        <div class="btnrow">
          <label class="btn primary" for="my-photo">Upload a photo</label>
          <input id="my-photo" type="file" accept="image/*" hidden>
          ${mp.avatar_kind ? `<button class="btn ghost" type="button" data-act="avatar-initials">Use initials</button>` : ""}
        </div>
        <p class="fine">Or pick an avatar:</p>
        <div class="emojigrid">${D.avatarEmoji.map(e => `<button type="button" class="emojibtn" data-act="avatar-emoji" data-v="${esc(e)}" aria-pressed="${mp.avatar_kind === "emoji" && mp.avatar_emoji === e}" aria-label="Avatar ${esc(e)}">${esc(e)}</button>`).join("")}</div>
      </div>
      <form id="nameform" class="group"><b>Your name</b>
        <label class="field"><input id="my-name" value="${esc(me.name)}" maxlength="40" autocomplete="name" autocapitalize="words" aria-label="Your name"></label>
        <button class="btn ghost block" type="submit">Save name</button>
        <p class="fine">This is how everyone sees you on the roster.</p>
      </form>
      ${form}
      ${privacy}
      <form id="waform" class="group"><b>WhatsApp</b>
        <div class="setting" style="padding:0"><div><b>Let admins message me on WhatsApp</b><small>${me.wa_dm_ok ? "On. Admins' Nudge and Send buttons open a chat with you directly." : "Off. Admins pick you in their WhatsApp contacts themselves."}</small></div>
          <button class="switch" type="button" role="switch" aria-checked="${me.wa_dm_ok}" aria-label="Let admins message me on WhatsApp" data-act="my-wa" data-v="${me.wa_dm_ok ? 0 : 1}"></button></div>
        <label class="field">WhatsApp number, if different<input id="wa-phone" type="tel" inputmode="tel" autocomplete="off" placeholder="${me.wa_phone_last4 ? `Ending in ${esc(me.wa_phone_last4)}` : me.has_phone ? "Same as my mobile number" : "613-555-0123"}"></label>
        <button class="btn ghost block" type="submit">Save WhatsApp number</button>
        ${me.wa_phone_last4 ? `<button class="linkbtn" type="button" data-act="wa-same">Use my mobile number for WhatsApp</button>` : ""}
        <p class="fine">Your number still never shows in the app. When an admin opens a chat with you, WhatsApp shows it to them, the same as in the group chat.</p>
      </form>
      ${D.texts.number ? `<div class="group"><b>Game texts</b>
        ${st && me.has_phone ? `<p>${st.text}</p><p>Save ${textsNumber()} as a contact called “Sunday Ball” so the texts don't land in spam.</p>`
          : !me.has_phone ? `<p>Add your number above to get game texts.</p>`
          : `<div class="setting" style="padding:0"><div><b>Game reminders by text</b><small>${me.texts_on ? "On" : "Off"}${D.texts.live ? "" : " · texts start once the admins switch them on"}</small></div><button class="switch" role="switch" aria-checked="${me.texts_on}" aria-label="Game reminders by text" data-act="my-texts" data-v="${me.texts_on ? 0 : 1}"></button></div>`}
      </div>` : ""}
      ${installGroup()}
      <button class="linkbtn" type="button" data-act="replay-intro" style="justify-self:center">Play the tip-off intro again</button>
      <button class="btn ghost" data-act="close">Done</button>`, "My details");
  }

  if (s.kind === "gym") {
    const v = D.venue;
    return wrap(`<h3>Getting there</h3>
      ${v.photo_url ? `<img class="gymphoto" src="${esc(v.photo_url)}" alt="The gymnasium at ${esc(v.name)}" loading="lazy">` : ""}
      <div class="venue big">${PIN_ICON}<div><b>${esc(v.name)}</b>${v.address ? `<span>${esc(v.address)}</span>` : ""}</div></div>
      ${v.notes ? `<p class="gymnotes">${esc(v.notes)}</p>` : ""}
      ${v.map_url ? `<img class="gymmap" src="${esc(v.map_url)}" alt="Map of the way in to the gym" loading="lazy">` : ""}
      <button class="btn ghost" data-act="close">Done</button>`, "Getting there");
  }

  if (s.kind === "cal") {
    const g = D.game; if (!g) return "";
    const t = ms => new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
    const iso = ms => new Date(ms).toISOString().replace(/\.\d{3}/, "");
    const where = [D.venue?.name, D.venue?.address].filter(Boolean).join(", ");
    const title = GROUP, details = `Answer in or out in the app: ${location.origin}`;
    const e = encodeURIComponent;
    const google = `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${e(title)}&dates=${t(g.starts_at)}/${t(g.ends_at)}&details=${e(details)}&location=${e(where)}`;
    const outlook = `https://outlook.live.com/calendar/0/deeplink/compose?path=%2Fcalendar%2Faction%2Fcompose&rru=addevent&subject=${e(title)}&startdt=${e(iso(g.starts_at))}&enddt=${e(iso(g.ends_at))}&location=${e(where)}&body=${e(details)}`;
    const apple = `${location.origin}/cal/game/${g.id}.ics`;
    const feed = `${location.host}/cal/games.ics`;
    const btn = (href, label, blank = true) => `<a class="btn ghost block calbtn" href="${href}" ${blank ? 'target="_blank" rel="noopener"' : ""}>${label}</a>`;
    return wrap(`<h3>Add to your calendar</h3>
      <div class="group" style="border:none;padding:0"><b>This game · ${fmtSunday(g.date)}, ${fmtRange(g.start_time, g.end_time)}</b>
        ${btn(google, "Google Calendar")}${btn(outlook, "Outlook / Hotmail")}${btn(apple, "Apple Calendar", false)}</div>
      <div class="group"><b>Every game (updates automatically)</b>
        <p>Subscribe once and each week's game shows up on its own. Moved games move and skipped dates are marked cancelled. Calendars check for changes every few hours.</p>
        <pre class="copybox" id="feedurl">https://${feed}</pre>
        <button class="btn primary block" data-act="copy-feed">Copy calendar link</button>
        ${isIOS() || /Macintosh/.test(navigator.userAgent) ? btn(`webcal://${feed}`, "Subscribe in Apple Calendar", false) : ""}
        <details class="gsec calhelp"><summary>Google Calendar</summary><div class="gbody">
          <p>Google only lets you subscribe from a computer, not the phone app. It then shows up on your phone on its own.</p>
          <ol><li>On a computer, open <b>calendar.google.com</b>.</li><li>Next to <b>Other calendars</b>, click <b>+</b>, then <b>From URL</b>.</li><li>Paste the calendar link and click <b>Add calendar</b>.</li></ol>
          <p>On Android, if it doesn't appear: open Google Calendar's settings, tap the new calendar and turn on <b>Sync</b>.</p>
          ${isTouch() ? "" : btn(`https://calendar.google.com/calendar/r?cid=${e("webcal://" + feed)}`, "Open Google Calendar to subscribe")}
        </div></details>
        <details class="gsec calhelp"><summary>Outlook / Hotmail</summary><div class="gbody">
          <ol><li>On a computer, open <b>outlook.live.com/calendar</b>.</li><li>Click <b>Add calendar</b>, then <b>Subscribe from web</b>.</li><li>Paste the calendar link, name it “Sunday Ball” and click <b>Import</b>.</li></ol>
          ${isTouch() ? "" : btn(`https://outlook.live.com/calendar/0/addfromweb?url=${e("https://" + feed)}&name=${e(title)}`, "Open Outlook to subscribe")}
        </div></details>
        <details class="gsec calhelp"><summary>iPhone / Apple Calendar</summary><div class="gbody">
          <p>${isIOS() ? "Tap <b>Subscribe in Apple Calendar</b> above and confirm." : "On an iPhone, open this screen in Safari and tap Subscribe in Apple Calendar."} Or add it by hand:</p>
          <ol><li>Open <b>Settings</b>, then <b>Apps</b>, then <b>Calendar</b>, then <b>Calendar Accounts</b>.</li><li>Tap <b>Add Account</b>, then <b>Other</b>, then <b>Add Subscribed Calendar</b>.</li><li>Paste the calendar link and tap <b>Next</b>, then <b>Save</b>.</li></ol>
        </div></details>
      </div>
      <button class="btn ghost" data-act="close">Done</button>`, "Add to calendar");
  }

  if (s.kind === "charges") {
    const list = D.payments.charges.filter(c => c.player_id === s.id);
    const nm = P(s.id)?.name || list[0]?.player || "Player";
    const unpaid = list.filter(c => !c.paid_at), paid = list.filter(c => c.paid_at);
    const owed = unpaid.reduce((t, c) => t + c.amount_cents, 0);
    const row = c => `<div class="setting"><div><b>${fmtSunday(c.date)}</b><small>${money(c.amount_cents)}${c.paid_at ? ` · paid ${fmtAgo(c.paid_at)}` : ""}</small></div>
      <button class="btn ${c.paid_at ? "ghost" : "primary"} small" data-act="charge-paid" data-game="${c.game_id}" data-v="${c.paid_at ? 0 : 1}">${c.paid_at ? "Undo" : "Mark paid"}</button></div>`;
    return wrap(`<h3>${esc(nm)} ${owed ? `owes ${money(owed)}` : "is all paid up"}</h3>
      ${unpaid.length ? `<div class="group" style="border:none;padding:0"><b>Unpaid</b>${unpaid.map(row).join("")}</div>
        <button class="btn dark block" data-act="paid-all">Mark all ${money(owed)} paid</button>` : ""}
      ${paid.length ? `<div class="group"><b>Paid in the last 60 days</b>${paid.map(row).join("")}</div>` : ""}
      <button class="btn ghost" data-act="close">Done</button>`, `Payments for ${nm}`);
  }

  if (s.kind === "install-help") {
    const ios = isIOS();
    const steps = ios
      ? [`Tap the <b>Share</b> button <span class="kbd">${SHARE_ICON}</span> at the bottom of Safari (top right on iPad).`, `Scroll down and tap <b>Add to Home Screen</b>.`, `Tap <b>Add</b>.`]
      : [`Tap the browser's <b>⋮</b> menu (top right in Chrome).`, `Tap <b>Add to Home screen</b> or <b>Install app</b>.`, `Tap <b>Add</b> or <b>Install</b>.`];
    return wrap(`<h3>Add Sunday Ball to your home screen</h3>
      <ol class="steps">${steps.map(x => `<li>${x}</li>`).join("")}</ol>
      ${ios ? `<p class="fine">On iPhone this only works in Safari. If you opened your link in another app, open it in Safari first.</p>` : `<p class="fine">You're already signed in, so the icon opens straight into your account.</p>`}
      <button class="btn ghost" data-act="close">Done</button>`, "Add to home screen");
  }

  if (s.kind === "schedule") {
    const sc = D.schedule;
    const opts = (k, wd) => {
      const max = k === "open" ? 7 : 6, min = k === "open" ? 1 : 0;
      let o = "";
      for (let d = min; d <= max; d++) o += `<option value="${d}" ${sc[k].before === d ? "selected" : ""}>${stepDayLabel(d, wd)}</option>`;
      return o;
    };
    return wrap(`<h3>Default schedule</h3>
      <p>Applies to upcoming games that haven't opened for sign-ups yet. Dates you've moved, changed or skipped keep their own settings.</p>
      <form id="schedform" class="group" style="border:none;padding:0">
        <label class="field">Game day<select id="sc-wd">${DAYS.map((d, i) => `<option value="${i}" ${sc.weekday === i ? "selected" : ""}>${d}</option>`).join("")}</select></label>
        <div class="two"><label class="field">Starts<input id="sc-start" type="time" step="900" value="${sc.start}" required></label>
        <label class="field">Ends<input id="sc-end" type="time" step="900" value="${sc.end}" required></label></div>
        <label class="field">Spots<input id="sc-cap" type="number" min="6" max="30" value="${sc.cap}" required></label>
        ${["open", "reminder", "lock"].map(k => `<div class="field">${D.stepLabels[k]}<div class="two step"><select id="sc-${k}-d" data-step="${k}">${opts(k, sc.weekday)}</select><input id="sc-${k}-t" type="time" step="900" value="${sc[k].time}" required aria-label="${D.stepLabels[k]} time"></div></div>`).join("")}
        <div class="btnrow"><button class="btn ghost" type="button" data-act="close">Cancel</button><button class="btn primary" type="submit">Save schedule</button></div>
      </form>`, "Default schedule");
  }

  if (s.kind === "game") {
    const i = D.upcoming.findIndex(x => x.id === s.id), x = D.upcoming[i];
    if (!x) return "";
    const prev = D.upcoming[i - 1], next = D.upcoming[i + 1];
    const today = localDate(Date.now());
    const min = prev ? addDay(prev.date, 1) : today;
    const max = next ? addDay(next.date, -1) : "";
    const skipped = x.status === "cancelled";
    return wrap(`<h3>${fmtSunday(x.date)}</h3>
      <p>${skipped ? `Skipped${x.note ? ": " + esc(x.note) : ""}. Players see a no-game notice.` : `${fmtRange(x.start_time, x.end_time)}${isChanged(x) ? " · changed from the default" : ""}`}</p>
      ${skipped ? "" : `<form id="gameform" class="group"><b>Move or change the time</b>
        <label class="field">Date<input id="gm-date" type="date" value="${x.date}" min="${min}" ${max ? `max="${max}"` : ""} required></label>
        <div class="two"><label class="field">Starts<input id="gm-start" type="time" step="900" value="${x.start_time}" required></label>
        <label class="field">Ends<input id="gm-end" type="time" step="900" value="${x.end_time}" required></label></div>
        <p>Sign-up times (week opens, priority, lock) move with the game.</p>
        <button class="btn primary block" type="submit">Save changes</button>
        ${isChanged(x) ? `<button class="linkbtn" type="button" data-act="game-reset">Back to the default day and time</button>` : ""}</form>`}
      <div class="group"><b>${skipped ? "Put this date back on" : "Skip this date"}</b>
        ${skipped ? `<button class="btn dark block" data-act="game-unskip">Put the game back on</button>`
          : `<label class="field">Reason (optional, players see it)<input id="gm-note" maxlength="60" placeholder="Christmas, gym closed…" autocomplete="off"></label>
             <button class="btn ghost block" data-act="game-skip" style="color:var(--bad)">Skip ${fmtShort(x.date)}</button>`}</div>
      <button class="btn ghost" data-act="close">Done</button>`, `Game on ${x.date}`);
  }
  return "";
}

const stepDayLabel = (d, wd) => d === 0 ? `Game day (${DAYS[wd].slice(0, 3)})` : `${DAYS[(wd - d + 7) % 7].slice(0, 3)}, ${d} day${d > 1 ? "s" : ""} before`;
const addDay = (date, n) => { const t = new Date(date + "T12:00:00Z"); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };

// Menus (sheets) take one step in the browser history, so the phone's Back
// button closes the menu instead of navigating the page behind it.
function openSheet(sheet) {
  if (!UI.sheet) {
    UI.lastFocus = document.activeElement;
    history.pushState({ sheet: true }, "");
  }
  UI.sheet = sheet;
  renderSheet(true);
}
function closeSheet(fromBack = false) {
  if (!UI.sheet) return;
  if (UI.sheet.kind === "intro") call("/api/me/intro", {}).then(st => { D = st; render(); }).catch(() => {});
  UI.sheet = null;
  renderSheet();
  document.body.classList.remove("sheet-open");
  if (!fromBack && history.state?.sheet) history.back();   // drop the step we added
  if (UI.lastFocus?.isConnected) UI.lastFocus.focus({ preventScroll: true });
}
function renderSheet(opening = false) {
  const keep = $("modal").querySelector(".dialog")?.scrollTop || 0;
  $("modal").innerHTML = sheetHTML();
  document.body.classList.toggle("sheet-open", !!UI.sheet);
  const dlg = $("modal").querySelector(".dialog");
  if (!dlg) return;
  if (opening) {
    // Focus the menu itself, not a text box, so the keyboard doesn't pop up on phones.
    const f = dlg.querySelector("[data-autofocus]") || dlg;
    dlg.setAttribute("tabindex", "-1");
    f.focus({ preventScroll: true });
  } else dlg.scrollTop = keep;
}

// ---------- render ----------
const ICONS = {
  sunday: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3v18M5.6 5.6c3.5 3.5 3.5 9.3 0 12.8M18.4 5.6c-3.5 3.5-3.5 9.3 0 12.8"/></svg>',
  players: '<svg viewBox="0 0 24 24"><circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.6-3.6 3.3-5.5 6.5-5.5s5.9 1.9 6.5 5.5"/><circle cx="17" cy="9" r="2.6"/><path d="M17 14.5c2.4 0 4.1 1.5 4.5 4"/></svg>',
  season: '<svg viewBox="0 0 24 24"><path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/></svg>',
  admin: '<svg viewBox="0 0 24 24"><path d="M12 3l7.5 3v5.5c0 4.5-3.2 8.2-7.5 9.5-4.3-1.3-7.5-5-7.5-9.5V6z"/><path d="M9 12l2 2 4-4"/></svg>',
};
const LABELS = { sunday: "This week", players: "Players", season: "Season", admin: "Admin" };

function render() {
  if (!D) return;
  if (!TABS.includes(UI.tab) || (ADMIN_ONLY.includes(UI.tab) && !isAdmin())) UI.tab = "sunday";
  const tabs = NAV_TABS.filter(t => t !== "admin" || isAdmin());
  const current = UI.tab === "guide" ? "admin" : UI.tab;
  const av = $("me-av");
  const mp = meP();
  av.hidden = false; av.innerHTML = avInner(mp); av.className = "avatar mebtn" + (D.me.type === "ft" ? " ft" : "") + (mp.avatar_kind ? " pic" : ""); av.title = `${D.me.name}: my details`;
  const nav = $("nav"); nav.hidden = false;
  nav.innerHTML = tabs.map(k => `<button data-act="tab" data-v="${k}" ${current === k ? 'aria-current="page"' : ""}>${ICONS[k]}${LABELS[k]}</button>`).join("");
  $("screen").innerHTML = { sunday, players, season, admin, guide }[UI.tab]();
  if (UI.sheet) {
    // Keep an open sheet in sync, unless the person is typing in it.
    if (!$("modal").contains(document.activeElement) || !["INPUT", "SELECT"].includes(document.activeElement.tagName)) renderSheet();
  }
}

function renderSignedOut() {
  const invalid = new URLSearchParams(location.search).get("link") === "invalid";
  $("nav").hidden = true; $("me-av").hidden = true;
  $("screen").innerHTML = `<div class="signedout">
    <h2>${invalid ? "That link doesn't work anymore" : "Open your personal link"}</h2>
    <p>${invalid
      ? "An admin made a new link for you, or you were removed from the group. Ask an admin to send you a fresh link."
      : "Every player gets their own link by text or WhatsApp. Tap it once and this phone stays signed in."}</p>
    <p>Lost it? Ask one of the admins for a new one.</p></div>`;
}

// ---------- events ----------
document.addEventListener("click", async e => {
  const b = e.target.closest("[data-act]"); if (!b) return;
  const a = b.dataset.act, v = b.dataset.v;
  switch (a) {
    case "tab": UI.tab = v; location.hash = v; UI.confirmCancel = false; render(); scrollTo(0, 0); break;
    case "filter": UI.filter = v; render(); break;
    case "answer": {
      const msgs = { in: "You're in", out: "Marked out for this week", requested: null, "": "Your name was taken off" };
      await act("/api/me/answer", { answer: v || null }, res => {
        if (v !== "requested") return msgs[v];
        const r = res.roster; return r.diPlay.includes(res.me.id) ? `You're in! See you ${dayOf(res.game)}` : `Added. You're #${r.wait.indexOf(res.me.id) + 1}`;
      });
      break;
    }
    case "game": {
      const field = b.dataset.field;
      const val = field === "status" ? v : v === "1";
      UI.confirmCancel = false;
      const msg = { priority_open: val ? "Full-timer priority is on" : "Drop-ins can now fill open spots", locked: val ? "Sign-ups locked" : "Sign-ups reopened", status: v === "cancelled" ? "This game is cancelled" : "The game is back on" }[field];
      await act("/api/admin/game", { [field]: field === "locked" ? !val : val }, msg);
      break;
    }
    case "cap": { const cap = D.game.cap + Number(v); await act("/api/admin/game", { cap }, `Spots set to ${cap}`); break; }
    case "cancel-ask": UI.confirmCancel = true; render(); break;
    case "cancel-no": UI.confirmCancel = false; render(); break;
    case "copy-wa": copy(waText(), $("wa")); break;

    case "sheet": openSheet({ kind: "player", id: Number(b.dataset.id) }); break;
    case "close": closeSheet(); break;
    case "close-bg": if (e.target === b) closeSheet(); break;
    case "admin-answer": {
      const id = UI.sheet.id;
      await act("/api/admin/answer", { player_id: id, answer: v || null }, `${name(id)}: ${{ in: "in", out: "out", requested: "added to the list", "": "answer cleared" }[v]}`);
      break;
    }
    case "link": {
      const id = UI.sheet.id, nm = name(id);
      const res = await act(`/api/admin/players/${id}/link`, { sign_out: v === "1" }, v === "1" ? `${nm} was signed out everywhere` : null);
      if (res) openSheet({ kind: "link", id, name: nm, url: res.link });
      break;
    }
    case "copy-link": copy(UI.sheet.msg, $("linkmsg")); break;
    case "sheet-swap": openSheet({ kind: "swap", id: UI.sheet.id }); break;
    case "swap-yes": {
      const p = P(UI.sheet.id), type = p.type === "ft" ? "di" : "ft";
      const res = await act(`/api/admin/players/${p.id}`, { type }, `${p.name} is now a ${type === "ft" ? "full-timer" : "drop-in"}`);
      if (res) closeSheet();
      break;
    }
    case "admin-toggle": {
      const p = P(UI.sheet.id);
      await act(`/api/admin/players/${p.id}`, { is_admin: !p.is_admin }, p.is_admin ? `${p.name} is no longer an admin` : `${p.name} is now an admin`);
      break;
    }
    case "sheet-remove": openSheet({ kind: "remove", id: UI.sheet.id }); break;
    case "remove-yes": {
      const p = P(UI.sheet.id);
      const res = await act(`/api/admin/players/${p.id}`, { active: false }, `${p.name} was removed from the group`);
      if (res) closeSheet();
      break;
    }
    case "add-open": openSheet({ kind: "add", type: "di" }); break;
    case "sched-open": openSheet({ kind: "schedule" }); break;
    case "me-open": openSheet({ kind: "me" }); break;
    case "theme": toggleTheme(); break;
    case "replay-intro": closeSheet(); setTimeout(tipoff, 250); break;
    case "cal-open": openSheet({ kind: "cal" }); break;
    case "copy-feed": copy($("feedurl").textContent.trim(), $("feedurl")); break;
    case "gym-open": openSheet({ kind: "gym" }); break;
    case "gym-map-remove": await act("/api/admin/venue-photo", { slot: "map", action: "remove" }, "Map removed"); break;
    case "gym-photo": await act("/api/admin/venue-photo", { action: v }, "Gym photo removed"); break;
    case "ann-clear": await act("/api/admin/announcement", { clear: true }, "Announcement removed"); break;
    case "charges-open": openSheet({ kind: "charges", id: Number(b.dataset.id) }); break;
    case "charge-paid": await act(`/api/admin/charges/${b.dataset.game}/${UI.sheet.id}`, { paid: v === "1" }, v === "1" ? "Marked paid" : "Marked unpaid"); break;
    case "paid-all": { const nm = P(UI.sheet.id)?.name || "Player"; await act(`/api/admin/players/${UI.sheet.id}/paid-all`, {}, `${nm} is paid up`); break; }
    case "install": {
      if (installPrompt) {
        const p = installPrompt; installPrompt = null;
        await p.prompt();
        const { outcome } = await p.userChoice.catch(() => ({}));
        if (outcome !== "accepted") renderSheet();
      } else openSheet({ kind: "install-help" });
      break;
    }
    case "wa-off": toast(`${name(Number(b.dataset.id))} hasn't turned on WhatsApp messages from admins yet. They can do it under their initials.`); break;
    case "wa-dm": {
      e.preventDefault();
      // Open the window now (inside the tap) so phones don't block it, then point it at WhatsApp.
      const win = window.open("", "_blank");
      try {
        const { url } = await call("/api/admin/wa-link", { player_id: Number(b.dataset.id), text: b.dataset.text });
        if (win) win.location.href = url; else location.href = url;
      } catch (err) { win?.close(); if (!(err instanceof SignedOut)) toast(err.message); }
      break;
    }
    case "wa-same": await act("/api/me/whatsapp", { wa_phone: null }, "WhatsApp will use your mobile number"); break;
    case "my-wa": await act("/api/me/whatsapp", { ok: v === "1", ...($("wa-phone")?.value.trim() ? { wa_phone: $("wa-phone").value.trim() } : {}) }, v === "1" ? "Admins can now message you on WhatsApp" : "WhatsApp messages from admins are off"); break;
    case "avatar-emoji": await act("/api/me/avatar", { kind: "emoji", emoji: v }, "Avatar updated"); break;
    case "avatar-initials": await act("/api/me/avatar", { kind: "initials" }, "Back to your initials"); break;
    case "avatar-reset": { const p = P(UI.sheet.id); await act(`/api/admin/players/${p.id}`, { avatar_reset: true }, `${p.name}'s picture was removed`); break; }
    case "phone-remove": await act("/api/me/phone", { phone: null }, "Your number was removed"); break;
    case "my-texts": await act("/api/me/texts", { on: v === "1" }, v === "1" ? "Text reminders are on" : "Text reminders are off"); break;
    case "texts-enabled": await act("/api/admin/texts", { enabled: v === "1" }, v === "1" ? "Text messages are on" : "Text messages are off"); break;
    case "texts-test": await act("/api/admin/texts/test", {}, "Test text sent. Check your phone."); break;
    case "game-open": openSheet({ kind: "game", id: Number(b.dataset.id) }); break;
    case "game-skip": {
      const id = UI.sheet.id, x = D.upcoming.find(g => g.id === id);
      const res = await act(`/api/admin/games/${id}`, { status: "cancelled", note: $("gm-note").value }, `${fmtShort(x.date)} is skipped`);
      if (res) closeSheet();
      break;
    }
    case "game-unskip": {
      const id = UI.sheet.id, x = D.upcoming.find(g => g.id === id);
      await act(`/api/admin/games/${id}`, { status: "open" }, `${fmtShort(x.date)} is back on`);
      break;
    }
    case "game-reset": await act(`/api/admin/games/${UI.sheet.id}`, { reset: true }, "Back to the default day and time"); break;
    case "add-type": UI.sheet.type = v; $("modal").querySelectorAll('[data-act="add-type"]').forEach(x => x.setAttribute("aria-pressed", x.dataset.v === v)); break;
  }
});

document.addEventListener("submit", async e => {
  e.preventDefault();
  if (e.target.id === "addform") {
    const nm = $("add-name").value.trim();
    const res = await act("/api/admin/players", { name: nm, type: UI.sheet.type }, `${nm} added`);
    if (res) openSheet({ kind: "link", id: res.player_id, name: nm, url: res.link, isNew: true });
  }
  if (e.target.id === "annform") {
    const text = $("ann-text").value.trim();
    if (!text) { toast("Write the announcement first."); return; }
    await act("/api/admin/announcement", { text, until_game_end: $("ann-until").checked }, "Announcement posted");
  }
  if (e.target.id === "feeform") await act("/api/admin/fees", { dropin: $("fee").value }, "Drop-in fee saved");
  if (e.target.id === "venueform") await act("/api/admin/venue", { name: $("v-name").value, address: $("v-address").value, notes: $("v-notes").value }, "Gym info saved");
  if (e.target.id === "waform") {
    const v = $("wa-phone").value.trim();
    if (!v) { toast("Type the WhatsApp number first."); return; }
    await act("/api/me/whatsapp", { wa_phone: v }, "WhatsApp number saved");
  }
  if (e.target.id === "nameform") {
    const v = $("my-name").value.trim();
    if (!v) { toast("Enter your name."); return; }
    await act("/api/me/name", { name: v }, "Name saved");
  }
  if (e.target.id === "phoneform") {
    const v = $("my-phone").value.trim();
    if (!v) { toast("Enter your mobile number, like 613-555-0123."); return; }
    const wasIntro = UI.sheet.kind === "intro";
    const res = await act("/api/me/phone", { phone: v }, "Number saved");
    if (res && wasIntro) { call("/api/me/intro", {}).catch(() => {}); UI.sheet = { kind: "me" }; renderSheet(); }
  }
  if (e.target.id === "schedform") {
    const step = k => ({ before: Number($(`sc-${k}-d`).value), time: $(`sc-${k}-t`).value });
    const res = await act("/api/admin/schedule", {
      weekday: Number($("sc-wd").value), start: $("sc-start").value, end: $("sc-end").value, cap: Number($("sc-cap").value),
      open: step("open"), reminder: step("reminder"), lock: step("lock"),
    }, "Default schedule saved");
    if (res) closeSheet();
  }
  if (e.target.id === "gameform") {
    await act(`/api/admin/games/${UI.sheet.id}`, { date: $("gm-date").value, start: $("gm-start").value, end: $("gm-end").value }, "Game updated");
  }
  if (e.target.id === "editform") {
    const id = UI.sheet.id;
    await act(`/api/admin/players/${id}`, { name: $("ed-name").value }, "Name saved");
  }
});

/** Crops a photo to a square and shrinks it to 192x192 on the phone, so uploads are small. */
async function shrinkPhoto(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error("That file couldn't be opened as a picture. Try a JPEG or PNG.")); i.src = url; });
    const S = 192, c = document.createElement("canvas"), side = Math.min(img.naturalWidth, img.naturalHeight);
    c.width = c.height = S;
    c.getContext("2d").drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, S, S);
    return c.toDataURL("image/jpeg", 0.85);
  } finally { URL.revokeObjectURL(url); }
}
/** Shrinks a landscape photo to at most 1200px wide for the gym picture. */
async function shrinkWide(file, quality = 0.8) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error("That file couldn't be opened as a picture. Try a JPEG or PNG.")); i.src = url; });
    const scale = Math.min(1, 1200 / img.naturalWidth), c = document.createElement("canvas");
    c.width = Math.round(img.naturalWidth * scale); c.height = Math.round(img.naturalHeight * scale);
    c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL("image/jpeg", quality);
  } finally { URL.revokeObjectURL(url); }
}
document.addEventListener("change", async e => {
  if (!["gym-photo", "gym-map"].includes(e.target.id) || !e.target.files?.[0]) return;
  const slot = e.target.id === "gym-map" ? "map" : "photo";
  try { const data = await shrinkWide(e.target.files[0], slot === "map" ? 0.9 : 0.8); await act("/api/admin/venue-photo", { slot, action: "upload", data }, slot === "map" ? "Map updated" : "Gym photo updated"); }
  catch (err) { toast(err.message); }
});
document.addEventListener("change", async e => {
  if (e.target.id !== "my-photo" || !e.target.files?.[0]) return;
  try { const data = await shrinkPhoto(e.target.files[0]); await act("/api/me/avatar", { kind: "photo", data }, "Photo updated"); }
  catch (err) { toast(err.message); }
});

document.addEventListener("change", e => {
  if (e.target.id !== "sc-wd") return;
  const wd = Number(e.target.value);
  document.querySelectorAll("#schedform select[data-step]").forEach(sel => [...sel.options].forEach(o => { o.textContent = stepDayLabel(Number(o.value), wd); }));
});

document.addEventListener("keydown", e => { if (e.key === "Escape" && UI.sheet) closeSheet(); });
addEventListener("popstate", () => { if (UI.sheet) closeSheet(true); });
if (history.state?.sheet) history.replaceState(null, "");   // a menu was open when the page reloaded
addEventListener("hashchange", () => { const t = location.hash.slice(1); if (TABS.includes(t) && t !== UI.tab) { UI.tab = t; render(); } });
document.addEventListener("visibilitychange", () => { if (!document.hidden) load(); });
setInterval(() => { if (!document.hidden && !UI.sheet && !UI.busy) load(); }, 60000);

// ---------- add to home screen ----------
// Android Chrome offers its own install prompt, which we hold on to and show when the
// button is tapped. iPhones have no such prompt, so they get step-by-step help instead.
let installPrompt = null;
const isStandalone = () => matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
const isTouch = () => matchMedia("(pointer: coarse)").matches;
const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
addEventListener("beforeinstallprompt", e => { e.preventDefault(); installPrompt = e; if (UI.sheet?.kind === "me") renderSheet(); });
addEventListener("appinstalled", () => { installPrompt = null; toast("Added to your home screen"); if (UI.sheet?.kind === "me") renderSheet(); });
function installGroup() {
  if (isStandalone()) return `<div class="group"><b>App on your phone</b><p>You're using Sunday Ball from your home screen.</p></div>`;
  return `<div class="group"><b>App on your phone</b>
    <p>Add Sunday Ball to your home screen to open it like an app, full screen, with its own icon.</p>
    <button class="btn dark block" type="button" data-act="install">Add to home screen</button></div>`;
}

// ---------- light / dark ----------
const SHARE_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12M8 7l4-4 4 4"/><path d="M6 11v9h12v-9"/></svg>';
const SUN = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4.2"/><path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M5.3 18.7l1.6-1.6M17.1 6.9l1.6-1.6"/></svg>';
const MOON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z"/></svg>';
const darkQuery = matchMedia("(prefers-color-scheme: dark)");
const isDark = () => (document.documentElement.dataset.theme || (darkQuery.matches ? "dark" : "light")) === "dark";
function paintThemeButton() {
  const dark = isDark(), b = $("theme-btn");
  b.innerHTML = dark ? SUN : MOON;   // shows what you'll switch to
  b.setAttribute("aria-label", dark ? "Switch to light mode" : "Switch to dark mode");
  b.title = b.getAttribute("aria-label");
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", dark ? "#111B2B" : "#FFFFFF");
}
function toggleTheme() {
  const next = isDark() ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem("sb-theme", next); } catch { /* private mode: just this visit */ }
  paintThemeButton();
}
darkQuery.addEventListener?.("change", paintThemeButton);
paintThemeButton();

// iPhone Safari ignores user-scalable=no, so block its pinch gestures directly.
for (const ev of ["gesturestart", "gesturechange", "gestureend"]) document.addEventListener(ev, e => e.preventDefault(), { passive: false });

// A hairline under the pinned top bar once the page scrolls under it.
addEventListener("scroll", () => document.querySelector(".topbar")?.classList.toggle("scrolled", scrollY > 4), { passive: true });

// The tip-off intro: plays every time the app is freshly opened (not when returning to an open app).
async function tipoff() {
  UI.tipoff = true;
  try { const { playIntro } = await import("/intro.js"); await playIntro(); }
  catch (e) { console.warn("Intro skipped", e); document.getElementById("intro-cover")?.remove(); }
  UI.tipoff = false;
  if (D) load();          // now show anything that waited, like the welcome prompt
}
if (new URLSearchParams(location.search).has("welcome")) history.replaceState(history.state, "", location.pathname + location.hash);
tipoff();

const start = location.hash.slice(1);
if (TABS.includes(start)) UI.tab = start;
load();
