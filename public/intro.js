// The tip-off intro: plays every time the app is freshly opened (and on demand
// from My details). Canvas only, no images or sound files.
const ORANGE = "#E4570F", NAVY = "#0A111D";
let W, H, DPR, L, cx, cy, u, R, rNet, rBall, logo, logoData, keys, edgeSamples, burnCv, burnCtx, LC;
let soundOn = true, actx = null, cv, ctx, onFinish = null;

// ---------- layout and the logo, drawn once to an offscreen canvas ----------
function layout() {
  DPR = Math.min(2, devicePixelRatio || 1); W = innerWidth; H = innerHeight;
  cv.width = W * DPR; cv.height = H * DPR; cv.style.width = W + "px"; cv.style.height = H + "px";
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  // Same size and place as the phone's launch screen (and the page's first frame): the app
  // icon, 240 px and centred, with the logo filling 80% of it. So the intro carries on from
  // the launch screen with nothing moving.
  const box = Math.min(240, W * 0.64);
  L = box * 0.8; cx = W / 2; cy = H / 2; u = L / 512;
  R = { x: cx, y: cy - L / 2 + 336 * u };   // rim: the centre-court line is the rim, the jump circle the net
  rNet = 70 * u; rBall = 52 * u;
  buildLogo();
}
function buildLogo() {
  LC = Math.round(L);
  logo = document.createElement("canvas"); logo.width = logo.height = LC;
  const g = logo.getContext("2d"), k = LC / 512;
  g.scale(k, k);
  g.fillStyle = "#FFFFFF"; g.textAlign = "center"; g.textBaseline = "alphabetic";
  // The group's logo letters (from the page; a deployment can set its own), shrunk to fit if long.
  const letters = document.querySelector('meta[name="logo-text"]')?.content || "SB";
  const font = px => `900 ${px}px 'Big Shoulders Display', 'Arial Narrow', Impact, sans-serif`;
  g.font = font(270);
  const fit = Math.min(270, Math.floor(270 * 400 / g.measureText(letters).width));
  if (fit < 270) g.font = font(fit);
  g.fillText(letters, 256, 300);
  g.strokeStyle = ORANGE; g.lineWidth = 18; g.lineCap = "butt";
  g.beginPath(); g.moveTo(72, 336); g.lineTo(440, 336); g.stroke();
  g.beginPath(); g.arc(256, 336, 70, 0, Math.PI); g.stroke();
  g.fillStyle = ORANGE; g.beginPath(); g.arc(256, 336, 22, 0, Math.PI * 2); g.fill();
  logoData = g.getImageData(0, 0, LC, LC);
  // Burn order: starts where the ball went through (the rim) and spreads with a ragged, noisy edge.
  keys = new Float32Array(LC * LC); edgeSamples = [];
  const rx = 256 * k, ry = 336 * k, maxD = Math.hypot(LC, LC) * 0.62;
  const noise = makeNoise(LC);
  for (let y = 0; y < LC; y++) for (let x = 0; x < LC; x++) {
    const i = y * LC + x;
    keys[i] = 0.62 * Math.min(1, Math.hypot(x - rx, y - ry) / maxD) + 0.38 * noise(x, y);
    if (logoData.data[i * 4 + 3] > 120 && (x + y) % 3 === 0) edgeSamples.push(i);
  }
  burnCv = document.createElement("canvas"); burnCv.width = burnCv.height = LC; burnCtx = burnCv.getContext("2d");
}
function makeNoise(size) {         // smooth value noise, three octaves, 0..1
  const N = 64, lat = Float32Array.from({ length: N * N }, Math.random);
  const v = (x, y) => lat[((y % N) + N) % N * N + ((x % N) + N) % N];
  const s = t => t * t * (3 - 2 * t);
  const one = (x, y) => { const xi = Math.floor(x), yi = Math.floor(y), fx = s(x - xi), fy = s(y - yi);
    return (v(xi, yi) * (1 - fx) + v(xi + 1, yi) * fx) * (1 - fy) + (v(xi, yi + 1) * (1 - fx) + v(xi + 1, yi + 1) * fx) * fy; };
  const f = size / 7;
  return (x, y) => (one(x / f, y / f) * 0.55 + one(x / f * 2.1, y / f * 2.1) * 0.3 + one(x / f * 4.3, y / f * 4.3) * 0.15);
}

// ---------- sound (Web Audio, synthesized: no files) ----------
function noiseBuf(sec) { const b = actx.createBuffer(1, actx.sampleRate * sec, actx.sampleRate), d = b.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1; return b; }
function swish() {               // the net: a fast, airy band of noise sweeping down
  if (!soundOn || !actx) return;
  const t = actx.currentTime;
  for (const [f0, f1, q, vol, len] of [[7000, 1800, 0.9, 0.55, 0.32], [3800, 900, 1.6, 0.35, 0.26]]) {
    const src = actx.createBufferSource(); src.buffer = noiseBuf(0.5);
    const bp = actx.createBiquadFilter(); bp.type = "bandpass"; bp.Q.value = q;
    bp.frequency.setValueAtTime(f0, t); bp.frequency.exponentialRampToValueAtTime(f1, t + len);
    const g = actx.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vol, t + 0.025); g.gain.exponentialRampToValueAtTime(0.0001, t + len);
    src.connect(bp).connect(g).connect(actx.destination); src.start(t); src.stop(t + len + 0.05);
  }
}
function whoosh(t0, len, vol, f0, f1) {
  const t = actx.currentTime + t0, src = actx.createBufferSource(); src.buffer = noiseBuf(len + 0.1);
  const lp = actx.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.setValueAtTime(f0, t); lp.frequency.exponentialRampToValueAtTime(f1, t + len * 0.6);
  const g = actx.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vol, t + len * 0.25); g.gain.exponentialRampToValueAtTime(0.0001, t + len);
  src.connect(lp).connect(g).connect(actx.destination); src.start(t); src.stop(t + len + 0.1);
}
function fireSound() {           // ignition whoosh plus a little crackle
  if (!soundOn || !actx) return;
  whoosh(0, 1.6, 0.4, 250, 1100);
  for (let i = 0; i < 26; i++) {
    const t = actx.currentTime + 0.1 + Math.random() * 1.5, src = actx.createBufferSource(); src.buffer = noiseBuf(0.03);
    const hp = actx.createBiquadFilter(); hp.type = "highpass"; hp.frequency.value = 2500 + Math.random() * 3000;
    const g = actx.createGain(); g.gain.setValueAtTime(0.08 + Math.random() * 0.12, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.03);
    src.connect(hp).connect(g).connect(actx.destination); src.start(t);
  }
}
function flightSound() { if (soundOn && actx) whoosh(0.9, 0.7, 0.18, 400, 2600); }

// ---------- particles ----------
let parts = [];
function emit(p) { parts.push(p); }
function drawParts(dt) {
  const keep = [];
  for (const p of parts) {
    p.age += dt; if (p.age >= p.life) continue; keep.push(p);
    p.x += p.vx * dt; p.y += p.vy * dt; p.vy += (p.g || 0) * dt; p.vx *= 0.985;
    const f = p.age / p.life;
    if (p.kind === "smoke") {
      ctx.globalCompositeOperation = "source-over";
      const r = Math.min(p.size, 46 * u) * (1 + f * 1.6), a = 0.13 * (1 - f) * Math.min(1, f * 6);
      const gr = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r);
      gr.addColorStop(0, `rgba(70,74,86,${a})`); gr.addColorStop(1, "rgba(70,74,86,0)");
      ctx.fillStyle = gr; ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, 7); ctx.fill();
    } else if (p.kind === "spark") {
      ctx.globalCompositeOperation = "lighter";
      ctx.fillStyle = `rgba(255,${200 - f * 120 | 0},${80 - f * 60 | 0},${1 - f})`;
      ctx.beginPath(); ctx.arc(p.x, p.y, p.size * (1 - f * 0.6), 0, 7); ctx.fill();
    } else {     // fire: white-hot, yellow, orange, red as it ages
      ctx.globalCompositeOperation = "lighter";
      const r = p.size * (1 - f * 0.55);
      const c = f < 0.18 ? [255, 244, 214] : f < 0.42 ? [255, 186, 60] : f < 0.7 ? [245, 96, 24] : [170, 40, 16];
      const a = (1 - f) * (p.a || 0.85);
      const gr = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r);
      gr.addColorStop(0, `rgba(${c[0]},${c[1]},${c[2]},${a})`); gr.addColorStop(0.5, `rgba(${c[0]},${c[1]},${c[2]},${a * 0.45})`); gr.addColorStop(1, `rgba(${c[0]},${c[1]},${c[2]},0)`);
      ctx.fillStyle = gr; ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, 7); ctx.fill();
      if (f > 0.6 && Math.random() < 0.035) emit({ kind: "smoke", x: p.x, y: p.y, vx: p.vx * 0.3, vy: -30 - Math.random() * 30, size: r * 0.9, age: 0, life: 1 + Math.random() * 0.8 });
    }
  }
  ctx.globalCompositeOperation = "source-over";
  parts = keep;
}

// ---------- the ball ----------
// The seams live on a 3D sphere and are projected each frame, so the ball can spin
// for real. It's held the way a shooter holds a free throw, seen from behind the
// shooter: one main seam runs straight up the middle toward the rim and the spin
// rides along it, the other main seam crosses it, and the two curved seams sit left
// and right. Backspin turns the ball about the left-right axis: the top rolls back
// toward the viewer, so the crossing seam sweeps up the ball while the middle seam
// and the curved seams stay put, as on a well-shot free throw.
const SEAMS = (() => {
  const N = 72, T = i => i / N * Math.PI * 2, lines = [];
  lines.push(Array.from({ length: N + 1 }, (_, i) => [0, Math.cos(T(i)), Math.sin(T(i))]));   // middle seam (x = 0)
  lines.push(Array.from({ length: N + 1 }, (_, i) => [Math.cos(T(i)), 0, Math.sin(T(i))]));   // crossing seam (y = 0)
  for (const side of [1, -1]) lines.push(Array.from({ length: N + 1 }, (_, i) => {             // curved seams around the spin axis
    const t = T(i), th = (40 + 25 * Math.cos(t) ** 2) * Math.PI / 180;                       // bow outward at the middle: ( | )
    return [side * Math.cos(th), Math.sin(th) * Math.cos(t), Math.sin(th) * Math.sin(t)];
  }));
  return lines;
})();
function drawSeams(x, y, r, spin) {
  const c = Math.cos(spin), s = Math.sin(spin);
  ctx.lineCap = "round"; ctx.strokeStyle = "rgba(25,16,10,.9)";
  for (const line of SEAMS) {
    for (let i = 0; i < line.length - 1; i++) {
      const [x1, y1, z1] = line[i], [x2, y2, z2] = line[i + 1];
      const a = [x1, y1 * c - z1 * s, y1 * s + z1 * c], b = [x2, y2 * c - z2 * s, y2 * s + z2 * c];
      const z = (a[2] + b[2]) / 2; if (z <= 0) continue;                                       // back of the ball
      ctx.lineWidth = Math.max(0.8, r * 0.055 * (0.35 + 0.65 * z));                            // thinner toward the edge
      ctx.beginPath(); ctx.moveTo(x + a[0] * r, y - a[1] * r); ctx.lineTo(x + b[0] * r, y - b[1] * r); ctx.stroke();
    }
  }
}
function drawBall(x, y, r, ang, heat, alpha = 1) {
  ctx.save(); ctx.globalAlpha = alpha;
  if (heat > 0.02) {                // comet head glow
    ctx.globalCompositeOperation = "lighter";
    const gr = ctx.createRadialGradient(x, y, r * 0.6, x, y, r * (1.6 + heat));
    gr.addColorStop(0, `rgba(255,170,60,${0.55 * heat})`); gr.addColorStop(1, "rgba(255,90,20,0)");
    ctx.fillStyle = gr; ctx.beginPath(); ctx.arc(x, y, r * (1.6 + heat), 0, 7); ctx.fill();
    ctx.globalCompositeOperation = "source-over";
  }
  const gr = ctx.createRadialGradient(x - r * 0.38, y - r * 0.42, r * 0.1, x, y, r);
  gr.addColorStop(0, "#FF9A52"); gr.addColorStop(0.55, "#E4570F"); gr.addColorStop(1, "#8F3205");
  ctx.fillStyle = gr; ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.fill();
  ctx.save(); ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.clip();
  drawSeams(x, y, r, ang);
  ctx.restore();
  if (heat > 0.3) {                 // the ball itself glowing hot
    ctx.globalCompositeOperation = "lighter";
    ctx.fillStyle = `rgba(255,190,90,${(heat - 0.3) * 0.5})`; ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.fill();
  }
  ctx.restore();
}

// ---------- the logo: drawn in two parts so the ball can pass behind the net ----------
function drawLogo(src, alpha, netStretch) {
  const x0 = cx - L / 2, y0 = cy - L / 2, line = 336 * u;
  ctx.save(); ctx.globalAlpha = alpha;
  ctx.drawImage(src, 0, 0, LC, LC * 336 / 512, x0, y0, L, line);                     // above the rim
  ctx.restore();
  return () => {                     // below the rim (the net), drawn after the ball
    ctx.save(); ctx.globalAlpha = alpha;
    const h = L - line;
    ctx.drawImage(src, 0, LC * 336 / 512, LC, LC - LC * 336 / 512, x0, y0 + line, L, h * netStretch);
    ctx.restore();
  };
}
function renderBurn(b) {             // b: burn front, 0..1.2
  const out = burnCtx.createImageData(LC, LC), d = out.data, s = logoData.data;
  for (let i = 0, n = LC * LC; i < n; i++) {
    const a = s[i * 4 + 3]; if (!a) continue;
    const k = keys[i] - b, j = i * 4;
    if (k < 0) continue;                                                               // burned away
    let r = s[j], g = s[j + 1], bl = s[j + 2], al = a;
    if (k < 0.03) { const t = k / 0.03; r = 255; g = 250 - 90 * t; bl = 190 - 160 * t; }       // glowing edge
    else if (k < 0.075) { const t = (k - 0.03) / 0.045; r = 120 * (1 - t) + 25 * t; g = 30 * (1 - t) + 18 * t; bl = 10 + 6 * t; }  // ember to char
    else if (k < 0.16) { const t = (k - 0.075) / 0.085; r = r * t + 60 * (1 - t); g = g * t + 36 * (1 - t); bl = bl * t + 20 * (1 - t); } // scorch
    d[j] = r; d[j + 1] = g; d[j + 2] = bl; d[j + 3] = al;
  }
  burnCtx.putImageData(out, 0, 0);
}

// ---------- timeline ----------
const T = { logoIn: 0.001, launch: 0.35, hit: 2.05, through: 0.32, burnStart: 2.15, burnEnd: 4.05, fadeOut: 3.85, done: 4.7 };
let t0 = 0, last = 0, running = false, swished = false, ignited = false, flew = false, prev = null;
const bez = (p, a, c, b) => (1 - p) * (1 - p) * a + 2 * (1 - p) * p * c + p * p * b;

function frame(now) {
  if (!running) return;
  const t = (now - t0) / 1000, dt = Math.min(0.05, (now - last) / 1000); last = now;
  ctx.fillStyle = NAVY; ctx.fillRect(0, 0, W, H);
  const intro = Math.min(1, t / T.logoIn), ease = 1 - Math.pow(1 - intro, 3);

  // logo (or what's left of it), with the net swaying after the swish
  const sinceHit = t - T.hit;
  const netStretch = sinceHit > 0 && sinceHit < 0.9 ? 1 + 0.22 * Math.exp(-sinceHit * 5) * Math.sin(sinceHit * 26) + 0.12 * Math.exp(-sinceHit * 4) : 1;
  let src = logo;
  if (t > T.burnStart) { const b = (t - T.burnStart) / (T.burnEnd - T.burnStart) * 1.22 - 0.04; renderBurn(b); src = burnCv;
    if (b < 1.1) for (let n = 0; n < 7; n++) {           // flames rising off the burning edge
      const i = edgeSamples[(Math.random() * edgeSamples.length) | 0], k = keys[i] - b;
      if (k < 0 || k > 0.05) continue;
      const lx = cx - L / 2 + (i % LC) * L / LC, ly = cy - L / 2 + ((i / LC) | 0) * L / LC;
      emit({ kind: "fire", x: lx, y: ly, vx: (Math.random() - 0.5) * 30, vy: -70 - Math.random() * 90, size: (10 + Math.random() * 16) * u * 2.2, age: 0, life: 0.45 + Math.random() * 0.45, a: 0.7 });
      if (Math.random() < 0.25) emit({ kind: "spark", x: lx, y: ly, vx: (Math.random() - 0.5) * 80, vy: -120 - Math.random() * 160, g: 60, size: 1.2 + Math.random() * 1.6, age: 0, life: 0.6 + Math.random() * 0.7 });
    }
  }
  const logoAlpha = ease * (t > T.fadeOut ? Math.max(0, 1 - (t - T.fadeOut) / 0.4) : 1);
  ctx.save();   // the logo fades in where it is: no scaling, so it never shifts or resizes
  const drawNet = drawLogo(src, logoAlpha, netStretch);
  ctx.restore();

  // the ball: flies in huge from the foreground, arcs, shrinks, speeds up, catches fire
  const P0 = { x: cx - W * 0.06, y: H + Math.max(W, H) * 0.2 }, P1 = { x: cx + W * 0.07, y: cy - H * 1.02 };
  const bigR = Math.max(W, H) * 0.42;
  let ballState = null;
  if (t > T.launch && t < T.hit) {
    const q = (t - T.launch) / (T.hit - T.launch), p = Math.pow(q, 1.85);   // accelerates into the basket
    const x = bez(p, P0.x, P1.x, R.x), y = bez(p, P0.y, P1.y, R.y), r = rBall + (bigR - rBall) * Math.pow(1 - p, 1.7);
    const heat = Math.max(0, Math.min(1, (p - 0.42) / 0.45));
    if (prev && heat > 0) {
      const vx = (x - prev.x) / dt, vy = (y - prev.y) / dt, sp = Math.hypot(vx, vy) || 1;
      const n = 2 + Math.round(heat * 9);
      for (let i = 0; i < n; i++) {
        const back = Math.random() * r * 0.8;
        emit({ kind: "fire", x: x - vx / sp * back + (Math.random() - 0.5) * r * 0.9, y: y - vy / sp * back + (Math.random() - 0.5) * r * 0.9,
          vx: -vx * (0.08 + Math.random() * 0.12) + (Math.random() - 0.5) * 40, vy: -vy * (0.08 + Math.random() * 0.12) - 30 - Math.random() * 40,
          size: r * (0.7 + Math.random() * 0.7) * (0.6 + heat * 0.8), age: 0, life: 0.3 + Math.random() * 0.35 * (0.5 + heat) });
      }
      if (Math.random() < heat * 0.6) emit({ kind: "spark", x, y, vx: -vx * 0.15 + (Math.random() - 0.5) * 120, vy: -vy * 0.15 + (Math.random() - 0.5) * 120, g: 80, size: 1.5 + Math.random() * 2, age: 0, life: 0.4 + Math.random() * 0.5 });
    }
    prev = { x, y };
    ballState = { x, y, r, ang: 0.35 + q * Math.PI * 5, heat, alpha: 1, front: true };
    if (!flew && q > 0.35) { flew = true; flightSound(); }
  } else if (sinceHit >= 0 && sinceHit < T.through) {
    const q = sinceHit / T.through;
    ballState = { x: R.x, y: R.y + q * (rNet + rBall * 1.6), r: rBall * (1 - q * 0.15), ang: 0.35 + Math.PI * 5 + q * 1.2, heat: Math.max(0, 1 - q * 2.5), alpha: 1 - q, front: false };
    if (!swished) {
      swished = true; swish();
      for (let i = 0; i < 26; i++) emit({ kind: "fire", x: R.x + (Math.random() - 0.5) * rNet * 1.6, y: R.y + Math.random() * rNet, vx: (Math.random() - 0.5) * 160, vy: -60 - Math.random() * 120, size: rNet * (0.5 + Math.random() * 0.6), age: 0, life: 0.35 + Math.random() * 0.4 });
    }
  }
  if (!ignited && t > T.burnStart) { ignited = true; fireSound(); }

  drawParts(dt);                                     // fire and smoke behind the ball
  if (ballState && !ballState.front) drawBall(ballState.x, ballState.y, ballState.r, ballState.ang, ballState.heat, ballState.alpha);
  drawNet();                                         // the net in front of a ball going through it
  if (ballState && ballState.front) drawBall(ballState.x, ballState.y, ballState.r, ballState.ang, ballState.heat, ballState.alpha);

  if (sinceHit >= 0 && sinceHit < 0.35) {            // flash where it went through
    const f = sinceHit / 0.35; ctx.globalCompositeOperation = "lighter";
    const gr = ctx.createRadialGradient(R.x, R.y, 0, R.x, R.y, rNet * (1.5 + f * 3));
    gr.addColorStop(0, `rgba(255,220,150,${0.7 * (1 - f)})`); gr.addColorStop(1, "rgba(255,120,40,0)");
    ctx.fillStyle = gr; ctx.beginPath(); ctx.arc(R.x, R.y, rNet * (1.5 + f * 3), 0, 7); ctx.fill(); ctx.globalCompositeOperation = "source-over";
  }

  if (t > T.fadeOut) cv.parentElement.style.opacity = String(Math.max(0, 1 - (t - T.fadeOut) / 0.65));
  if ((t > T.done && !parts.length) || t > T.done + 1.2) { finish(); return; }
  requestAnimationFrame(frame);
}

function finish() {
  if (!running && !onFinish) return;
  running = false;
  const wrap = cv?.parentElement;
  if (wrap) { wrap.style.opacity = "0"; setTimeout(() => wrap.remove(), 350); }
  removeEventListener("resize", onResize);
  actx?.close?.().catch(() => {}); actx = null;
  const done = onFinish; onFinish = null; done?.();
}
// Only re-lay out when the width changes. On phones the address bar sliding away changes
// the height mid-intro, and re-centring then would make the logo jump.
const onResize = () => { if (running && innerWidth !== W) layout(); };

/**
 * Plays the tip-off intro over the app: a flaming basketball arcs into the logo,
 * swishes, and the logo burns away. Resolves when it's finished (about 4.7 s).
 * Sound plays where the phone allows it (a tap during the intro turns it on if not).
 */
export function playIntro() {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) { document.getElementById("intro-cover")?.remove(); return Promise.resolve(); }
  return new Promise(async resolve => {
    onFinish = resolve;
    // Reuse the dark cover the page shows instantly on open (no flash of the app), or make one.
    let wrap = document.getElementById("intro-cover");
    if (!wrap) { wrap = document.createElement("div"); wrap.className = "intro"; document.body.appendChild(wrap); }
    wrap.removeAttribute("id"); wrap.style.opacity = "1";
    wrap.innerHTML = `<canvas aria-hidden="true"></canvas>`;
    cv = wrap.querySelector("canvas"); ctx = cv.getContext("2d");
    try {
      actx = new (window.AudioContext || window.webkitAudioContext)();
      if (actx.state !== "running") {
        actx.resume().catch(() => {});
        const unlock = () => actx?.resume().catch(() => {});
        wrap.addEventListener("pointerdown", unlock, { once: true });
      }
    } catch { actx = null; }
    try { await document.fonts.load("900 40px 'Big Shoulders Display'"); } catch { /* fallback face */ }
    layout(); parts = []; prev = null; swished = ignited = flew = false;
    addEventListener("resize", onResize);
    running = true; t0 = last = performance.now(); requestAnimationFrame(frame);
  });
}

