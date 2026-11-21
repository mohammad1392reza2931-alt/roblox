// جزیره‌ی نقاش‌ها (نسخه ۳بعدی) - سرور چندنفره روی Cloudflare (Durable Objects + Workers AI)
// Lobby: لابی مشترک + صف | Room: سرور ۱۰ نفره؛ هر چیزی که کشیده بشه تا آخر بازی روی نقشه می‌مونه
const MODEL = "@cf/meta/llama-4-scout-17b-16e-instruct";
// kind: [حرکت, سرعت, شعاع اثر, آسیب بر ثانیه (منفی = درمان), تعداد]
const T = {
  zombie: ["chase", 2.2, 1.7, 18, 5], spider: ["chase", 4, 1.5, 14, 3],
  dragon: ["orbit", 0.35, 8, 15, 1], ufo: ["wander", 6, 5, 20, 1], tornado: ["wander", 5, 6, 16, 1],
  volcano: ["static", 0, 9, 14, 1], meteor: ["rain", 0, 4.5, 10, 6], storm: ["strike", 0, 26, 25, 1],
  poison: ["static", 0, 8, 10, 1], ice: ["static", 0, 9, 4, 1], tree: ["static", 0, 6, -6, 1],
  house: ["static", 0, 5, -3, 1], custom: ["wander", 2, 2.5, 10, 1],
};
const KS = Object.keys(T);
const COLS = ["#e63946", "#2a9d8f", "#7b2cbf", "#f77f00", "#3a86ff", "#ef476f", "#06d6a0", "#8d99ae"];
const PAD = { x1: -150, x2: 150, y1: -430, y2: -250 };
const rr = (a, b) => a + Math.random() * (b - a);
const pick = (a) => a[(Math.random() * a.length) | 0];
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const SCHEMA =
  'Reply with ONLY JSON: {"guess":"short Persian name of what it really is","kind":"one of: ' + KS.join(",") + '","color":"#rrggbb main color","hostile":true or false,"parts":[{"s":"box|sphere|cone|cyl","c":"#rrggbb","p":[x,y,z],"z":[w,h,d]}]}. ' +
  "Be literal and honest: use a catalog kind ONLY if the thing truly IS that exact thing. Catalog: zombie=zombie/undead, spider=spider, dragon=dragon ONLY (a cat, bird or plane is NOT a dragon), ufo=ufo/alien ship, tornado, volcano, meteor=meteor/falling rock, storm=storm cloud/lightning, poison=toxic cloud/skull, ice=snow/ice field, tree=tree/plant, house=house/building. " +
  "EVERYTHING ELSE (animals, vehicles, people, tools, food, robots, weapons, ...) MUST be kind=custom with parts: 6 to 14 primitives that make it recognizable (body, head, legs, ears, tail, wheels, ...), real colors, model about 4 units big, centered at x=0 z=0, y up with ground at y=0, front toward +z, p=center, z=size. hostile=false for cute or friendly things. Omit parts for catalog kinds.";
const PROMPT = "You see a quick drawing made by a player in a 3D party game. Identify what it depicts. " + SCHEMA;

function sendTo(ws, o) { try { ws.send(JSON.stringify(o)); } catch (e) {} }
const cleanName = (s) => String(s || "بازیکن").replace(/[<>]/g, "").trim().slice(0, 12) || "بازیکن";

export default {
  async fetch(req, env) {
    const u = new URL(req.url);
    if (u.pathname === "/poll/lobby") return env.LOBBY.get(env.LOBBY.idFromName("main")).fetch(req);
    if (u.pathname.startsWith("/poll/room/")) return env.ROOM.get(env.ROOM.idFromName(u.pathname.split("/")[3] || "x")).fetch(req);
    if (req.headers.get("Upgrade") !== "websocket") return new Response("not found", { status: 404 });
    if (u.pathname === "/ws/lobby") return env.LOBBY.get(env.LOBBY.idFromName("main")).fetch(req);
    if (u.pathname.startsWith("/ws/room/")) {
      const id = u.pathname.split("/")[3] || "x";
      return env.ROOM.get(env.ROOM.idFromName(id)).fetch(req);
    }
    return new Response("not found", { status: 404 });
  },
};

const wsOk = (c) => (c ? new Response(null, { status: 101, webSocket: c }) : new Response("ok"));
const pj = (arr, c) => new Response('{"m":[' + arr.join(",") + '],"c":' + c + "}", { headers: { "content-type": "application/json", "access-control-allow-origin": "*" } });
// اتصال جایگزین بدون WebSocket: کلاینت مرتب POST می‌زنه و پیام‌های صف‌شده رو می‌گیره
async function pollHandle(o, req) {
  let b; try { b = await req.json(); } catch (e) { b = {}; }
  const sid = String(b.sid || "");
  if (sid.length < 8 || sid.length > 40) return new Response("bad", { status: 400 });
  if (!o.sess) o.sess = new Map();
  let s = o.sess.get(sid);
  if (!s) {
    if (b.bye) return pj([], 1);
    const L = {};
    s = {
      q: [], L, closed: false, last: Date.now(), readyState: 1, accept() {},
      send(m) { this.q.push(m); if (this.q.length > 400) this.q.shift(); },
      close() { if (this.closed) return; this.closed = true; this.readyState = 3; try { L.close && L.close(); } catch (e) {} },
      addEventListener(e, f) { L[e] = f; },
    };
    o.sess.set(sid, s);
    o.fp = s;
    try { await o.fetch({ url: req.url.replace("/poll", "/ws"), headers: { get: () => "websocket" } }); } finally { o.fp = null; }
  }
  s.last = Date.now();
  if (b.bye) { s.close(); o.sess.delete(sid); return pj([], 1); }
  for (const m of Array.isArray(b.msgs) ? b.msgs.slice(0, 20) : []) { try { s.L.message && s.L.message({ data: JSON.stringify(m) }); } catch (e) {} }
  if (o.pump) o.pump();
  return pj(s.q.splice(0), s.closed ? 1 : 0);
}
function reap(o) { if (!o.sess) return; const t = Date.now(); for (const [k, s] of [...o.sess]) if (t - s.last > 6000) { o.sess.delete(k); s.close(); } }

function upgrade() {
  const pair = new WebSocketPair();
  const [client, server] = Object.values(pair);
  server.accept();
  return { client, server };
}

// ---------------- لابی اصلی ----------------
export class Lobby {
  constructor(state, env) { this.pl = new Map(); this.qt = 60; this.n = 0; this.iv = null; this.lt = 0; }
  async fetch(req) {
    if (new URL(req.url).pathname.startsWith("/poll")) return pollHandle(this, req);
    const { client, server } = this.fp ? { client: null, server: this.fp } : upgrade();
    const id = crypto.randomUUID().slice(0, 8);
    const p = { id, ws: server, n: "بازیکن", col: pick(COLS), x: 0, y: 350 };
    this.pl.set(id, p);
    sendTo(server, { t: "init", id, col: p.col });
    server.addEventListener("message", (e) => {
      let m; try { m = JSON.parse(e.data); } catch (x) { return; }
      if (m.t === "hi") p.n = cleanName(m.name);
      if (m.t === "pos") { p.x = clamp(+m.x || 0, -400, 400); p.y = clamp(+m.y || 0, -500, 500); this.pump(); }
    });
    const bye = () => { this.pl.delete(id); if (!this.pl.size && this.iv) { clearInterval(this.iv); this.iv = null; } };
    server.addEventListener("close", bye);
    server.addEventListener("error", bye);
    if (!this.iv) this.iv = setInterval(() => this.pump(), 125);
    return wsOk(client);
  }
  pump() { reap(this); // جلو بردن زمان بر اساس ساعت واقعی؛ هم از تایمر صدا زده می‌شه هم با هر پیام بازیکن
    const t = Date.now(); if (!this.lt) this.lt = t; let n = 0;
    try { while (t - this.lt >= 125 && n++ < 8) { this.lt += 125; this.tick(); } } catch (e) { console.log("lobby tick: " + (e && e.stack)); }
    if (t - this.lt > 1000) this.lt = t;
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
const CH = { x: 0, z: -44 }; // صندلی نقاش جلوی بوم بزرگ
export class Room {
  constructor(state, env) {
    this.env = env; this.ps = new Map(); this.es = []; this.phase = "wait"; this.turn = 8;
    this.artist = null; this.at = 0; this.expect = 2; this.iv = null; this.k = 0; this.eid = 0; this.lt = 0; this.t0 = Date.now(); this.rot = [];
  }
  async fetch(req) {
    const u = new URL(req.url);
    if (u.pathname.startsWith("/poll")) return pollHandle(this, req);
    const { client, server } = this.fp ? { client: null, server: this.fp } : upgrade();
    if (this.phase !== "wait" || this.ps.size >= 10) { sendTo(server, { t: "note", text: "این سرور پره" }); server.close(); return wsOk(client); }
    const nb = clamp(+u.searchParams.get("bots") || 0, 0, 9);
    this.expect = nb ? 1 : clamp(+u.searchParams.get("n") || 2, 2, 10);
    if (nb && !this.ps.size) {
      const BN = ["آرش", "سارا", "نیما", "مهسا", "کیان", "رها", "پویا", "هانیه", "بابک"];
      for (let i = 0; i < nb; i++) { const bid = "b" + i, a = rr(0, 6.28), d = rr(8, 40); this.ps.set(bid, { id: bid, ws: null, bot: true, n: "🤖 " + BN[i], col: pick(COLS), x: Math.cos(a) * d, z: Math.sin(a) * d, hp: 100, alive: true, busy: false, slow: 1, wt: 0, tx: 0, tz: 0 }); }
    }
    const id = crypto.randomUUID().slice(0, 8), a = rr(0, 6.28), d = rr(5, 30);
    const p = { id, ws: server, n: "بازیکن", col: pick(COLS), x: Math.cos(a) * d, z: Math.sin(a) * d, hp: 100, alive: true, busy: false, slow: 1 };
    this.ps.set(id, p);
    sendTo(server, { t: "init", id, col: p.col });
    server.addEventListener("message", (e) => this.msg(p, e.data));
    const bye = () => { if (this.ps.has(id) && p.alive && this.phase === "play") this.die(p); };
    server.addEventListener("close", bye);
    server.addEventListener("error", bye);
    if (this.ps.size >= this.expect) this.start();
    else if (!this.wt) this.wt = setTimeout(() => { if (this.phase === "wait") this.start(); }, 8000);
    return wsOk(client);
  }
  pump() {
    reap(this);
    if (this.phase === "wait" && this.ps.size >= 2 && Date.now() - this.t0 > 8000) this.start();
    if (this.phase !== "play") return;
    const t = Date.now(); if (!this.lt) this.lt = t; let n = 0;
    try { while (t - this.lt >= 50 && n++ < 10 && this.phase === "play") { this.lt += 50; this.tick(0.05); if (++this.k % 2 === 0) this.snap(); } } catch (e) { console.log("room tick: " + (e && e.stack)); }
    if (t - this.lt > 1000) this.lt = t;
  }
  alive() { return [...this.ps.values()].filter((p) => p.alive); }
  all(o, skip) { const m = JSON.stringify(o); for (const p of this.ps.values()) if (p !== skip) { try { p.ws.send(m); } catch (e) {} } }
  say(text) { this.all({ t: "msg", text }); }
  start() {
    if (this.phase !== "wait") return;
    if (this.ps.size < 2) { this.all({ t: "note", text: "بازیکنی پیدا نشد" }); return; }
    this.phase = "play";
    this.all({ t: "start" });
    this.say("بازی شروع شد! هرچی بکشید تا آخر بازی روی جزیره می‌مونه");
    this.iv = setInterval(() => this.pump(), 50);
  }
  msg(p, raw) {
    let m; try { m = JSON.parse(raw); } catch (e) { return; }
    this.pump();
    if (m.t === "hi") p.n = cleanName(m.name);
    else if (m.t === "pos" && p.alive && !p.busy && this.phase === "play") {
      p.x = clamp(+m.x || 0, -100, 100); p.z = clamp(+m.z || 0, -100, 100);
      const d = Math.hypot(p.x, p.z); if (d > 100) { p.x *= 100 / d; p.z *= 100 / d; }
    }
    else if (p === this.artist && m.t === "stroke" && Array.isArray(m.p)) this.all({ t: "stroke", p: m.p.slice(0, 60), n: m.n ? 1 : 0 }, p);
    else if (p === this.artist && m.t === "clr") this.all({ t: "clr" }, p);
    else if (m.t === "draw" && p === this.artist && !p.asked) { p.asked = true; this.judge(p, m.img); }
  }
  async ask(content) {
    try {
      const r = await Promise.race([this.env.AI.run(MODEL, { max_tokens: 500, messages: [{ role: "user", content }] }), new Promise((_, rj) => setTimeout(() => rj(new Error("timeout")), 30000))]);
      let t = r && r.response !== undefined ? r.response : r && r.choices ? r.choices[0].message.content : "";
      if (typeof t !== "string") t = JSON.stringify(t);
      const m = t.replace(/```json|```/g, "").match(/\{[\s\S]*\}/);
      return m ? JSON.parse(m[0]) : null;
    } catch (e) { console.log("ai: " + e.message); return null; }
  }
  async judge(p, img) {
    let o = null;
    if (typeof img === "string" && img.startsWith("data:image/jpeg;base64,") && img.length < 400000) {
      const c = [{ type: "text", text: PROMPT }, { type: "image_url", image_url: { url: img } }];
      this.say("🤖 هوش مصنوعی داره نقاشی " + p.n + " رو نگاه می‌کنه...");
      const t0 = Date.now();
      o = await this.ask(c);
      if (!o && Date.now() - t0 < 12000) o = await this.ask(c);
    }
    if (p !== this.artist) return;
    this.release();
    if (!o || !this.spawn(o, p.n)) this.say("هوش مصنوعی نتونست نقاشی " + p.n + " رو تشخیص بده 😕");
  }
  async botIdea(a) {
    const SEEDS = ["a cat", "a dog", "a car", "a castle", "a shark", "a rocket", "a robot", "a dinosaur", "a dragon", "a zombie", "a tornado", "a volcano", "a sword", "a whale", "a snowman", "a tree", "a house", "a spaceship", "a horse", "a pizza"];
    const o = await this.ask("You are a playful bot in a party game where drawings come alive in 3D. Imagine you just drew " + pick(SEEDS) + ". " + SCHEMA);
    a.idea = o && (T[o.kind] || (Array.isArray(o.parts) && o.parts.length)) ? o : { kind: pick(KS.filter((k) => k !== "custom")), guess: "" };
  }
  botMove(b, dt) {
    let vx = 0, vz = 0;
    for (const e of this.es) {
      if (e.t < 0) continue;
      const d = Math.hypot(b.x - e.x, b.z - e.z) || 1;
      if (e.dps > 0 && d < e.r + 6) { vx += ((b.x - e.x) / d) * 2; vz += ((b.z - e.z) / d) * 2; }
      else if (e.dps < 0 && b.hp < 80 && d < 40) { vx += (e.x - b.x) / d; vz += (e.z - b.z) / d; }
    }
    if (!vx && !vz) {
      b.wt -= dt; if (b.wt <= 0) { b.wt = rr(2, 5); b.tx = rr(-50, 50); b.tz = rr(-50, 50); }
      const d = Math.hypot(b.tx - b.x, b.tz - b.z); if (d > 2) { vx = (b.tx - b.x) / d; vz = (b.tz - b.z) / d; }
    }
    const l = Math.hypot(vx, vz);
    if (l > 0) { const k = (7 * b.slow * dt * Math.min(1, l)) / l; b.x += vx * k; b.z += vz * k; }
    const r = Math.hypot(b.x, b.z); if (r > 66) { b.x *= 66 / r; b.z *= 66 / r; }
  }
  release() { if (this.artist) { sendTo(this.artist.ws, { t: "done" }); this.artist.busy = false; this.artist.asked = false; } this.artist = null; this.turn = 10; }
  spawn(o, by) {
    if (!o) return false;
    const hex = (c, d) => (/^#[0-9a-f]{6}$/i.test(c) ? c : d);
    let kind = T[o.kind] ? o.kind : "custom";
    const parts = kind === "custom" && Array.isArray(o.parts) ? o.parts.slice(0, 14).map((q) => ({
      s: ["box", "sphere", "cone", "cyl"].includes(q.s) ? q.s : "box", c: hex(q.c, "#999999"),
      p: [0, 1, 2].map((i) => clamp(+(q.p || [])[i] || 0, -3, 3)), z: [0, 1, 2].map((i) => clamp(+(q.z || [])[i] || 1, 0.1, 4)),
    })) : null;
    if (kind === "custom" && !(parts && parts.length)) return false;
    const [mv, sp, r, dps0, cnt] = T[kind], out = [];
    const friendly = kind === "custom" && o.hostile === false, dps = friendly ? -4 : dps0;
    for (let i = 0; i < cnt; i++) {
      const a = rr(0, 6.28), d = mv === "chase" ? rr(48, 62) : Math.sqrt(Math.random()) * 50;
      const e = { id: ++this.eid, kind, mv, sp, r, dps, x: Math.cos(a) * d, z: Math.sin(a) * d, a, t: mv === "rain" ? -i * 1.2 : -i * 0.3 };
      if (mv === "orbit") { e.x = Math.cos(a) * 30; e.z = Math.sin(a) * 30; }
      this.es.push(e);
      out.push({ id: e.id, kind, mv, x: e.x, z: e.z, a, col: hex(o.color, null), parts, d: -e.t, g: String(o.guess || "").slice(0, 20) });
    }
    this.all({ t: "ent", e: out });
    this.say(by + " «" + String(o.guess || kind).slice(0, 24) + "» رو کشید!");
    return true;
  }
  hurt(p, d) { if (!p.alive || p.busy) return; p.hp -= d; if (p.hp <= 0) this.die(p); }
  die(p) {
    if (!p.alive) return;
    p.hp = 0; p.alive = false;
    if (p === this.artist) this.release();
    const left = this.alive().length;
    sendTo(p.ws, { t: "out", rank: left + 1, win: false });
    if ((left <= 1 || !this.alive().some((q) => !q.bot)) && this.phase === "play") this.finish();
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
    this.all({ t: "s", ps: [...this.ps.values()].map((p) => [p.id, p.n, p.col, +p.x.toFixed(1), +p.z.toFixed(1), p.hp | 0, p.alive ? 1 : 0, p.busy ? 1 : 0, p.slow]), es: this.es.map((e) => [e.id, +e.x.toFixed(1), +e.z.toFixed(1), +e.a.toFixed(2)]), tn: this.turn | 0, ar: this.artist ? this.artist.n : "" });
  }
  tick(dt) {
    if (this.phase !== "play") return;
    const live = this.alive();
    for (const p of live) p.slow = 1;
    for (const b of live) if (b.bot && !b.busy) this.botMove(b, dt);
    for (const e of this.es) {
      e.t += dt;
      if (e.t < 0) continue;
      if (e.mv === "chase") {
        if (e.t < 2.5) continue; // هنوز داره از زمین بیرون میاد
        let b = null, bd = 1e9;
        for (const p of live) { const d = Math.hypot(p.x - e.x, p.z - e.z); if (d < bd && !p.busy) { bd = d; b = p; } }
        if (b) { e.a = Math.atan2(b.z - e.z, b.x - e.x); e.x += Math.cos(e.a) * e.sp * dt; e.z += Math.sin(e.a) * e.sp * dt; }
      } else if (e.mv === "wander") {
        e.a += rr(-2, 2) * dt; e.x += Math.cos(e.a) * e.sp * dt; e.z += Math.sin(e.a) * e.sp * dt;
        if (Math.hypot(e.x, e.z) > 60) e.a = Math.atan2(-e.z, -e.x);
      } else if (e.mv === "orbit") { e.a += e.sp * dt; e.x = Math.cos(e.a) * 30; e.z = Math.sin(e.a) * 30; }
      else if (e.mv === "rain" && e.t < 3) continue;
      else if (e.mv === "strike") {
        e.cd = (e.cd === undefined ? 2 : e.cd) - dt;
        if (e.cd <= 0) { e.cd = 2.5; const v = pick(live.filter((p) => Math.hypot(p.x - e.x, p.z - e.z) < e.r).concat([null])); if (v) { this.hurt(v, e.dps); this.all({ t: "bolt", x: v.x, z: v.z }); } }
        continue;
      }
      for (const p of live) {
        if (Math.hypot(p.x - e.x, p.z - e.z) > e.r) continue;
        if (e.dps < 0) p.hp = Math.min(100, p.hp - e.dps * dt); else this.hurt(p, e.dps * dt);
        if (e.kind === "ice") p.slow = 0.5;
      }
    }
    if (this.phase !== "play") return;
    if (!this.artist) {
      this.turn -= dt;
      if (this.turn <= 0) {
        this.turn = 10;
        if (!this.rot.length) {
          this.rot = this.alive().map((p) => p.id).sort(() => Math.random() - 0.5);
          if (!this.firstDone) { this.firstDone = true; this.rot.sort((x, y) => (this.ps.get(x).bot ? 1 : 0) - (this.ps.get(y).bot ? 1 : 0)); } // اولین نوبت مال آدم‌هاست
        }
        let a = null;
        while (this.rot.length && !a) { const q = this.ps.get(this.rot.shift()); if (q && q.alive && !q.busy) a = q; }
        if (a) {
          this.artist = a; a.busy = true; a.asked = false; a.x = CH.x; a.z = CH.z; this.at = a.bot ? 8 : 42; this.bt = 0; this.bs = null; a.idea = null;
          this.all({ t: "clr" }); this.say(a.n + " رفت پشت بوم بزرگ... 🎨");
          if (a.bot) this.botIdea(a); else sendTo(a.ws, { t: "draw", secs: 30 });
        }
      }
    } else {
      const a = this.artist; this.at -= dt;
      if (a.bot && (this.bt -= dt) <= 0) { // ربات روی بوم خط‌خطی می‌کنه
        this.bt = 0.12; const n = Math.random() < 0.08 || !this.bs;
        if (n) this.bs = [rr(40, 320), rr(30, 210)];
        const pts = []; for (let i = 0; i < 3; i++) { this.bs = [clamp(this.bs[0] + rr(-35, 35), 10, 350), clamp(this.bs[1] + rr(-25, 25), 10, 230)]; pts.push(this.bs.map(Math.round)); }
        this.all({ t: "stroke", p: pts, n: n ? 1 : 0 });
      }
      if (a.bot ? this.at <= 0 && (a.idea || this.at < -10) : (this.at <= 0 && !a.asked) || this.at < -90) {
        this.release();
        if (a.bot) this.spawn(a.idea || { kind: pick(KS.filter((k) => k !== "custom")), guess: "" }, a.n);
        else this.say(a.n + " وقتش تموم شد 😅");
      }
    }
  }
}
