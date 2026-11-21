// live.js — récupère /api/state toutes les 500 ms et garde une "mémoire" côté écran
// (quand chaque cellule a été découverte, cellules brûlées, nouvelles alertes...).
// Le dessin, lui, tourne à 60 images/s (voir map.js) et anime ENTRE deux états.
"use strict";

const Live = {
  factory: null,
  s: null,              // dernier état reçu
  at: 0,                // performance.now() de la dernière réponse
  ok: false,
  revealAt: new Map(),  // "x,y" -> instant de découverte (pour le fondu)
  burnt: new Set(),     // cellules qui ont brûlé
  fireNow: new Set(),
  smokeNow: new Set(),
  gasNow: new Set(),
  forecast: new Set(),
  listeners: [],
  seenAlert: 0,

  on(fn) { this.listeners.push(fn); },

  async start() {
    this.factory = await (await fetch("/api/factory")).json();
    this._poll();
  },

  async _poll() {
    try {
      const r = await fetch("/api/state", { cache: "no-store" });
      const s = await r.json();
      this._ingest(s);
      this.ok = true;
    } catch (e) {
      this.ok = false;
    }
    setTimeout(() => this._poll(), 500);
  },

  _ingest(s) {
    const now = performance.now();
    const prev = this.s;
    // la vraie Sim dit "unknown" tant qu'on ne connaît pas l'état d'une victime ; l'écran attend null
    for (const v of s.victims || []) if (v.status === "unknown") v.status = null;
    // la vraie Sim renvoie {door: null, path: []} quand il n'y a pas encore de porte conseillée
    if (s.plans && s.plans.entry && !s.plans.entry.door) s.plans.entry = null;
    // reset détecté : on vide la mémoire
    if (prev && (s.events.length < prev.events.length - 5 || (s.phase === "NORMAL" && (s.explored || []).length === 0 && this.revealAt.size))) {
      this.revealAt.clear(); this.burnt.clear(); this.seenAlert = 0;
    }
    for (const [x, y] of s.explored || []) {
      const k = x + "," + y;
      if (!this.revealAt.has(k)) this.revealAt.set(k, now);
    }
    const fire = new Set((s.fire || []).map(c => c[0] + "," + c[1]));
    for (const k of this.fireNow) if (!fire.has(k)) this.burnt.add(k);
    this.fireNow = fire;
    this.smokeNow = new Set((s.smoke || []).map(c => c[0] + "," + c[1]));
    this.gasNow = new Set((s.gas || []).map(c => c[0] + "," + c[1]));
    this.forecast = new Set((s.forecast || []).map(c => c[0] + "," + c[1]));
    this.prev = prev;
    this.s = s;
    this.at = now;
    for (const fn of this.listeners) fn(s, prev);
  },

  // décalage horloge serveur -> client (pour les "il y a 1,2 s")
  serverNow() {
    if (!this.s) return Date.now() / 1000;
    return this.s.server_time + (performance.now() - this.at) / 1000;
  },

  fogOn() {
    const p = this.s && this.s.phase;
    return ["CONFIRMED", "EN_ROUTE", "DRONE_INSIDE", "PLANS_READY"].includes(p);
  },

  async post(url, data) {
    const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data || {}) });
    return r.json().catch(() => ({}));
  },
};
window.Live = Live;   // lu par la vue 3D (module ES, map3d.js)

// ---------------------------------------------------------------- outils
const U = {
  clamp: (v, a, b) => Math.max(a, Math.min(b, v)),
  lerp: (a, b, k) => a + (b - a) * k,
  // bruit déterministe 0..1, varie doucement dans le temps
  noise(x, y, t, k = 0) {
    return 0.5 + 0.25 * Math.sin(t * 2.1 + x * 12.99 + y * 78.23 + k) + 0.25 * Math.sin(t * 3.7 + x * 3.1 - y * 5.7 + k);
  },
  fmt(v) {
    if (v == null) return "--";
    return Math.abs(v) >= 100 ? Math.round(v).toString() : (Math.round(v * 10) / 10).toString().replace(".", ",");
  },
  ago(sec) {
    if (sec < 1) return "à l'instant";
    if (sec < 60) return "il y a " + sec.toFixed(1).replace(".", ",") + " s";
    return "il y a " + Math.floor(sec / 60) + " min";
  },
  el(tag, cls, html) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  },
  esc(s) { return String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); },
};

// Valeurs affichées qui "défilent" vers leur cible (312 -> 340 °C)
const Tween = {
  m: new Map(),
  get(key, target, rate = 0.12) {
    let v = this.m.get(key);
    if (v == null || !isFinite(v) || Math.abs(target - v) > Math.abs(target) * 3 + 50) v = target;
    v += (target - v) * rate;
    if (Math.abs(target - v) < 0.05) v = target;
    this.m.set(key, v);
    return v;
  },
};
