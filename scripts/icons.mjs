// Gives a deployment its own home-screen icons without changing public/. Put PNGs named like
// the ones in public/ (icon-192.png, icon-512.png, apple-touch-icon.png, favicon-32.png) in a
// folder, then:
//   node scripts/icons.mjs path/to/folder
//   npx wrangler d1 execute DB --remote --file .seed/icons.sql
// Any file left out keeps the one in public/. Back to the defaults: node scripts/icons.mjs --remove
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ICON_FILES } from "../src/brand.js";

const args = process.argv.slice(2);
const remove = args.includes("--remove");
const dir = args.find(a => !a.startsWith("--"));
if (!remove && !dir) { console.error("Usage: node scripts/icons.mjs <folder with your PNG icons>   (or --remove)"); process.exit(1); }

const now = Date.now(), sql = [];
if (remove) sql.push("DELETE FROM images WHERE key LIKE 'icon:%';");
else for (const f of ICON_FILES) {
  const p = join(dir, f);
  if (!existsSync(p)) continue;
  const png = readFileSync(p);
  if (png.subarray(1, 4).toString() !== "PNG") { console.error(`${f} isn't a PNG.`); process.exit(1); }
  if (png.length > 60_000) { console.error(`${f} is ${Math.round(png.length / 1024)} KB. Keep each icon under 60 KB.`); process.exit(1); }
  sql.push(`INSERT INTO images (key, data, updated_at) VALUES ('icon:${f}', 'data:image/png;base64,${png.toString("base64")}', ${now}) ` +
    "ON CONFLICT (key) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at;");
  console.log(`  ${f} (${Math.round(png.length / 1024)} KB)`);
}
if (!sql.length) { console.error(`No icons found in ${dir} (looking for ${ICON_FILES.join(", ")}).`); process.exit(1); }
mkdirSync(".seed", { recursive: true });
writeFileSync(".seed/icons.sql", sql.join("\n") + "\n");
console.log("Wrote .seed/icons.sql. Next: npx wrangler d1 execute DB --remote --file .seed/icons.sql");
