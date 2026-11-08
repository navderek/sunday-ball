// The group's name and logo come from the deployment's settings, never from the code.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fakeD1 } from "./helpers.js";
import worker from "../src/worker.js";
import { brand, brandPage } from "../src/brand.js";
import { sendText } from "../src/sms.js";

const APP = "https://ball.example.dev";
const PUBLIC = new URL("../public/", import.meta.url);
const CUSTOM = { GROUP_NAME: "Riverside <Sunday> Ball", WORDMARK: "RIVERSIDE / SUNDAY BALL", LOGO_TEXT: "RS" };

// Stands in for Cloudflare's static files (public/).
const assets = { fetch: async req => {
  const path = new URL(req.url).pathname, file = path === "/" ? "index.html" : path.slice(1);
  try { return new Response(readFileSync(new URL(file, PUBLIC)), { headers: { etag: '"public"', "x-from": "assets" } }); }
  catch { return new Response("Not found", { status: 404 }); }
} };
const get = (env, path, init) => worker.fetch(new Request(APP + path, init), env);

let sent = [];
beforeEach(() => {
  sent = [];
  globalThis.fetch = async (url, opts) => {
    sent.push(Object.fromEntries(new URLSearchParams(opts.body)).Body);
    return new Response(JSON.stringify({ sid: "SM1", status: "queued" }), { status: 201 });
  };
});

test("with no settings the app is plain Sunday Ball with SB", async () => {
  assert.deepEqual(brand({}), { name: "Sunday Ball", wordmark: ["SUNDAY", "BALL"], logo: "SB" });
  const env = fakeD1({ ASSETS: assets });
  const page = await (await get(env, "/")).text();
  assert.equal(page, readFileSync(new URL("index.html", PUBLIC), "utf8"), "the page is served as it is");
  assert.match(page, /<title>Sunday Ball<\/title>/);
  assert.match(page, /<meta name="logo-text" content="SB">/);
  assert.match(page, /class="wm-name"[^>]*>SUNDAY</);
  assert.match(page, /class="wm-sub"[^>]*>BALL</);
  assert.equal(JSON.parse(await (await get(env, "/manifest.webmanifest")).text()).name, "Sunday Ball");
});

test("a deployment's name and logo go into the page, the manifest, the calendar and link previews", async () => {
  assert.deepEqual(brand(CUSTOM).wordmark, ["RIVERSIDE", "SUNDAY BALL"]);
  const env = fakeD1({ ASSETS: assets, ...CUSTOM });
  const res = await get(env, "/");
  assert.equal(res.headers.get("etag"), null, "the changed page doesn't keep the file's etag");
  const page = await res.text();
  assert.match(page, /<title>Riverside &lt;Sunday&gt; Ball<\/title>/, "the name is escaped");
  assert.match(page, /<meta name="application-name" content="Riverside &lt;Sunday&gt; Ball">/);
  assert.match(page, /<meta name="logo-text" content="RS">/);
  assert.match(page, /<a class="brand"[^>]*aria-label="Riverside &lt;Sunday&gt; Ball"/);
  assert.match(page, /class="wm-name"[^>]*>RIVERSIDE</);
  assert.match(page, /class="wm-sub"[^>]*>SUNDAY BALL</);
  assert.equal(page, brandPage(readFileSync(new URL("index.html", PUBLIC), "utf8"), brand(CUSTOM)));
  assert.equal((await get(env, "/index.html", { method: "HEAD" })).status, 200);

  const manifest = JSON.parse(await (await get(env, "/manifest.webmanifest")).text());
  assert.equal(manifest.name, "Riverside <Sunday> Ball");
  assert.equal(manifest.short_name, "Sunday Ball", "everything else in the manifest stays");

  const ics = await (await get(env, "/cal/games.ics")).text();
  assert.match(ics, /X-WR-CALNAME:Riverside <Sunday> Ball/);

  const preview = await (await get(env, "/p/abcdefghijklmnop1234", { headers: { "user-agent": "WhatsApp/2.23" } })).text();
  assert.match(preview, /<title>Riverside &lt;Sunday&gt; Ball<\/title>/);
});

test("texts start with the group's name", async () => {
  const player = { id: 1, name: "Alex Smith", phone: "+16135550101" };
  const twilio = { TWILIO_ACCOUNT_SID: "AC1", TWILIO_AUTH_TOKEN: "t", TWILIO_SMS_FROM: "+16135550000", APP_URL: APP };
  for (const [vars, prefix] of [[{}, "Sunday Ball: hi Alex"], [CUSTOM, "Riverside <Sunday> Ball: hi Alex"]]) {
    const env = fakeD1({ ...twilio, ...vars });
    env.db.exec("INSERT INTO players (id,name,phone,type,created_at) VALUES (1,'Alex Smith','+16135550101','ft',0)");
    await sendText(env, { player, kind: "test", force: true });
    assert.ok(sent.at(-1).startsWith(prefix), sent.at(-1));
  }
});

test("a deployment's own icons come from the images table; otherwise the ones in public/", async () => {
  const env = fakeD1({ ASSETS: assets });
  const fallback = await get(env, "/icon-512.png");
  assert.equal(fallback.headers.get("x-from"), "assets");
  const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
  env.db.prepare("INSERT INTO images (key, data, updated_at) VALUES (?, ?, 0)").run("icon:icon-512.png", "data:image/png;base64," + png.toString("base64"));
  const own = await get(env, "/icon-512.png");
  assert.equal(own.headers.get("content-type"), "image/png");
  assert.deepEqual(Buffer.from(await own.arrayBuffer()), png);
  assert.equal((await (await get(env, "/icon-512.png", { method: "HEAD" })).arrayBuffer()).byteLength, 0);
  assert.equal((await get(env, "/icon-192.png")).headers.get("x-from"), "assets", "icons it didn't upload stay as they are");
});
