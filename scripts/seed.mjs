// Builds .seed/seed.sql from a roster CSV and writes each player's personal
// link to .seed/links.txt (live) or .seed/links.local.txt (localhost).
// Keep both private: the links sign people in.
//
//   node scripts/seed.mjs [roster.csv] [--demo] [--reset] [--base https://your.app]
//
// CSV columns: name,phone,type(ft|di),admin(yes|blank)
// --demo   adds 8 past Sundays of attendance and sample answers for this week
// --reset  wipes all tables first (local testing only)
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { randomBytes, createHash } from "node:crypto";
import { addDays, localDate, mondayOf, dateInWeek } from "../src/time.js";

const args = process.argv.slice(2);
const flag = f => args.includes(f);
const baseIdx = args.indexOf("--base");
const base = baseIdx > -1 ? args[baseIdx + 1] : "http://localhost:8787";
const file = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--base")
  ?? (existsSync("roster.csv") ? "roster.csv" : "roster.sample.csv");

const q = v => v == null ? "NULL" : typeof v === "number" ? String(v) : `'${String(v).replace(/'/g, "''")}'`;
export function normalizePhone(raw) {
  const d = String(raw || "").replace(/\D/g, "");
  if (d.length === 10) return "+1" + d;
  if (d.length === 11 && d[0] === "1") return "+" + d;
  return d ? "+" + d : null;
}

const lines = readFileSync(file, "utf8").trim().split(/\r?\n/);
const head = lines.shift().split(",").map(s => s.trim().toLowerCase());
const col = n => head.indexOf(n);
const now = Date.now();
const sql = [];
const links = [];

if (flag("--reset")) sql.push(...["audit_log", "attendance", "signups", "game_steps", "games", "sessions", "players", "settings"].map(t => `DELETE FROM ${t};`));

const players = lines.filter(l => l.trim()).map((line, i) => {
  const c = line.split(",").map(s => s.trim());
  const type = (c[col("type")] || "").toLowerCase().startsWith("f") ? "ft" : "di";
  const p = { id: i + 1, name: c[col("name")], phone: normalizePhone(c[col("phone")]), type, admin: /^(y|yes|true|1)$/i.test(c[col("admin")] || "") ? 1 : 0 };
  const code = randomBytes(18).toString("base64url");
  const hash = createHash("sha256").update(code).digest("hex");
  sql.push(`INSERT INTO players (id,name,phone,type,is_admin,link_hash,created_at) VALUES (${p.id},${q(p.name)},${q(p.phone)},${q(type)},${p.admin},${q(hash)},${now});`);
  links.push(`${p.name}${p.admin ? " (admin)" : ""}\t${base}/p/${code}`);
  return p;
});

if (flag("--demo")) {
  const sunday = dateInWeek(mondayOf(localDate(now)), 0);   // this week's Sunday
  const ft = players.filter(p => p.type === "ft"), di = players.filter(p => p.type === "di");
  // Past 8 Sundays, deterministic but varied.
  for (let w = 8; w >= 1; w--) {
    const date = addDays(sunday, -7 * w), gid = 100 + w;
    sql.push(`INSERT INTO games (id,date,cap,priority_open,locked,finished_at,created_at) VALUES (${gid},'${date}',15,0,1,${now},${now});`);
    let count = 0;
    ft.forEach((p, i) => { if ((i * 7 + w * 3) % 10 < 8) { sql.push(`INSERT INTO attendance VALUES (${gid},${p.id},'ft');`); count++; } });
    di.forEach((p, i) => { if (count < 15 && (i + w) % 3 !== 0) { sql.push(`INSERT INTO attendance VALUES (${gid},${p.id},'di');`); count++; } });
  }
  // This week: everyone in except the last two full-timers; first five drop-ins asked.
  sql.push(`INSERT INTO games (id,date,cap,priority_open,locked,created_at) VALUES (200,'${sunday}',15,1,0,${now});`);
  ft.forEach((p, i) => { if (i < ft.length - 1) sql.push(`INSERT INTO signups VALUES (200,${p.id},'${i === ft.length - 2 ? "out" : "in"}',${now - 400000 + i * 1000});`); });
  di.slice(0, 5).forEach((p, i) => sql.push(`INSERT INTO signups VALUES (200,${p.id},'requested',${now - 200000 + i * 1000});`));
}

mkdirSync(".seed", { recursive: true });
writeFileSync(".seed/seed.sql", sql.join("\n") + "\n");
const linksFile = /localhost|127\.0\.0\.1/.test(base) ? ".seed/links.local.txt" : ".seed/links.txt";
writeFileSync(linksFile, links.join("\n") + "\n", { mode: 0o600 });
console.log(`Seeded ${players.length} players from ${file}${flag("--demo") ? " with demo data" : ""}.`);
console.log(`Personal links written to ${linksFile} (private).`);
