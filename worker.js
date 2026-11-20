// جزیره‌ی نقاش‌ها - سرور چندنفره روی Cloudflare (Durable Objects + Workers AI)
// Lobby: یک لابی مشترک برای همه + صف ۱ دقیقه‌ای | Room: یک سرور ۱۰ نفره برای هر بازی

const MODEL = "@cf/meta/llama-4-scout-17b-16e-instruct";
const KINDS = ["lava", "meteor", "tornado", "lightning", "poison", "ice"];
const FA = { lava: ["🌋", "آتشفشان"], meteor: ["☄️", "شهاب‌سنگ"], tornado: ["🌪️", "گردباد"], lightning: ["⚡", "صاعقه"], poison: ["☣️", "ابر سمی"], ice: ["❄️", "کولاک یخی"] };
const COLS = ["#e63946", "#2a9d8f", "#7b2cbf", "#f77f00", "#3a86ff", "#ef476f", "#06d6a0", "#8d99ae"];
const PAD = { x1: -150, x2: 150, y1: -430, y2: -250 };
const rr = (a, b) => a + Math.random() * (b - a);
const pick = (a) => a[(Math.random() * a.length) | 0];
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const PROMPT =
  "You see a quick drawing made by a player in a battle game. Decide what it depicts. Reply with ONLY JSON: " +
  '{"guess":"short Persian name of what you think it is","options":[{"kind":"one of lava,meteor,tornado,lightning,poison,ice","title":"short Persian name of a disaster or creature related to the drawing","emoji":"one emoji"}, x3]}. ' +
  "The 3 kinds must be different and fit the drawing (volcano/fire -> lava, rock/space -> meteor, wind/cloud -> tornado, storm/electricity -> lightning, skull/snake/mushroom -> poison, snow/winter -> ice).";

function sendTo(ws, o) { try { ws.send(JSON.stringify(o)); } catch (e) {} }
const cleanName = (s) => String(s || "بازیکن").replace(/[<>]/g, "").trim().slice(0, 12) || "بازیکن";

export default {
  async fetch(req, env) {
    const u = new URL(req.url);
    if (req.headers.get("Upgrade") !== "websocket") return new Response("not found", { status: 404 });
    if (u.pathname === "/ws/lobby") return env.LOBBY.get(env.LOBBY.idFromName("main")).fetch(req);
    if (u.pathname.startsWith("/ws/room/")) {
      const id = u.pathname.split("/")[3] || "x";
      return env.ROOM.get(env.ROOM.idFromName(id)).fetch(req);
    }
    return new Response("not found", { status: 404 });
  },
};

function upgrade() {
  const pair = new WebSocketPair();
  const [client, server] = Object.values(pair);
  server.accept();
  return { client, server };
}

// ---------------- لابی اصلی ----------------
export class Lobby {
  constructor(state, env) { this.pl = new Map(); this.qt = 60; this.n = 0; this.iv = null; }
  async fetch(req) {
    const { client, server } = upgrade();
    const id = crypto.randomUUID().slice(0, 8);
    const p = { id, ws: server, n: "بازیکن", col: pick(COLS), x: 0, y: 350 };
    this.pl.set(id, p);
    sendTo(server, { t: "init", id, col: p.col });
    server.addEventListener("message", (e) => {
      let m; try { m = JSON.parse(e.data); } catch (x) { return; }
      if (m.t === "hi") p.n = cleanName(m.name);
      if (m.t === "pos") { p.x = clamp(+m.x || 0, -400, 400); p.y = clamp(+m.y || 0, -500, 500); }
    });
    const bye = () => { this.pl.delete(id); if (!this.pl.size && this.iv) { clearInterval(this.iv); this.iv = null; } };
    server.addEventListener("close", bye);
    server.addEventListener("error", bye);
    if (!this.iv) this.iv = setInterval(() => this.tick(), 125);
    return new Response(null, { status: 101, webSocket: client });
  }
  inPad(p) { return p.x > PAD.x1 && p.x < PAD.x2 && p.y > PAD.y1 && p.y < PAD.y2; }
  tick() {
    if (++this.n % 8 === 0) { this.qt -= 1; if (this.qt <= 0) this.queue(); }
    const list = [...this.pl.values()].map((p) => [p.id, p.n, p.col, p.x | 0, p.y | 0, 100, 1, 0, 1]);
    const msg = JSON.stringify({ t: "lob", ps: list, qt: this.qt });
    for (const p of this.pl.values()) { try { p.ws.send(msg); } catch (e) {} }
  }
  queue() {
    this.qt = 60;
    const q = [...this.pl.values()].filter((p) => this.inPad(p));
    q.sort(() => Math.random() - 0.5);
    while (q.length >= 2) {
      const grp = q.splice(0, 10);
      if (grp.length < 2) break;
      const room = crypto.randomUUID().slice(0, 8);
      for (const p of grp) sendTo(p.ws, { t: "go", room, n: grp.length });
    }
    for (const p of q) sendTo(p.ws, { t: "note", text: "برای شروع سرور حداقل ۲ نفر لازمه؛ صف بعدی رو منتظر بمون" });
  }
}

// ---------------- سرور بازی (۱۰ نفر) ----------------
export class Room {
  constructor(state, env) {
    this.env = env; this.ps = new Map(); this.hz = []; this.phase = "wait"; this.R0 = 360; this.shrink = 60; this.turn = 10;
    this.artist = null; this.at = 0; this.pend = null; this.expect = 2; this.iv = null; this.k = 0; this.out = 0;
  }
  async fetch(req) {
    const u = new URL(req.url);
    const { client, server } = upgrade();
    if (this.phase !== "wait" || this.ps.size >= 10) { sendTo(server, { t: "note", text: "این سرور پره" }); server.close(); return new Response(null, { status: 101, webSocket: client }); }
    this.expect = clamp(+u.searchParams.get("n") || 2, 2, 10);
    const id = crypto.randomUUID().slice(0, 8);
    const p = { id, ws: server, n: "بازیکن", col: pick(COLS), x: rr(-250, 250), y: rr(-250, 250), hp: 100, alive: true, busy: false, slow: 1 };
    this.ps.set(id, p);
    sendTo(server, { t: "init", id, col: p.col });
    server.addEventListener("message", (e) => this.msg(p, e.data));
    const bye = () => { if (this.ps.has(id) && p.alive && this.phase === "play") this.die(p); };
    server.addEventListener("close", bye);
    server.addEventListener("error", bye);
    if (this.ps.size >= this.expect) this.start();
    else if (!this.wt) this.wt = setTimeout(() => { if (this.phase === "wait") this.start(); }, 8000);
    return new Response(null, { status: 101, webSocket: client });
  }
  alive() { return [...this.ps.values()].filter((p) => p.alive); }
  all(o) { const m = JSON.stringify(o); for (const p of this.ps.values()) { try { p.ws.send(m); } catch (e) {} } }
  say(text) { this.all({ t: "msg", text }); }
  start() {
    if (this.phase !== "wait") return;
    if (this.ps.size < 2) { this.all({ t: "note", text: "بازیکنی پیدا نشد" }); return; }
    this.phase = "play";
    this.all({ t: "start" });
    this.say("بازی شروع شد! آخرین نفر زنده برنده است");
    this.iv = setInterval(() => { this.tick(0.05); if (++this.k % 2 === 0) this.snap(); }, 50);
  }
  msg(p, raw) {
    let m; try { m = JSON.parse(raw); } catch (e) { return; }
    if (m.t === "hi") p.n = cleanName(m.name);
    else if (m.t === "pos" && p.alive && !p.busy && this.phase === "play") { p.x = clamp(+m.x || 0, -700, 700); p.y = clamp(+m.y || 0, -700, 700); }
    else if (m.t === "draw" && p === this.artist && !this.pend && !p.asked) { p.asked = true; this.judge(p, m.img); }
    else if (m.t === "pick" && p === this.artist && this.pend) {
      const o = this.pend[(+m.i | 0) % 3]; this.release(); this.spawn(o.kind, p.n);
    }
  }
  async judge(p, img) {
    let o = null;
    try {
      if (typeof img === "string" && img.startsWith("data:image/jpeg;base64,") && img.length < 400000) {
        const r = await this.env.AI.run(MODEL, { max_tokens: 350, messages: [{ role: "user", content: [{ type: "text", text: PROMPT }, { type: "image_url", image_url: { url: img } }] }] });
        let t = r && r.response !== undefined ? r.response : r && r.choices ? r.choices[0].message.content : "";
        if (typeof t !== "string") t = JSON.stringify(t);
        const m = t.replace(/```json|```/g, "").match(/\{[\s\S]*\}/);
        if (m) o = JSON.parse(m[0]);
      }
    } catch (e) { console.log("ai: " + e.message); }
    let opts = ((o && o.options) || []).filter((x) => x && KINDS.includes(x.kind)).filter((x, i, a) => a.findIndex((y) => y.kind === x.kind) === i).slice(0, 3);
    const rest = KINDS.filter((k) => !opts.some((x) => x.kind === k)).sort(() => Math.random() - 0.5);
    while (opts.length < 3) { const k = rest.pop(); opts.push({ kind: k, emoji: FA[k][0], title: FA[k][1] }); }
    opts = opts.map((x) => ({ kind: x.kind, emoji: String(x.emoji || FA[x.kind][0]).slice(0, 4), title: String(x.title || FA[x.kind][1]).slice(0, 24) }));
    if (p !== this.artist) return;
    this.pend = opts;
    sendTo(p.ws, { t: "opts", guess: o && typeof o.guess === "string" ? o.guess.slice(0, 30) : "", opts });
  }
  release() { if (this.artist) { this.artist.busy = false; this.artist.asked = false; } this.artist = null; this.pend = null; this.turn = 10; }
  spawn(kind, by) {
    const L = this.R0 - 70, x = rr(-L, L), y = rr(-L, L), hz = this.hz;
    if (kind === "lava") hz.push({ k: "vol", x, y, life: 12, e: 0 });
    if (kind === "meteor" || kind === "lightning") {
      const m = kind === "meteor", n = m ? 6 : 8;
      for (let i = 0; i < n; i++) hz.push({ k: "imp", x: rr(-L, L), y: rr(-L, L), t: 1 + i * 0.7, r: m ? 62 : 42, d: m ? 40 : 35, m, done: 0 });
    }
    if (kind === "tornado") hz.push({ k: "tor", x, y, vx: rr(-40, 40), vy: rr(-40, 40), life: 10, r: 62, ct: 0 });
    if (kind === "poison") hz.push({ k: "gas", x, y, r: 115, life: 10 });
    if (kind === "ice") hz.push({ k: "ice", x, y, r: 140, life: 10 });
    this.say(by + " " + FA[kind][0] + " " + FA[kind][1] + " رو آزاد کرد!");
  }
  hurt(p, d) { if (!p.alive || p.busy) return; p.hp -= d; if (p.hp <= 0) this.die(p); }
  die(p) {
    if (!p.alive) return;
    p.hp = 0; p.alive = false;
    if (p === this.artist) this.release();
    const left = this.alive().length;
    sendTo(p.ws, { t: "out", rank: left + 1, win: false });
    if (left <= 1 && this.phase === "play") this.finish();
  }
  finish() {
    this.phase = "end";
    const w = this.alive()[0];
    if (w) sendTo(w.ws, { t: "out", rank: 1, win: true });
    this.snap();
    clearInterval(this.iv);
    setTimeout(() => { for (const p of this.ps.values()) { try { p.ws.close(); } catch (e) {} } }, 4000);
  }
  snap() {
    this.all({ t: "s", ps: [...this.ps.values()].map((p) => [p.id, p.n, p.col, p.x | 0, p.y | 0, p.hp | 0, p.alive ? 1 : 0, p.busy ? 1 : 0, p.slow]), hz: this.hz, R0: this.R0, sh: this.shrink | 0, tn: this.turn | 0, ar: this.artist ? this.artist.n : "" });
  }
  tick(dt) {
    if (this.phase !== "play") return;
    this.shrink -= dt;
    if (this.shrink <= 0) { this.shrink = 60; if (this.R0 > 200) { this.R0 -= 40; this.say("کناره‌های جزیره ریزش کرد!"); } }
    const live = this.alive();
    for (const p of live) { p.slow = 1; if (Math.abs(p.x) > this.R0 || Math.abs(p.y) > this.R0) this.hurt(p, 8 * dt); }
    for (const h of this.hz) {
      if (h.k === "vol") { h.life -= dt; h.e -= dt; if (h.e <= 0) { h.e = 0.5; this.hz.push({ k: "pool", x: h.x + rr(-220, 220), y: h.y + rr(-220, 220), r: 42, life: 10 }); } }
      else if (h.k === "imp") {
        h.t -= dt;
        if (h.t <= 0 && !h.done) { h.done = 0.4; for (const p of this.alive()) if (Math.hypot(p.x - h.x, p.y - h.y) < h.r) this.hurt(p, h.d); }
        if (h.done) { h.done -= dt; if (h.done <= 0) h.life = 0; }
      } else {
        h.life -= dt;
        if (h.k === "tor") { h.x += h.vx * dt; h.y += h.vy * dt; h.ct -= dt; if (h.ct <= 0) { h.ct = 1.5; h.vx = rr(-60, 60); h.vy = rr(-60, 60); } }
        for (const p of this.alive()) {
          if (Math.hypot(p.x - h.x, p.y - h.y) > h.r) continue;
          this.hurt(p, (h.k === "pool" ? 20 : h.k === "gas" ? 12 : h.k === "ice" ? 8 : 15) * dt);
          if (h.k === "ice") p.slow = 0.5;
        }
      }
    }
    this.hz = this.hz.filter((h) => (h.k === "imp" ? h.life !== 0 : h.life === undefined || h.life > 0));
    if (this.phase !== "play") return;
    if (!this.artist) {
      this.turn -= dt;
      if (this.turn <= 0) {
        this.turn = 10;
        const a = pick(this.alive().filter((p) => !p.busy));
        if (a) { this.artist = a; a.busy = true; a.asked = false; this.at = 42; sendTo(a.ws, { t: "draw", secs: 30 }); this.say(a.n + " داره نقاشی می‌کشه... 🎨"); }
      }
    } else {
      this.at -= dt;
      if (this.at <= 0) { const a = this.artist; this.release(); this.spawn(pick(KINDS), a.n); }
    }
  }
}
