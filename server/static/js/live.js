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
  rev: 0,               // incrémenté quand ce que dessine la carte change
  changedAt: 0,         // instant de ce changement
  lastReveal: 0,        // dernière découverte de cellules (fondu du brouillard)

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
    // ce que la carte dessine a-t-il changé ? (sinon elle n'est pas redessinée)
    const sig = JSON.stringify([s.phase, s.fire, s.smoke, s.gas, s.drone, s.victims, s.plans, s.trail && s.trail.length,
      this.revealAt.size, this.burnt.size, s.forecast && s.forecast.length, s.wind, s.forecast_t0,
      (s.sensors || []).map(x => x.level),
      Object.entries(s.zones || {}).map(([k, z]) => [k, z.level, (z.top || []).map(r => [r.type, r.value, r.x, r.y, r.trend])])]);
    if (sig !== this._sig) { this._sig = sig; this.rev++; this.changedAt = now; }
    if ((s.explored || []).length && this.revealAt.size !== this._revealN) { this._revealN = this.revealAt.size; this.lastReveal = now; }
    this.prev = prev;
    this.s = s;
    this.at = now;
    // chaque panneau reçoit l'état même si un autre plante (erreur signalée une fois)
    for (const fn of this.listeners) {
      try { fn(s, prev); }
      catch (e) {
        const k = String(e && e.message);
        this._errs = this._errs || new Set();
        if (!this._errs.has(k)) { this._errs.add(k); console.error("[état] un panneau n'a pas pu se mettre à jour :", e); }
      }
    }
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

  // Envoie une commande au serveur. Le bouton cliqué (ou opts.button) passe en état
  // « en cours » (roue + désactivé) jusqu'à la réponse, puis un message dit si c'est fait
  // ou pourquoi c'est refusé. opts.label : nom de l'action dans ce message.
  async post(url, data, opts = {}) {
    const c = this._clicked;
    this._clicked = null;
    const btn = opts.button !== undefined ? opts.button : (c && performance.now() - c.at < 400 ? c.b : null);
    const job = Busy.start(btn, opts.label || Busy.labelOf(btn));
    let out = {}, ok = false;
    try {
      const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data || {}) });
      out = await r.json().catch(() => ({}));
      ok = r.ok && out.ok !== false;
      if (!ok && !out.msg) out.msg = r.status >= 500 ? "Erreur du serveur" : "Action refusée";
    } catch (e) {
      out = { ok: false, msg: "Serveur injoignable" };
    }
    await this.refresh();    // l'écran montre tout de suite le résultat du clic
    await Busy.end(job, ok, out.msg);
    return out;
  },

  // relecture immédiate de l'état (en plus de la boucle de 500 ms)
  async refresh() {
    try {
      const s = await (await fetch("/api/state", { cache: "no-store" })).json();
      this._ingest(s);
      this.ok = true;
    } catch (e) { /* la boucle normale réessaiera */ }
  },
};
window.Live = Live;   // lu par la vue 3D (module ES, map3d.js)

// bouton qui a déclenché une commande : capturé avant les gestionnaires de clic
document.addEventListener("click", (e) => {
  const b = e.target && e.target.closest ? e.target.closest("button") : null;
  Live._clicked = b ? { b, at: performance.now() } : null;
}, true);

// ---------------------------------------------------------------- « en cours d'exécution »
// Pendant une commande : le bouton montre une roue et ne peut pas être recliqué, et un
// message en bas à gauche de la carte dit « En cours : … ». À la réponse : « Fait : … » (vert) ou
// « Refusé : … » avec la raison (rouge). La roue reste au moins 0,4 s pour être vue.
const Busy = {
  MIN_MS: 400,
  jobs: new Set(),
  el: null,
  timer: 0,

  labelOf(btn) {
    if (!btn) return "";
    const t = (btn.dataset.label || btn.getAttribute("aria-label") || btn.textContent || "").replace(/\s+/g, " ").trim();
    return t || btn.title || "";
  },

  _toast() {
    if (this.el) return this.el;
    const el = this.el = document.createElement("div");
    el.className = "busy-toast";
    el.setAttribute("role", "status");
    el.setAttribute("aria-live", "polite");
    (document.getElementById("mapWrap") || document.body).appendChild(el);
    return el;
  },

  _show(kind, text) {
    const el = this._toast();
    clearTimeout(this.timer);
    el.className = "busy-toast show " + kind;
    el.innerHTML = (kind === "run" ? '<span class="spin" aria-hidden="true"></span>' : "") + `<span>${U.esc(text)}</span>`;
    if (kind !== "run") this.timer = setTimeout(() => { el.className = "busy-toast " + kind; }, kind === "err" ? 4500 : 1800);
  },

  start(btn, label) {
    const job = { btn, label, t0: performance.now() };
    this.jobs.add(job);
    if (btn) {
      btn.classList.add("is-busy");
      btn.setAttribute("aria-busy", "true");
      btn.disabled = true;
    }
    if (label) this._show("run", `En cours : ${label}…`);
    return job;
  },

  async end(job, ok, msg) {
    const wait = this.MIN_MS - (performance.now() - job.t0);
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    this.jobs.delete(job);
    const b = job.btn;
    if (b) {
      b.classList.remove("is-busy");
      b.removeAttribute("aria-busy");
      b.disabled = false;
      if (b.isConnected) {               // un bref repère sur le bouton lui-même
        b.classList.add(ok ? "is-done" : "is-failed");
        setTimeout(() => b.classList.remove("is-done", "is-failed"), ok ? 900 : 1600);
      }
    }
    if (ok) { if (job.label) this._show("ok", `Fait : ${job.label}`); }
    else this._show("err", `${job.label ? "Refusé : " + job.label + ". " : ""}${msg || "Action refusée"}`);
  },
};

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
