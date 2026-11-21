// map.js — rendu de la carte live (canvas).
//  * calque statique (murs, portes, stocks, équipements) dessiné UNE fois hors écran ;
//  * calque dynamique redessiné à 60 images/s : brouillard, feu qui scintille, fumée qui
//    ondule, gaz, traînée du drone, anneau de scan, drone interpolé, alertes de zone, plans.
//  * la même classe sert à la vue globale et à la loupe (mode "detail" + caméra animée).
"use strict";

const CELL_PX = 32;   // résolution du calque statique
const MAT = {
  "#": { c: "#3a4354", name: "Mur" },
  ".": { c: "#141a24", name: "Sol" },
  "D": { c: "#7a5a2e", name: "Porte intérieure" },
  "E": { c: "#1d9a55", name: "Sortie" },
  "P": { c: "#5c4528", name: "Stock papier / bois (classe A)" },
  "F": { c: "#4a2c63", name: "Solvants / carburant (classe B)" },
  "G": { c: "#5e5a1a", name: "Bouteilles de gaz (classe C)" },
  "X": { c: "#18485e", name: "Armoire électrique" },
};
const EQUIP_ICON = { metal: "⚙", electric: "⚡", gas: "🧪", valve: "🔧", solvent: "🛢", extinguisher: "🧯" };
const STATUS_COLOR = { walking: "#2ecc71", injured: "#ff4d3d", no_answer: "#ff9f1c" };

class MapView {
  constructor(canvas, factory, opts = {}) {
    this.cv = canvas;
    this.ctx = canvas.getContext("2d");
    this.f = factory;
    this.W = factory.grid[0].length;
    this.H = factory.grid.length;
    this.detail = !!opts.detail;
    this.layers = { fire: true, smoke: true, gas: true, paths: true, fog: true };
    this.cam = { x: 0, y: 0, w: this.W, h: this.H };
    this.camTarget = { ...this.cam };
    this.focusZone = null;
    this.hover = null;
    this.drone = null;           // position lissée
    this.droneHeading = 0;
    this.zoneById = Object.fromEntries((factory.zones || []).map(z => [z.id, z]));
    this._buildStatic();
    this._fogPattern = this._makeHatch();
    this.resize();
    new ResizeObserver(() => this.resize()).observe(canvas);
  }

  // ------------------------------------------------------------ géométrie
  resize() {
    const dpr = window.devicePixelRatio || 1;
    // clientWidth ignore les transform CSS (la loupe s'ouvre avec un scale animé)
    this.cssW = Math.max(50, this.cv.clientWidth); this.cssH = Math.max(50, this.cv.clientHeight);
    this.cv.width = Math.round(this.cssW * dpr);
    this.cv.height = Math.round(this.cssH * dpr);
    this.dpr = dpr;
  }
  _view() {
    const c = this.cam;
    const s = Math.min(this.cssW / c.w, this.cssH / c.h);
    const ox = (this.cssW - c.w * s) / 2 - c.x * s;
    const oy = (this.cssH - c.h * s) / 2 - c.y * s;
    return { s, ox, oy };
  }
  toCell(px, py) {
    const v = this._view();
    return [Math.floor((px - v.ox) / v.s), Math.floor((py - v.oy) / v.s)];
  }
  toScreen(cx, cy) {
    const v = this._view();
    return [v.ox + cx * v.s, v.oy + cy * v.s];
  }
  focus(zoneId, instant) {
    const z = this.zoneById[zoneId];
    this.focusZone = zoneId;
    if (!z) { this.camTarget = { x: 0, y: 0, w: this.W, h: this.H }; return; }
    const [x0, y0, x1, y1] = z.rect;
    const pad = 1.5;
    let w = x1 - x0 + 1 + 2 * pad, h = y1 - y0 + 1 + 2 * pad;
    // garder le format du canvas (4:3) pour éviter les bandes vides
    const ar = this.cssW / this.cssH;
    if (w / h < ar) w = h * ar; else h = w / ar;
    const cx = (x0 + x1 + 1) / 2, cy = (y0 + y1 + 1) / 2;
    this.camTarget = { x: cx - w / 2, y: cy - h / 2, w, h };
    if (instant) this.cam = { ...this.camTarget };
  }
  cell(x, y) { return (this.f.grid[y] || "")[x] || "#"; }
  zoneAt(x, y) {
    for (const z of this.f.zones || []) {
      const [x0, y0, x1, y1] = z.rect;
      if (x >= x0 && x <= x1 && y >= y0 && y <= y1) return z;
    }
    return null;
  }

  // -------------------------------------------------------- calque statique
  _buildStatic() {
    const c = document.createElement("canvas");
    c.width = this.W * CELL_PX; c.height = this.H * CELL_PX;
    const g = c.getContext("2d");
    const P = CELL_PX;
    for (let y = 0; y < this.H; y++) {
      for (let x = 0; x < this.W; x++) {
        const ch = this.cell(x, y);
        const m = MAT[ch] || MAT["."];
        g.fillStyle = m.c;
        g.fillRect(x * P, y * P, P, P);
        if (ch === "#") {
          g.fillStyle = "rgba(255,255,255,.06)"; g.fillRect(x * P, y * P, P, 3);
        } else {
          g.strokeStyle = "rgba(255,255,255,.035)"; g.strokeRect(x * P + .5, y * P + .5, P - 1, P - 1);
        }
        if (ch === "P") { g.strokeStyle = "rgba(255,220,160,.25)"; g.strokeRect(x * P + 5, y * P + 5, P - 10, P - 10); }
        if (ch === "F") { g.fillStyle = "rgba(220,170,255,.28)"; g.beginPath(); g.arc(x * P + P / 2, y * P + P / 2, P / 3.2, 0, 7); g.fill(); }
        if (ch === "G") { g.fillStyle = "rgba(255,240,120,.35)"; g.fillRect(x * P + P / 2 - 4, y * P + 5, 8, P - 10); }
        if (ch === "X") { g.fillStyle = "rgba(120,220,255,.55)"; g.font = `${P * .6}px sans-serif`; g.textAlign = "center"; g.textBaseline = "middle"; g.fillText("⚡", x * P + P / 2, y * P + P / 2 + 1); }
        if (ch === "D") { g.fillStyle = "#c9954a"; g.fillRect(x * P + 4, y * P + P / 2 - 3, P - 8, 6); }
      }
    }
    // sorties
    g.textAlign = "center"; g.textBaseline = "middle";
    for (const e of this.f.exits || []) {
      g.fillStyle = "#2ee87a"; g.fillRect(e.x * P + 3, e.y * P + 3, P - 6, P - 6);
      g.fillStyle = "#03200f"; g.font = `bold ${P * .42}px system-ui`; g.fillText(e.id, e.x * P + P / 2, e.y * P + P / 2 + 1);
    }
    // bouches d'incendie
    for (const [x, y] of this.f.hydrants || []) {
      g.fillStyle = "#1d4ed8"; g.beginPath(); g.arc(x * P + P / 2, y * P + P / 2, P / 3, 0, 7); g.fill();
      g.fillStyle = "#fff"; g.font = `bold ${P * .4}px system-ui`; g.fillText("H", x * P + P / 2, y * P + P / 2 + 1);
    }
    // équipements
    for (const e of this.f.equipment || []) {
      g.font = `${P * .72}px "Segoe UI Emoji","Apple Color Emoji","Noto Color Emoji",sans-serif`;
      g.fillStyle = "#fff";
      g.fillText(EQUIP_ICON[e.type] || "■", e.x * P + P / 2, e.y * P + P / 2 + 2);
    }
    // noms des zones
    g.textAlign = "left"; g.textBaseline = "top";
    for (const z of this.f.zones || []) {
      g.font = `600 ${P * .42}px system-ui`;
      g.fillStyle = "rgba(190,205,230,.42)";
      g.fillText(z.id + " · " + z.name.toUpperCase(), z.rect[0] * P + 6, z.rect[1] * P + 5);
    }
    this.staticLayer = c;
  }

  // Remplit un petit canvas W×H (1 px = 1 cellule) puis l'agrandit avec lissage :
  // nuages de fumée et bords du brouillard deviennent doux, pour un coût minime.
  _field(key, ctx, fill) {
    this._f = this._f || {};
    let o = this._f[key];
    if (!o) {
      const c = document.createElement("canvas"); c.width = this.W; c.height = this.H;
      const g = c.getContext("2d");
      o = this._f[key] = { c, g, id: g.createImageData(this.W, this.H) };
    }
    const d = o.id.data;
    d.fill(0);
    fill(d);
    o.g.putImageData(o.id, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(o.c, 0, 0, this.W, this.H);
  }

  _glow(ctx, cells, t, rx0, ry0, rx1, ry1, seen) {
    ctx.globalCompositeOperation = "lighter";
    for (const [x, y] of cells) {
      if (x < rx0 - 2 || x > rx1 + 2 || y < ry0 - 2 || y > ry1 + 2) continue;
      const n = U.noise(x, y, t * 3.1, 1);
      const rad = (seen ? 1.5 : 1.3) + 0.4 * n;
      const gr = ctx.createRadialGradient(x + .5, y + .5, 0, x + .5, y + .5, rad);
      const a = seen ? 0.22 + 0.12 * n : 0.09 + 0.06 * n;
      gr.addColorStop(0, `rgba(255,140,40,${a})`);
      gr.addColorStop(1, "rgba(255,60,0,0)");
      ctx.fillStyle = gr;
      ctx.fillRect(x + .5 - rad, y + .5 - rad, rad * 2, rad * 2);
    }
    ctx.globalCompositeOperation = "source-over";
  }

  _makeHatch() {
    const c = document.createElement("canvas"); c.width = c.height = 10;
    const g = c.getContext("2d");
    g.strokeStyle = "rgba(120,140,170,.10)"; g.lineWidth = 1;
    g.beginPath(); g.moveTo(0, 10); g.lineTo(10, 0); g.stroke();
    return this.ctx.createPattern(c, "repeat");
  }

  // -------------------------------------------------------------- dessin
  draw(now) {
    const s = Live.s;
    const ctx = this.ctx;
    const t = now / 1000;
    // caméra animée (zoom fluide)
    const kc = 0.12;
    for (const k of ["x", "y", "w", "h"]) this.cam[k] = U.lerp(this.cam[k], this.camTarget[k], kc);

    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = "#05070b";
    ctx.fillRect(0, 0, this.cssW, this.cssH);
    const v = this._view();
    this._ox = v.ox;
    ctx.save();
    ctx.translate(v.ox, v.oy);
    ctx.scale(v.s, v.s);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this.staticLayer, 0, 0, this.W, this.H);
    if (!s) { ctx.restore(); return; }

    const fog = this.layers.fog && Live.fogOn();
    const revealed = (k) => !fog || Live.revealAt.has(k);
    const rx0 = Math.max(0, Math.floor(this.cam.x)), ry0 = Math.max(0, Math.floor(this.cam.y));
    const rx1 = Math.min(this.W, Math.ceil(this.cam.x + this.cam.w)), ry1 = Math.min(this.H, Math.ceil(this.cam.y + this.cam.h));

    // cellules brûlées (vues)
    ctx.fillStyle = "rgba(8,6,6,.72)";
    for (const k of Live.burnt) if (revealed(k)) { const [x, y] = k.split(",").map(Number); ctx.fillRect(x, y, 1, 1); }


    // fumée (ondule)
    if (this.layers.smoke && Live.smokeNow.size) {
      this._field("smoke", ctx, (d) => {
        for (const k of Live.smokeNow) {
          if (!revealed(k)) continue;
          const [x, y] = k.split(",").map(Number);
          const n = U.noise(x * .35, y * .35, t * .7);
          const i = (y * this.W + x) * 4;
          d[i] = 150; d[i + 1] = 160; d[i + 2] = 176; d[i + 3] = Math.round(255 * (0.22 + 0.3 * n));
        }
      });
    }
    // gaz (points qui pulsent)
    if (this.layers.gas && Live.gasNow.size) {
      this._field("gas", ctx, (d) => {
        for (const k of Live.gasNow) {
          if (!revealed(k)) continue;
          const [x, y] = k.split(",").map(Number);
          const i = (y * this.W + x) * 4;
          d[i] = 182; d[i + 1] = 227; d[i + 2] = 61; d[i + 3] = Math.round(255 * (0.2 + 0.2 * U.noise(x, y, t * 1.5, 3)));
        }
      });
      for (const k of Live.gasNow) {
        if (!revealed(k)) continue;
        const [x, y] = k.split(",").map(Number);
        const n = U.noise(x, y, t * 1.5, 3);
        ctx.fillStyle = `rgba(220,255,120,${0.5 * n})`;
        ctx.beginPath(); ctx.arc(x + .3 + .4 * n, y + .5, .09, 0, 7); ctx.fill();
      }
    }

    // feu : cellules qui scintillent + halo additif
    if (this.layers.fire) {
      const cells = [];
      for (const k of Live.fireNow) { const [x, y] = k.split(",").map(Number); cells.push([x, y, revealed(k)]); }
      for (const [x, y, rv] of cells) {
        if (!rv) continue;
        const n = U.noise(x, y, t * 2.2);
        const r = 255, gg = Math.round(60 + 140 * n), b = Math.round(20 + 30 * n);
        ctx.fillStyle = `rgb(${r},${gg},${b})`;
        ctx.fillRect(x, y, 1, 1);
      }
      this._glow(ctx, cells.filter(c => c[2]), t, rx0, ry0, rx1, ry1, true);
      this._fireHidden = cells.filter(c => !c[2]);
    } else this._fireHidden = [];

    // brouillard de guerre (inconnu) + fondu des cellules découvertes
    if (fog) {
      this._field("fog", ctx, (d) => {
        for (let y = 0; y < this.H; y++) {
          for (let x = 0; x < this.W; x++) {
            const ra = Live.revealAt.get(x + "," + y);
            let a = 0.8;
            if (ra != null) a = 0.8 * (1 - U.clamp((now - ra) / 600, 0, 1));
            const i = (y * this.W + x) * 4;
            d[i] = 4; d[i + 1] = 6; d[i + 2] = 10; d[i + 3] = Math.round(255 * a);
          }
        }
      });
      ctx.save();
      ctx.scale(1 / v.s, 1 / v.s);
      ctx.fillStyle = this._fogPattern;
      ctx.globalAlpha = 0.9;
      for (let y = ry0; y < ry1; y++)
        for (let x = rx0; x < rx1; x++)
          if (!Live.revealAt.has(x + "," + y)) ctx.fillRect(x * v.s, y * v.s, v.s, v.s);
      ctx.restore();
    }
    // feu pas encore vu par le drone : simple lueur "estimée" (capteurs fixes), au-dessus du brouillard
    if (this._fireHidden && this._fireHidden.length) this._glow(ctx, this._fireHidden, t, rx0, ry0, rx1, ry1, false);

    // prévision du feu (+3 min) pendant le trajet : au-dessus du brouillard
    if (s.phase === "EN_ROUTE" && Live.forecast.size) {
      const a = 0.2 + 0.12 * Math.sin(t * 3);
      this._field("forecast", ctx, (d) => {
        for (const k of Live.forecast) {
          const [x, y] = k.split(",").map(Number);
          const i = (y * this.W + x) * 4;
          d[i] = 255; d[i + 1] = 70; d[i + 2] = 40; d[i + 3] = Math.round(255 * a);
        }
      });
      ctx.strokeStyle = "rgba(255,120,90,.55)"; ctx.lineWidth = .05; ctx.setLineDash([.25, .2]);
      for (const k of Live.forecast) { const [x, y] = k.split(",").map(Number); if (!Live.forecast.has((x + 1) + "," + y)) { ctx.beginPath(); ctx.moveTo(x + 1, y); ctx.lineTo(x + 1, y + 1); ctx.stroke(); } if (!Live.forecast.has(x + "," + (y + 1))) { ctx.beginPath(); ctx.moveTo(x, y + 1); ctx.lineTo(x + 1, y + 1); ctx.stroke(); } if (!Live.forecast.has((x - 1) + "," + y)) { ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x, y + 1); ctx.stroke(); } if (!Live.forecast.has(x + "," + (y - 1))) { ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + 1, y); ctx.stroke(); } }
      ctx.setLineDash([]);
    }

    this._drawZoneAlerts(ctx, s, t, v);
    if (this.layers.paths) this._drawPlans(ctx, s, t);
    this._drawTrail(ctx, s);
    this._drawSensors(ctx, s, t);
    this._drawVictims(ctx, s, t);
    this._drawDrone(ctx, s, t, now);
    if (this.detail) this._drawDetailLabels(ctx, s, t, v);
    else this._drawZoneChips(ctx, s, t, v);

    // survol
    if (this.hover && !this.detail) {
      ctx.strokeStyle = "rgba(255,255,255,.7)"; ctx.lineWidth = 0.06;
      ctx.strokeRect(this.hover[0] + .03, this.hover[1] + .03, .94, .94);
    }
    if (this.detail && this.focusZone && this.zoneById[this.focusZone]) {
      const [x0, y0, x1, y1] = this.zoneById[this.focusZone].rect;
      ctx.strokeStyle = "rgba(255,255,255,.25)"; ctx.setLineDash([.3, .2]); ctx.lineWidth = .06;
      ctx.strokeRect(x0, y0, x1 - x0 + 1, y1 - y0 + 1); ctx.setLineDash([]);
    }
    ctx.restore();
  }

  _drawZoneAlerts(ctx, s, t, v) {
    for (const [zid, z] of Object.entries(s.zones || {})) {
      if (z.level === "NORMAL") continue;
      const zr = this.zoneById[zid]; if (!zr) continue;
      const [x0, y0, x1, y1] = zr.rect;
      const danger = z.level === "DANGER";
      const pulse = 0.5 + 0.5 * Math.sin(t * (danger ? 5 : 3));
      const col = danger ? "255,77,61" : "255,159,28";
      ctx.fillStyle = `rgba(${col},${0.04 + 0.05 * pulse})`;
      ctx.fillRect(x0, y0, x1 - x0 + 1, y1 - y0 + 1);
      ctx.strokeStyle = `rgba(${col},${0.45 + 0.45 * pulse})`;
      ctx.lineWidth = 2.2 / v.s;
      ctx.strokeRect(x0 + .05, y0 + .05, x1 - x0 + .9, y1 - y0 + .9);
      // ondes depuis la mesure la plus grave
      const r0 = z.top && z.top[0];
      if (r0 && danger) {
        for (let i = 0; i < 2; i++) {
          const ph = ((t * 0.7 + i * 0.5) % 1);
          ctx.strokeStyle = `rgba(${col},${0.6 * (1 - ph)})`;
          ctx.lineWidth = 1.5 / v.s;
          ctx.beginPath(); ctx.arc(r0.x + .5, r0.y + .5, 0.5 + ph * 4, 0, 7); ctx.stroke();
        }
      }
    }
  }

  _path(ctx, pts) {
    ctx.beginPath();
    pts.forEach(([x, y], i) => (i ? ctx.lineTo(x + .5, y + .5) : ctx.moveTo(x + .5, y + .5)));
    ctx.stroke();
  }

  _drawPlans(ctx, s, t) {
    if (!["DRONE_INSIDE", "PLANS_READY"].includes(s.phase)) return;
    const p = s.plans || {};
    ctx.lineCap = "round"; ctx.lineJoin = "round";
    ctx.setLineDash([.45, .3]);
    ctx.lineDashOffset = -t * 1.2;          // "fourmis" qui avancent vers la sortie
    for (const e of p.evacuation || []) {
      if (!e.path || e.path.length < 2) continue;
      ctx.strokeStyle = e.rescue_first ? "rgba(255,120,90,.95)" : "rgba(46,204,113,.95)";
      ctx.lineWidth = e.rescue_first ? .24 : .18;
      this._path(ctx, e.path);
    }
    if (p.entry && p.entry.path && p.entry.path.length > 1) {
      ctx.strokeStyle = "rgba(34,211,238,.95)"; ctx.lineWidth = .22;
      this._path(ctx, p.entry.path);
    }
    ctx.setLineDash([]);
    // ordre d'extinction : pastilles numérotées sur chaque zone en feu
    const byZone = {};
    for (const k of Live.fireNow) {
      const [x, y] = k.split(",").map(Number);
      const z = this.zoneAt(x, y); if (!z) continue;
      (byZone[z.id] = byZone[z.id] || []).push([x, y]);
    }
    for (const e of p.extinguish || []) {
      const cells = byZone[e.zone]; if (!cells) continue;
      const cx = cells.reduce((a, c) => a + c[0], 0) / cells.length + .5;
      const cy = cells.reduce((a, c) => a + c[1], 0) / cells.length + .5;
      ctx.fillStyle = "rgba(10,14,20,.9)"; ctx.strokeStyle = "#ffd23f"; ctx.lineWidth = .1;
      ctx.beginPath(); ctx.arc(cx, cy, .75, 0, 7); ctx.fill(); ctx.stroke();
      ctx.fillStyle = "#ffd23f"; ctx.font = "bold .9px system-ui"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText(e.order, cx, cy + .05);
    }
  }

  _drawTrail(ctx, s) {
    const tr = s.trail || [];
    if (tr.length < 2) return;
    ctx.lineCap = "round"; ctx.lineJoin = "round";
    for (let i = 1; i < tr.length; i++) {
      const a = i / tr.length;
      ctx.strokeStyle = `rgba(61,165,255,${0.05 + 0.45 * a})`;
      ctx.lineWidth = 0.12 + 0.12 * a;
      ctx.beginPath();
      ctx.moveTo(tr[i - 1][0] + .5, tr[i - 1][1] + .5);
      ctx.lineTo(tr[i][0] + .5, tr[i][1] + .5);
      ctx.stroke();
    }
  }

  _drawSensors(ctx, s, t) {
    for (const se of s.sensors || []) {
      const col = se.level === "ALARM" ? "#ff4d3d" : se.level === "WARNING" ? "#ffd23f" : "#2ecc71";
      const blink = se.level === "ALARM" ? (Math.sin(t * 8) > 0 ? 1 : .35) : 1;
      ctx.fillStyle = "rgba(10,14,20,.9)";
      ctx.fillRect(se.x + .18, se.y + .18, .64, .64);
      ctx.globalAlpha = blink;
      ctx.fillStyle = col;
      ctx.beginPath(); ctx.arc(se.x + .5, se.y + .5, .2, 0, 7); ctx.fill();
      if (se.level === "ALARM") {
        const ph = (t * 1.2) % 1;
        ctx.strokeStyle = `rgba(255,77,61,${1 - ph})`; ctx.lineWidth = .08;
        ctx.beginPath(); ctx.arc(se.x + .5, se.y + .5, .3 + ph * 1.4, 0, 7); ctx.stroke();
      }
      ctx.globalAlpha = 1;
      if (this.detail) {
        ctx.fillStyle = "#cfd8e6"; ctx.font = ".42px system-ui"; ctx.textAlign = "center"; ctx.textBaseline = "top";
        ctx.fillText(`${se.id}${se.src === "real" ? " (réel)" : ""}`, se.x + .5, se.y + .9);
      }
    }
  }

  _drawVictims(ctx, s, t) {
    for (const v of s.victims || []) {
      if (!v.found) continue;
      const col = STATUS_COLOR[v.status] || "#ffffff";
      const p = 0.5 + 0.5 * Math.sin(t * 4 + v.x);
      ctx.fillStyle = col.length === 7 ? col + "33" : col;
      ctx.beginPath(); ctx.arc(v.x + .5, v.y + .5, .7 + .25 * p, 0, 7); ctx.fill();
      ctx.fillStyle = col; ctx.strokeStyle = "#05070b"; ctx.lineWidth = .08;
      ctx.beginPath(); ctx.arc(v.x + .5, v.y + .5, .38, 0, 7); ctx.fill(); ctx.stroke();
      ctx.fillStyle = "#05070b"; ctx.font = "bold .42px system-ui"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText(v.id, v.x + .5, v.y + .52);
      if (v.status === "injured" || v.status === "no_answer") {
        ctx.fillStyle = "#fff"; ctx.font = "bold .5px system-ui";
        ctx.fillText("!", v.x + 1.05, v.y + .05);
      }
    }
  }

  _drawDrone(ctx, s, t, now) {
    const d = s.drone;
    if (!d || d.state === "OUT" && !this.drone) return;
    const tx = d.x + .5, ty = d.y + .5;
    if (!this.drone) this.drone = { x: tx, y: ty };
    // poursuite exponentielle : mouvement fluide entre deux états reçus
    const dt = Math.min(0.1, (now - (this._lastNow || now)) / 1000); this._lastNow = now;
    const k = 1 - Math.exp(-dt * 7);
    const dx = tx - this.drone.x, dy = ty - this.drone.y;
    if (Math.hypot(dx, dy) > 6) { this.drone.x = tx; this.drone.y = ty; }
    this.drone.x += dx * k; this.drone.y += dy * k;
    if (Math.hypot(dx, dy) > .05) {
      const target = Math.atan2(dy, dx);
      let diff = target - this.droneHeading;
      while (diff > Math.PI) diff -= 2 * Math.PI;
      while (diff < -Math.PI) diff += 2 * Math.PI;
      this.droneHeading += diff * k;
    }
    const x = this.drone.x, y = this.drone.y;
    if (d.state === "OUT") return;

    // anneau de scan (portée thermique 3 m) + balayage radar
    const R = 3.2;
    const ph = (t * 0.8) % 1;
    ctx.strokeStyle = `rgba(61,165,255,${0.5 * (1 - ph)})`; ctx.lineWidth = .07;
    ctx.beginPath(); ctx.arc(x, y, R * ph, 0, 7); ctx.stroke();
    ctx.strokeStyle = "rgba(61,165,255,.25)"; ctx.setLineDash([.2, .2]);
    ctx.beginPath(); ctx.arc(x, y, R, 0, 7); ctx.stroke(); ctx.setLineDash([]);
    const a = (t * 2.4) % (Math.PI * 2);
    if (ctx.createConicGradient) {
      const cg = ctx.createConicGradient(a, x, y);
      cg.addColorStop(0, "rgba(61,165,255,.35)");
      cg.addColorStop(0.12, "rgba(61,165,255,0)");
      cg.addColorStop(1, "rgba(61,165,255,0)");
      ctx.fillStyle = cg;
      ctx.beginPath(); ctx.arc(x, y, R, 0, 7); ctx.fill();
    }

    // drone : quadricoptère vu de dessus, couleur selon la température
    const temp = d.temp || 20;
    const hot = U.clamp((temp - 30) / 30, 0, 1);
    const col = `rgb(${Math.round(61 + 194 * hot)},${Math.round(165 - 100 * hot)},${Math.round(255 - 200 * hot)})`;
    ctx.save();
    ctx.translate(x, y); ctx.rotate(this.droneHeading);
    ctx.strokeStyle = col; ctx.lineWidth = .1;
    ctx.beginPath(); ctx.moveTo(-.38, -.38); ctx.lineTo(.38, .38); ctx.moveTo(.38, -.38); ctx.lineTo(-.38, .38); ctx.stroke();
    for (const [rx, ry] of [[-.38, -.38], [.38, -.38], [-.38, .38], [.38, .38]]) {
      ctx.fillStyle = "rgba(200,230,255,.25)";
      ctx.beginPath(); ctx.arc(rx, ry, .2, 0, 7); ctx.fill();
      ctx.strokeStyle = "rgba(230,240,255,.8)"; ctx.lineWidth = .04;
      const sp = t * 30 + rx * 10;
      ctx.beginPath(); ctx.moveTo(rx + Math.cos(sp) * .2, ry + Math.sin(sp) * .2);
      ctx.lineTo(rx - Math.cos(sp) * .2, ry - Math.sin(sp) * .2); ctx.stroke();
    }
    ctx.fillStyle = col;
    ctx.beginPath(); ctx.moveTo(.3, 0); ctx.lineTo(-.15, -.18); ctx.lineTo(-.15, .18); ctx.closePath(); ctx.fill();
    ctx.restore();

    // étiquette température
    const label = `${Math.round(temp)}°C${d.state === "RETURNING" ? " ↩" : ""}`;
    ctx.font = "bold .5px system-ui"; ctx.textAlign = "center"; ctx.textBaseline = "bottom";
    const w = ctx.measureText(label).width + .3;
    ctx.fillStyle = temp >= 60 ? "rgba(180,30,20,.92)" : "rgba(8,20,40,.88)";
    ctx.fillRect(x - w / 2, y - 1.35, w, .62);
    ctx.fillStyle = "#fff"; ctx.fillText(label, x, y - .78);
  }

  // étiquettes "⚠ CO 320 ppm" sur la carte globale (1 par zone en alerte)
  _drawZoneChips(ctx, s, t, v) {
    ctx.save();
    ctx.scale(1 / v.s, 1 / v.s);
    for (const [zid, z] of Object.entries(s.zones || {})) {
      if (z.level === "NORMAL" || !z.top || !z.top.length) continue;
      const r = z.top[0];
      const val = Tween.get("chip" + zid, r.value);
      const txt = `${z.level === "DANGER" ? "⚠" : "•"} ${r.label} ${U.fmt(val)} ${r.unit}${r.trend === "up" ? " ▲" : ""}`;
      const px = (r.x + .5) * v.s, py = (r.y - .3) * v.s;
      this._chip(ctx, txt, px, py, z.level === "DANGER" ? "#b5241a" : "#a35f05", 12);
    }
    ctx.restore();
  }

  // loupe : valeurs mesurées placées à l'endroit de la mesure + noms d'équipements
  _drawDetailLabels(ctx, s, t, v) {
    const z = s.zones && s.zones[this.focusZone];
    ctx.save();
    ctx.scale(1 / v.s, 1 / v.s);
    const zr = this.zoneById[this.focusZone];
    for (const e of this.f.equipment || []) {
      if (zr) {
        const [x0, y0, x1, y1] = zr.rect;
        if (e.x < x0 - 1 || e.x > x1 + 1 || e.y < y0 - 1 || e.y > y1 + 1) continue;
      }
      ctx.font = "11px system-ui"; ctx.textAlign = "center"; ctx.textBaseline = "top";
      ctx.fillStyle = "rgba(230,237,247,.85)";
      ctx.fillText(e.label, (e.x + .5) * v.s, (e.y + 1) * v.s + 1);
    }
    if (z && z.top) {
      z.top.forEach((r, i) => {
        const val = Tween.get("lbl" + this.focusZone + r.type, r.value);
        const txt = `${r.icon} ${U.fmt(val)} ${r.unit}${r.trend === "up" ? " ▲" : r.trend === "down" ? " ▼" : ""}`;
        const px = (r.x + .5) * v.s, py = (r.y + .5) * v.s;
        // petite ligne de rappel vers la mesure
        const ly = py - 26 - i * 4;
        ctx.strokeStyle = "rgba(255,255,255,.6)"; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(px, ly + 9); ctx.stroke();
        ctx.fillStyle = "#fff"; ctx.beginPath(); ctx.arc(px, py, 2.5, 0, 7); ctx.fill();
        this._chip(ctx, txt, px, ly, r.score >= 1 ? "#b5241a" : "#a35f05", 13);
      });
    }
    ctx.restore();
  }

  _chip(ctx, txt, px, py, bg, size) {
    ctx.font = `700 ${size}px system-ui`;
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    const w = ctx.measureText(txt).width + 12, h = size + 8;
    const ox = this._ox || 0;           // on est dans le repère translaté de la carte
    let x = U.clamp(px, w / 2 + 2 - ox, this.cssW - w / 2 - 2 - ox);
    ctx.fillStyle = bg;
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x - w / 2, py - h / 2, w, h, 5); else ctx.rect(x - w / 2, py - h / 2, w, h);
    ctx.fill();
    ctx.fillStyle = "#fff";
    ctx.fillText(txt, x, py + 1);
  }
}
