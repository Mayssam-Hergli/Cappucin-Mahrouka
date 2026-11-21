// map.js — la carte, dessinée comme un plan d'intervention de sapeurs-pompiers.
//  * calque statique (une fois, hors écran) : murs pleins, portes avec leur débattement,
//    matières hachurées par zone, pictogrammes de sécurité, noms de zones et surfaces ;
//  * calque dynamique (60 images/s) : feu en palette thermique INFERNO, fumée, gaz hachuré,
//    zones non vues, prévision, trajectoire du drone, plans, victimes, drone, échelle, vent.
//  * la même classe sert à la vue globale et à la vue détaillée d'une zone (mode "detail").
// Toutes les couleurs viennent des propriétés CSS du thème (Theme.read) : la carte se
// redessine quand on passe du thème sombre au thème clair.
// Le mouvement est réservé à ce qui a un sens : drone, découverte de la carte, nouvelle
// victime (une impulsion), passage d'une zone en alerte (une onde).
"use strict";

const CELL_PX = 32;   // résolution du calque statique
const FONT_COND = '"IBM Plex Sans Condensed", "Arial Narrow", "Roboto Condensed", sans-serif';
const MAT = {
  "#": { name: "Mur" },
  ".": { name: "Sol" },
  "D": { name: "Porte intérieure" },
  "E": { name: "Sortie" },
  "P": { name: "Stock papier et bois, classe A" },
  "F": { name: "Solvants et carburant, classe B" },
  "G": { name: "Bouteilles de gaz, classe C" },
  "X": { name: "Armoire électrique" },
};
const MATERIAL_KIND = { P: "diag", F: "cross", G: "cyl", X: "zig" };
const MAP_TOKENS = [
  "map-bg", "map-floor", "map-grid", "map-wall", "map-door", "map-door-arc", "map-label", "map-label-2",
  "map-island", "map-exit-label", "mat-p-base", "mat-p-ink", "mat-f-base", "mat-f-ink", "mat-g-base", "mat-g-ink",
  "mat-x-base", "mat-x-ink", "map-burnt", "map-smoke", "map-fog", "map-fog-ink", "map-gas", "map-halo",
  "map-ink", "map-ink-2", "map-tag-bg", "map-tag-tx", "chip-warn-bg", "chip-warn-tx",
  "alarm", "alarm-fill", "amber", "evac", "entry", "attack", "on-accent",
  "inferno-0", "inferno-1", "inferno-2", "inferno-3", "inferno-4", "inferno-5",
];
const SIDE_VEC = { N: [0, -1], S: [0, 1], E: [1, 0], W: [-1, 0] };
const WIND_TO = ["le nord", "le nord-est", "l'est", "le sud-est", "le sud", "le sud-ouest", "l'ouest", "le nord-ouest"];

function hexRgb(c) {
  const m = String(c).trim().match(/^#([0-9a-f]{6})/i);
  return m ? [0, 2, 4].map(i => parseInt(m[1].slice(i, i + 2), 16)) : [0, 0, 0];
}

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
    this._victimSeen = new Map();   // id -> instant d'apparition (impulsion unique)
    this._zoneLvl = new Map();      // id -> { level, at } (onde unique au passage en alerte)
    this._animUntil = 0;            // une animation (drone, impulsion, onde) demande des images jusque-là
    this._themeRev = 0; this._staticRev = 0;
    this._applyTheme();
    this.resize();
    new ResizeObserver(() => this.resize()).observe(canvas);
    // les polices et les pictogrammes arrivent après : on redessine le calque statique une fois prêts
    Promise.all([Icons.ready, document.fonts ? document.fonts.ready : null]).then(() => this._buildStatic());
    Theme.on(() => this._applyTheme());
  }

  // couleurs du thème courant (propriétés CSS) + tout ce qui en dépend
  _applyTheme() {
    const T = this.T = Theme.read(MAP_TOKENS);
    this._themeRev = (this._themeRev || 0) + 1;
    const stops = [0, .2, .42, .62, .82, 1];
    this.inferno = stops.map((p, i) => [p, hexRgb(T["inferno-" + i])]);
    this.light = Theme.mode === "light";
    this._fogPattern = this._makeHatch(T["map-fog-ink"], 9);
    this._gasPattern = this._makeHatch(withAlpha(T["map-gas"], .8), 6);
    this._buildStatic();
  }

  infernoAt(v) {
    v = U.clamp(v, 0, 1);
    const P = this.inferno;
    for (let i = 1; i < P.length; i++) {
      if (v <= P[i][0]) {
        const [a, ca] = P[i - 1], [b, cb] = P[i];
        const k = (v - a) / (b - a);
        return ca.map((c, j) => Math.round(c + (cb[j] - c) * k));
      }
    }
    return P[P.length - 1][1];
  }

  // ------------------------------------------------------------ géométrie
  resize() {
    const dpr = window.devicePixelRatio || 1;
    this.cssW = Math.max(50, this.cv.clientWidth); this.cssH = Math.max(50, this.cv.clientHeight);
    this.cv.width = Math.round(this.cssW * dpr);
    this.cv.height = Math.round(this.cssH * dpr);
    this.dpr = dpr;
    this._worldKey = null;          // changer la taille efface le canvas : tout redessiner
  }
  _view() {
    const c = this.cam;
    // marges autour du bâtiment (en mètres) : à droite la rose des vents, en bas l'échelle
    const [pl, pr, pt, pb] = this.detail ? [0, 0, 0, 0] : [0.8, 3.6, 0.8, 1.4];
    const s = Math.min(this.cssW / (c.w + pl + pr), this.cssH / (c.h + pt + pb));
    const ox = (this.cssW - (c.w + pl + pr) * s) / 2 + pl * s - c.x * s;
    const oy = (this.cssH - (c.h + pt + pb) * s) / 2 + pt * s - c.y * s;
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
    const ar = this.cssW / this.cssH;
    if (w / h < ar) w = h * ar; else h = w / ar;
    const cx = (x0 + x1 + 1) / 2, cy = (y0 + y1 + 1) / 2;
    this.camTarget = { x: cx - w / 2, y: cy - h / 2, w, h };
    if (instant || REDUCED_MOTION) this.cam = { ...this.camTarget };
  }
  cell(x, y) { return (this.f.grid[y] || "")[x] || "#"; }
  zoneAt(x, y) {
    for (const z of this.f.zones || []) {
      const [x0, y0, x1, y1] = z.rect;
      if (x >= x0 && x <= x1 && y >= y0 && y <= y1) return z;
    }
    return null;
  }
  nearestExit(x, y, maxD = 2.5) {
    let best = null;
    for (const e of this.f.exits || []) {
      const d = Math.hypot(e.x - x, e.y - y);
      if (d <= maxD && (!best || d < best.d)) best = { e, d };
    }
    return best && best.e;
  }

  // -------------------------------------------------------- calque statique
  _pattern(g, kind, ink) {
    const c = document.createElement("canvas");
    const p = c.getContext("2d");
    p.strokeStyle = ink; p.fillStyle = ink; p.lineWidth = 1.3;
    if (kind === "diag") {
      c.width = c.height = 8;
      p.beginPath(); p.moveTo(0, 8); p.lineTo(8, 0); p.moveTo(-2, 2); p.lineTo(2, -2); p.moveTo(6, 10); p.lineTo(10, 6); p.stroke();
    } else if (kind === "cross") {
      c.width = c.height = 9;
      p.beginPath(); p.moveTo(0, 9); p.lineTo(9, 0); p.moveTo(0, 0); p.lineTo(9, 9); p.stroke();
    } else if (kind === "cyl") {
      c.width = 8; c.height = 11;
      p.beginPath(); if (p.roundRect) p.roundRect(2.2, 1.5, 3.6, 8, 1.8); else p.rect(2.2, 1.5, 3.6, 8); p.fill();
    } else {
      c.width = 10; c.height = 8;
      p.beginPath(); p.moveTo(0, 5.5); p.lineTo(2.5, 2.5); p.lineTo(5, 5.5); p.lineTo(7.5, 2.5); p.lineTo(10, 5.5); p.stroke();
    }
    return g.createPattern(c, "repeat");
  }

  _buildStatic() {
    const P = CELL_PX, W = this.W, H = this.H, T = this.T;
    const c = document.createElement("canvas");
    c.width = W * P; c.height = H * P;
    const g = c.getContext("2d");

    // sol + trame métrique très discrète
    g.fillStyle = T["map-floor"]; g.fillRect(0, 0, W * P, H * P);
    g.strokeStyle = T["map-grid"]; g.lineWidth = 1;
    g.beginPath();
    for (let x = 0; x <= W; x++) { g.moveTo(x * P + .5, 0); g.lineTo(x * P + .5, H * P); }
    for (let y = 0; y <= H; y++) { g.moveTo(0, y * P + .5); g.lineTo(W * P, y * P + .5); }
    g.stroke();

    // matières : teinte + hachure continue, contour de chaque îlot de stockage
    const pats = {};
    for (const [k, kind] of Object.entries(MATERIAL_KIND)) pats[k] = this._pattern(g, kind, T[`mat-${k.toLowerCase()}-ink`]);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const ch = this.cell(x, y);
      if (!MATERIAL_KIND[ch]) continue;
      g.fillStyle = T[`mat-${ch.toLowerCase()}-base`]; g.fillRect(x * P, y * P, P, P);
      g.fillStyle = pats[ch]; g.fillRect(x * P, y * P, P, P);
    }
    g.strokeStyle = T["map-island"]; g.lineWidth = 1.5;
    g.beginPath();
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const ch = this.cell(x, y); if (!MATERIAL_KIND[ch]) continue;
      if (this.cell(x, y - 1) !== ch) { g.moveTo(x * P, y * P); g.lineTo((x + 1) * P, y * P); }
      if (this.cell(x, y + 1) !== ch) { g.moveTo(x * P, (y + 1) * P); g.lineTo((x + 1) * P, (y + 1) * P); }
      if (this.cell(x - 1, y) !== ch) { g.moveTo(x * P, y * P); g.lineTo(x * P, (y + 1) * P); }
      if (this.cell(x + 1, y) !== ch) { g.moveTo((x + 1) * P, y * P); g.lineTo((x + 1) * P, (y + 1) * P); }
    }
    g.stroke();

    // murs pleins (poché) : épais, lisibles au vidéoprojecteur
    g.fillStyle = T["map-wall"];
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (this.cell(x, y) === "#") g.fillRect(x * P, y * P, P, P);

    // portes intérieures : ouverture + vantail + arc de débattement
    g.lineCap = "round";
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      if (this.cell(x, y) !== "D") continue;
      g.fillStyle = T["map-floor"]; g.fillRect(x * P, y * P, P, P);
      const horizontal = this.cell(x - 1, y) === "#" && this.cell(x + 1, y) === "#";
      const hx = horizontal ? x * P : (x + 1) * P, hy = y * P;
      g.strokeStyle = T["map-door"]; g.lineWidth = 2;
      g.beginPath();
      if (horizontal) { g.moveTo(hx, hy); g.lineTo(hx, hy - P); }      // mur horizontal : ouvre vers le haut
      else { g.moveTo(hx, hy); g.lineTo(hx + P, hy); }                  // mur vertical : ouvre vers la droite
      g.stroke();
      g.lineWidth = 1; g.strokeStyle = T["map-door-arc"];
      g.beginPath();
      if (horizontal) g.arc(hx, hy, P, -Math.PI / 2, 0); else g.arc(hx, hy, P, 0, Math.PI / 2);
      g.stroke();
    }

    // sorties : baie ouverte, pictogramme vert, repère E1…
    for (const e of this.f.exits || []) {
      g.fillStyle = T["map-floor"]; g.fillRect(e.x * P, e.y * P, P, P);
      this._picto(g, "exit", (e.x + .5) * P, (e.y + .5) * P, P * 1.15);
      const inX = e.x === 0 ? 1 : e.x === W - 1 ? -1 : 0, inY = e.y === 0 ? 1 : e.y === H - 1 ? -1 : 0;
      g.font = `700 ${P * .5}px ${FONT_COND}`; g.fillStyle = T["map-exit-label"]; g.textBaseline = "middle";
      g.textAlign = inX > 0 ? "left" : inX < 0 ? "right" : "center";
      g.fillText(e.id, (e.x + .5 + inX * 1.05) * P, (e.y + .5 + inY * 1.05) * P);
    }
    // équipements et poteaux incendie
    for (const e of this.f.equipment || []) this._picto(g, e.type, (e.x + .5) * P, (e.y + .5) * P, P * .88);
    for (const h of this.f.hydrants || []) {
      const [x, y] = Array.isArray(h) ? h : [h.x, h.y];
      this._picto(g, "hydrant", (x + .5) * P, (y + .5) * P, P * .95);
    }

    // noms des zones, posés comme sur un plan d'architecte
    g.textAlign = "left"; g.textBaseline = "top";
    for (const z of this.f.zones || []) {
      const [x0, y0, x1, y1] = z.rect;
      g.font = `700 ${P * .46}px ${FONT_COND}`; g.fillStyle = T["map-label"];
      g.fillText(`${z.id}  ${z.name}`, x0 * P + P * .25, y0 * P + P * .2);
      g.font = `500 ${P * .36}px ${FONT_COND}`; g.fillStyle = T["map-label-2"];
      g.fillText(`${(x1 - x0 + 1) * (y1 - y0 + 1)} m²`, x0 * P + P * .25, y0 * P + P * .72);
    }
    this.staticLayer = c;
    this._staticRev = (this._staticRev || 0) + 1;
  }

  _picto(g, name, cx, cy, size) {
    const img = Icons.img(name);
    if (img) g.drawImage(img, cx - size / 2, cy - size / 2, size, size);
  }

  // petit canvas W×H (1 px = 1 cellule) agrandi avec lissage : densités douces pour pas cher
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

  _makeHatch(color, step) {
    const c = document.createElement("canvas"); c.width = c.height = step;
    const g = c.getContext("2d");
    g.strokeStyle = color; g.lineWidth = 1;
    g.beginPath(); g.moveTo(0, step); g.lineTo(step, 0); g.moveTo(-1, 1); g.lineTo(1, -1); g.moveTo(step - 1, step + 1); g.lineTo(step + 1, step - 1); g.stroke();
    return this.ctx.createPattern(c, "repeat");
  }

  // cellules données, remplies d'un motif en coordonnées écran (hachures nettes à tout zoom) :
  // un seul chemin, un seul remplissage (bien plus léger qu'un fillRect par cellule)
  _hatchCells(ctx, v, keys, pattern, alpha, test) {
    ctx.save();
    ctx.scale(1 / v.s, 1 / v.s);
    ctx.fillStyle = pattern; ctx.globalAlpha = alpha;
    ctx.beginPath();
    for (const k of keys) {
      const [x, y] = typeof k === "string" ? k.split(",").map(Number) : k;
      if (test && !test(x, y)) continue;
      ctx.rect(x * v.s, y * v.s, v.s, v.s);
    }
    ctx.fill();
    ctx.restore();
  }

  // -------------------------------------------------------------- dessin
  // Deux couches :
  //  * le « monde » (plan, feu, fumée, brouillard, plans, étiquettes de mission, rose des vents),
  //    dessiné dans un canvas hors écran et redessiné seulement quand l'état, la caméra,
  //    le thème ou les calques changent ;
  //  * par-dessus, à chaque image : drone interpolé, victimes, ondes, survol, valeurs qui défilent.
  // Chaque état reçu du serveur (2 fois par seconde) redessine tout : le drone et les chemins
  // suivent toujours le serveur. Entre deux états, l'image n'est redessinée que si quelque chose
  // s'anime (drone qui glisse, valeur qui défile, onde, survol) : PC sans carte graphique.
  // Une erreur dans une couche est signalée dans la console sans bloquer les autres couches.
  draw(now) {
    const s = Live.s;
    const ctx = this.ctx, T = this.T;
    let camMoving = false;
    for (const k of ["x", "y", "w", "h"]) {
      let nv = REDUCED_MOTION ? this.camTarget[k] : U.lerp(this.cam[k], this.camTarget[k], 0.12);
      if (Math.abs(nv - this.camTarget[k]) < 2e-3) nv = this.camTarget[k];
      if (nv !== this.cam[k]) camMoving = true;
      this.cam[k] = nv;
    }
    const v = this._view();
    this._ox = v.ox;
    const fading = !!s && !REDUCED_MOTION && this.layers.fog && Live.fogOn() && now - Live.lastReveal < 650;
    const key = [Live.at, this.cam.x, this.cam.y, this.cam.w, this.cam.h, this.cv.width, this.cv.height,
      this._themeRev, this._staticRev, JSON.stringify(this.layers), this.focusZone, fading ? now : 0].join("|");
    const worldChanged = key !== this._worldKey;
    const hoverKey = this.hover ? this.hover.join(",") : "";
    const busy = worldChanged || hoverKey !== this._hoverKey || now < this._animUntil;
    if (!busy) return;
    this._hoverKey = hoverKey;
    if (worldChanged) {
      this._worldKey = key;
      if (!this._world) this._world = document.createElement("canvas");
      const wctx = this._world.getContext("2d");
      wctx.save();
      try { this._drawWorld(s, now, v); }
      catch (e) { this._report("plan", e); this._worldKey = null; }   // réessayé à l'image suivante
      finally { wctx.restore(); }
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (this._world.width) ctx.drawImage(this._world, 0, 0);
    if (!s) return;

    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.save();
    ctx.translate(v.ox, v.oy);
    ctx.scale(v.s, v.s);
    const layer = (name, fn) => { ctx.save(); try { fn(); } catch (e) { this._report(name, e); } finally { ctx.restore(); } };
    layer("victimes", () => this._drawVictims(ctx, s, now, v));
    layer("drone", () => this._drawDrone(ctx, s, now, v));
    layer("ondes", () => this._drawZoneWaves(ctx, s, now, v));
    layer("valeurs", () => { if (this.detail) this._drawDetailLabels(ctx, s, v); else this._drawZoneChips(ctx, s, v); });
    layer("étiquette drone", () => this._drawDroneLabel(ctx, v));
    if (this.hover && !this.detail) {
      ctx.strokeStyle = withAlpha(T["map-ink"], .8); ctx.lineWidth = 1.5 / v.s;
      ctx.strokeRect(this.hover[0] + .04, this.hover[1] + .04, .92, .92);
    }
    ctx.restore();
  }

  // erreur de dessin : une ligne dans la console par couche et par message (pas 60 par seconde)
  _report(layer, e) {
    const k = layer + ":" + (e && e.message);
    this._reported = this._reported || new Set();
    if (this._reported.has(k)) return;
    this._reported.add(k);
    console.error(`[carte] couche « ${layer} » :`, e);
  }

  // force un redessin complet (thème, calques, taille)
  invalidate() { this._worldKey = null; }

  _drawWorld(s, now, v) {
    const wc = this._world;
    if (wc.width !== this.cv.width || wc.height !== this.cv.height) { wc.width = this.cv.width; wc.height = this.cv.height; }
    const ctx = wc.getContext("2d"), T = this.T;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = T["map-bg"];
    ctx.fillRect(0, 0, this.cssW, this.cssH);
    ctx.save();
    ctx.translate(v.ox, v.oy);
    ctx.scale(v.s, v.s);
    ctx.imageSmoothingEnabled = true;
    if (this.staticLayer) ctx.drawImage(this.staticLayer, 0, 0, this.W, this.H);
    if (!s) { ctx.restore(); if (!this.detail) this._overlays(ctx, null, v); return; }

    const fog = this.layers.fog && Live.fogOn();
    const revealed = (k) => !fog || Live.revealAt.has(k);
    const rx0 = Math.max(0, Math.floor(this.cam.x)), ry0 = Math.max(0, Math.floor(this.cam.y));
    const rx1 = Math.min(this.W, Math.ceil(this.cam.x + this.cam.w)), ry1 = Math.min(this.H, Math.ceil(this.cam.y + this.cam.h));

    // brûlé : le bas de la palette thermique
    ctx.fillStyle = T["map-burnt"];
    ctx.beginPath();
    for (const k of Live.burnt) if (revealed(k)) { const [x, y] = k.split(",").map(Number); ctx.rect(x, y, 1, 1); }
    ctx.fill();

    // fumée : couche de densité grise, douce et immobile
    if (this.layers.smoke && Live.smokeNow.size) {
      const [sr, sg, sb] = hexRgb(T["map-smoke"]);
      this._field("smoke", ctx, (d) => {
        for (const k of Live.smokeNow) {
          if (!revealed(k)) continue;
          const [x, y] = k.split(",").map(Number);
          const i = (y * this.W + x) * 4;
          d[i] = sr; d[i + 1] = sg; d[i + 2] = sb; d[i + 3] = Math.round(255 * (0.26 + 0.16 * U.noise(x * .35, y * .35, 0)));
        }
      });
    }
    // gaz : hachure jaune-vert
    if (this.layers.gas && Live.gasNow.size) {
      ctx.fillStyle = withAlpha(T["map-gas"], .12);
      ctx.beginPath();
      for (const k of Live.gasNow) if (revealed(k)) { const [x, y] = k.split(",").map(Number); ctx.rect(x, y, 1, 1); }
      ctx.fill();
      this._hatchCells(ctx, v, Live.gasNow, this._gasPattern, 1, (x, y) => revealed(x + "," + y));
    }

    // feu en INFERNO : front actif clair, cœur rouge-violet
    this._fireHidden = [];
    if (this.layers.fire && Live.fireNow.size) {
      const seen = [];
      for (const k of Live.fireNow) {
        const [x, y] = k.split(",").map(Number);
        (revealed(k) ? seen : this._fireHidden).push([x, y]);
      }
      const front = ([x, y]) => [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) =>
        !Live.fireNow.has((x + dx) + "," + (y + dy)) && this.cell(x + dx, y + dy) !== "#");
      this._field("fire", ctx, (d) => {
        for (const c of seen) {
          const [r, gg, b] = this.infernoAt((front(c) ? 0.9 : 0.6) + 0.08 * U.noise(c[0], c[1], 0));
          const i = (c[1] * this.W + c[0]) * 4;
          d[i] = r; d[i + 1] = gg; d[i + 2] = b; d[i + 3] = 255;
        }
      });
      this._glow(ctx, seen.filter(front), rx0, ry0, rx1, ry1, 0.16);
    }

    // zones non encore vues par le drone (voile sombre, ou papier en thème clair)
    if (fog) {
      const [fr, fg, fb] = hexRgb(T["map-fog"]);
      this._field("fog", ctx, (d) => {
        for (let y = 0; y < this.H; y++) {
          for (let x = 0; x < this.W; x++) {
            const ra = Live.revealAt.get(x + "," + y);
            let a = 0.78;
            if (ra != null) a = REDUCED_MOTION ? 0 : 0.78 * (1 - U.clamp((now - ra) / 600, 0, 1));
            const i = (y * this.W + x) * 4;
            d[i] = fr; d[i + 1] = fg; d[i + 2] = fb; d[i + 3] = Math.round(255 * a);
          }
        }
      });
      const unseen = [];
      for (let y = ry0; y < ry1; y++) for (let x = rx0; x < rx1; x++) if (!Live.revealAt.has(x + "," + y)) unseen.push([x, y]);
      this._hatchCells(ctx, v, unseen, this._fogPattern, 1);
    }
    // feu signalé par les capteurs mais pas encore vu : lueur estimée, au-dessus des zones non vues
    if (this._fireHidden.length) this._glow(ctx, this._fireHidden, rx0, ry0, rx1, ry1, 0.1);

    // prévision du feu (+3 min) pendant le trajet : contour pointillé, voile léger
    if (s.phase === "EN_ROUTE" && Live.forecast.size) {
      ctx.fillStyle = withAlpha(T["inferno-3"], .16);
      ctx.beginPath();
      for (const k of Live.forecast) { const [x, y] = k.split(",").map(Number); ctx.rect(x, y, 1, 1); }
      ctx.fill();
      ctx.strokeStyle = withAlpha(this.light ? T["alarm"] : T["inferno-4"], .9);
      ctx.lineWidth = 1.5 / v.s; ctx.setLineDash([4 / v.s, 3 / v.s]);
      ctx.beginPath();
      for (const k of Live.forecast) {
        const [x, y] = k.split(",").map(Number);
        if (!Live.forecast.has((x + 1) + "," + y)) { ctx.moveTo(x + 1, y); ctx.lineTo(x + 1, y + 1); }
        if (!Live.forecast.has(x + "," + (y + 1))) { ctx.moveTo(x, y + 1); ctx.lineTo(x + 1, y + 1); }
        if (!Live.forecast.has((x - 1) + "," + y)) { ctx.moveTo(x, y); ctx.lineTo(x, y + 1); }
        if (!Live.forecast.has(x + "," + (y - 1))) { ctx.moveTo(x, y); ctx.lineTo(x + 1, y); }
      }
      ctx.stroke(); ctx.setLineDash([]);
    }

    this._drawZoneAlerts(ctx, s, now, v);
    this._drawTrail(ctx, s, v);                       // sous les plans, les victimes et les étiquettes
    this._mission = null;
    if (this.layers.paths) this._drawPlans(ctx, s, v);
    this._drawSensors(ctx, s, v);
    if (this.detail && this.focusZone && this.zoneById[this.focusZone]) {
      const [x0, y0, x1, y1] = this.zoneById[this.focusZone].rect;
      ctx.strokeStyle = withAlpha(T["map-ink"], .35); ctx.setLineDash([4 / v.s, 3 / v.s]); ctx.lineWidth = 1 / v.s;
      ctx.strokeRect(x0, y0, x1 - x0 + 1, y1 - y0 + 1); ctx.setLineDash([]);
    }
    ctx.restore();
    ctx.save();
    try { this._drawMissionLabels(ctx, v); } catch (e) { this._report("étiquettes de mission", e); }
    finally { ctx.restore(); }
    if (!this.detail) this._overlays(ctx, s, v);
  }

  _glow(ctx, cells, rx0, ry0, rx1, ry1, alpha) {
    const T = this.T;
    // halo en composition normale dans les deux thèmes : le mode additif ("lighter")
    // empêchait l'affichage de toute la carte sur certains rendus logiciels.
    // Une seule image de halo, préparée une fois par thème, posée sur chaque cellule.
    if (!this._glowImg || this._glowTheme !== this._themeRev) {
      const c = document.createElement("canvas"); c.width = c.height = 64;
      const g = c.getContext("2d");
      const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
      gr.addColorStop(0, withAlpha(T["inferno-4"], 1));
      gr.addColorStop(1, withAlpha(T["inferno-3"], 0));
      g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
      this._glowImg = c; this._glowTheme = this._themeRev;
    }
    ctx.save();
    ctx.globalAlpha = alpha;
    for (const [x, y] of cells) {
      if (x < rx0 - 2 || x > rx1 + 2 || y < ry0 - 2 || y > ry1 + 2) continue;
      ctx.drawImage(this._glowImg, x + .5 - 1.6, y + .5 - 1.6, 3.2, 3.2);
    }
    ctx.restore();
  }

  // onde unique au passage d'une zone en alerte (couche animée)
  _drawZoneWaves(ctx, s, now, v) {
    if (REDUCED_MOTION) return;
    const T = this.T;
    for (const [zid, z] of Object.entries(s.zones || {})) {
      const lv = this._zoneLvl.get(zid), r0 = z.top && z.top[0];
      if (!lv || !r0 || z.level === "NORMAL") continue;
      const age = (now - lv.at) / 1000;
      if (age < 0 || age >= 1.6) continue;
      this._animUntil = Math.max(this._animUntil || 0, now + 50);
      const col = z.level === "DANGER" ? T["alarm"] : T["amber"];
      ctx.strokeStyle = withAlpha(col, 0.8 * (1 - age / 1.6));
      ctx.lineWidth = 2 / v.s;
      ctx.beginPath(); ctx.arc(r0.x + .5, r0.y + .5, 0.6 + age * 3.5, 0, 7); ctx.stroke();
    }
  }

  _drawZoneAlerts(ctx, s, now, v) {
    const T = this.T;
    for (const [zid, z] of Object.entries(s.zones || {})) {
      const prev = this._zoneLvl.get(zid);
      const rank = { NORMAL: 0, WARNING: 1, DANGER: 2 };
      if (!prev || rank[z.level] > rank[prev.level]) this._zoneLvl.set(zid, { level: z.level, at: prev ? now : -1e9 });
      else if (rank[z.level] < rank[prev.level]) this._zoneLvl.set(zid, { level: z.level, at: -1e9 });
      if (z.level === "NORMAL") continue;
      const zr = this.zoneById[zid]; if (!zr) continue;
      const [x0, y0, x1, y1] = zr.rect;
      const col = z.level === "DANGER" ? T["alarm"] : T["amber"];
      ctx.fillStyle = withAlpha(col, .05);
      ctx.fillRect(x0, y0, x1 - x0 + 1, y1 - y0 + 1);
      ctx.strokeStyle = withAlpha(col, .9);
      ctx.lineWidth = 2.5 / v.s;
      ctx.strokeRect(x0 + .04, y0 + .04, x1 - x0 + .92, y1 - y0 + .92);
    }
  }

  _path(ctx, pts) {
    ctx.beginPath();
    pts.forEach(([x, y], i) => (i ? ctx.lineTo(x + .5, y + .5) : ctx.moveTo(x + .5, y + .5)));
    ctx.stroke();
  }

  _drawPlans(ctx, s, v) {
    if (!["DRONE_INSIDE", "PLANS_READY"].includes(s.phase)) return;
    const p = s.plans || {}, T = this.T;
    ctx.lineCap = "round"; ctx.lineJoin = "round";
    // évacuation : vert ISO, trait plein, liseré pour se détacher du feu
    for (const e of p.evacuation || []) {
      if (!e.path || e.path.length < 2) continue;
      ctx.strokeStyle = withAlpha(T["map-halo"], .85); ctx.lineWidth = 5.5 / v.s; this._path(ctx, e.path);
      ctx.strokeStyle = T["evac"]; ctx.lineWidth = 3 / v.s; this._path(ctx, e.path);
    }
    // ordre d'intervention (mission.js) : remplace l'entrée seule et les flèches d'attaque
    let m = null;
    try { m = typeof Mission !== "undefined" ? Mission.get(s) : null; } catch (e) { this._report("ordre d'intervention", e); }
    if (m) {
      ctx.save();
      try { this._drawMission(ctx, m, v); this._mission = m; return; }
      catch (e) { this._report("itinéraires", e); this._mission = null; }   // repli : plans de la Sim seuls
      finally { ctx.restore(); }
    }
    // entrée des pompiers : bleu, tirets
    if (p.entry && p.entry.path && p.entry.path.length > 1) {
      ctx.setLineDash([8 / v.s, 5 / v.s]);
      ctx.strokeStyle = withAlpha(T["map-halo"], .85); ctx.lineWidth = 5.5 / v.s; this._path(ctx, p.entry.path);
      ctx.strokeStyle = T["entry"]; ctx.lineWidth = 3 / v.s; this._path(ctx, p.entry.path);
      ctx.setLineDash([]);
    }
    // attaques : cercle rouge numéroté + flèche depuis le côté d'attaque
    const byZone = {};
    for (const k of Live.fireNow) {
      const [x, y] = k.split(",").map(Number);
      const z = this.zoneAt(x, y); if (z) (byZone[z.id] = byZone[z.id] || []).push([x, y]);
    }
    for (const e of p.extinguish || []) {
      let cx, cy;
      if (e.at) { cx = e.at[0] + .5; cy = e.at[1] + .5; }
      else {
        const cells = byZone[e.zone]; if (!cells) continue;
        cx = cells.reduce((a, c) => a + c[0], 0) / cells.length + .5;
        cy = cells.reduce((a, c) => a + c[1], 0) / cells.length + .5;
      }
      const dir = SIDE_VEC[e.attack_from];
      if (dir) {
        const ax = cx + dir[0] * 3.2, ay = cy + dir[1] * 3.2, bx = cx + dir[0] * 1.05, by = cy + dir[1] * 1.05;
        ctx.strokeStyle = T["attack"]; ctx.fillStyle = T["attack"]; ctx.lineWidth = 3 / v.s;
        ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
        const a = Math.atan2(by - ay, bx - ax), hl = .55;
        ctx.beginPath(); ctx.moveTo(bx, by);
        ctx.lineTo(bx - hl * Math.cos(a - .5), by - hl * Math.sin(a - .5));
        ctx.lineTo(bx - hl * Math.cos(a + .5), by - hl * Math.sin(a + .5)); ctx.closePath(); ctx.fill();
      }
      ctx.fillStyle = T["alarm-fill"]; ctx.strokeStyle = T["map-halo"]; ctx.lineWidth = 2 / v.s;
      ctx.beginPath(); ctx.arc(cx, cy, .72, 0, 7); ctx.fill(); ctx.stroke();
      ctx.fillStyle = T["on-accent"]; ctx.font = `700 .9px ${FONT_COND}`; ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText(String(e.order), cx, cy + .04);
    }
  }

  // couleur d'une étape : bleu sauvetage, ambre mise en sécurité, rouge attaque
  _kindCol(kind) {
    const T = this.T;
    return kind === "rescue" ? T["entry"] : kind === "safety" ? T["amber"] : T["attack"];
  }

  // itinéraires de la mission, sous les victimes et les étiquettes
  _drawMission(ctx, m, v) {
    const T = this.T;
    ctx.lineCap = "round"; ctx.lineJoin = "round";
    // établissements : tuyau de la bouche d'incendie à la porte, par l'extérieur du bâtiment
    for (const h of m.hoses) {
      const pts = this._outsideRun([h.hydrant.x, h.hydrant.y], [h.door.x, h.door.y]);
      ctx.setLineDash([1.5 / v.s, 4 / v.s]);
      ctx.strokeStyle = withAlpha(T["map-halo"], .8); ctx.lineWidth = 4.5 / v.s; this._poly(ctx, pts);
      ctx.strokeStyle = T["attack"]; ctx.lineWidth = 2.2 / v.s; this._poly(ctx, pts);
      ctx.setLineDash([]);
    }
    const dash = { rescue: [8, 5], safety: [2, 4], attack: [] };
    for (const r of m.routes) {
      if (!r.path || r.path.length < 2) continue;
      const col = this._kindCol(r.kind);
      // tronçons menacés par le feu : surlignés en ambre sous le tracé
      if (r.threat.size) {
        ctx.strokeStyle = withAlpha(T["amber"], .55); ctx.lineWidth = 9 / v.s;
        ctx.beginPath();
        r.path.forEach(([x, y], i) => {
          if (i && r.threat.has(i) && r.threat.has(i - 1)) { ctx.moveTo(r.path[i - 1][0] + .5, r.path[i - 1][1] + .5); ctx.lineTo(x + .5, y + .5); }
        });
        ctx.stroke();
      }
      ctx.setLineDash((dash[r.kind] || []).map(d => d / v.s));
      ctx.strokeStyle = withAlpha(T["map-halo"], .85); ctx.lineWidth = 5.5 / v.s; this._path(ctx, r.path);
      ctx.strokeStyle = col; ctx.lineWidth = 3 / v.s; this._path(ctx, r.path);
      ctx.setLineDash([]);
      this._chevrons(ctx, r.path, col, v);
    }
    // lances : flèche de la position d'attaque vers le feu
    for (const l of m.lances) {
      const ax = l.from[0] + .5, ay = l.from[1] + .5, fx = l.to[0] + .5, fy = l.to[1] + .5;
      const d = Math.hypot(fx - ax, fy - ay);
      if (d < .8) continue;
      const k = (d - .45) / d, bx = ax + (fx - ax) * k, by = ay + (fy - ay) * k;
      ctx.strokeStyle = T["map-halo"]; ctx.lineWidth = 6 / v.s;
      ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
      ctx.strokeStyle = T["attack"]; ctx.fillStyle = T["attack"]; ctx.lineWidth = 3.5 / v.s;
      ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
      const a = Math.atan2(by - ay, bx - ax), hl = .65;
      ctx.beginPath(); ctx.moveTo(bx, by);
      ctx.lineTo(bx - hl * Math.cos(a - .5), by - hl * Math.sin(a - .5));
      ctx.lineTo(bx - hl * Math.cos(a + .5), by - hl * Math.sin(a + .5)); ctx.closePath(); ctx.fill();
    }
  }

  _poly(ctx, pts) {
    ctx.beginPath();
    pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.stroke();
  }

  // chevrons de sens de marche, tous les 3 m
  _chevrons(ctx, path, col, v) {
    const T = this.T, every = 3, sz = .32;
    let acc = every * .6;
    ctx.lineWidth = 2 / v.s;
    for (let i = 1; i < path.length; i++) {
      const [x0, y0] = path[i - 1], [x1, y1] = path[i];
      const seg = Math.hypot(x1 - x0, y1 - y0);
      let t = every - acc;
      while (t <= seg) {
        const px = x0 + .5 + (x1 - x0) * t / seg, py = y0 + .5 + (y1 - y0) * t / seg, a = Math.atan2(y1 - y0, x1 - x0);
        const ca = Math.cos(a), sa = Math.sin(a);
        const pt = (u, w) => [px + u * ca - w * sa, py + u * sa + w * ca];
        const [p1, p2, p3] = [pt(-sz * .6, -sz), pt(sz * .6, 0), pt(-sz * .6, sz)];
        for (const [c, w] of [[T["map-halo"], 4.5], [col, 2]]) {
          ctx.strokeStyle = c; ctx.lineWidth = w / v.s;
          ctx.beginPath(); ctx.moveTo(...p1); ctx.lineTo(...p2); ctx.lineTo(...p3); ctx.stroke();
        }
        t += every;
      }
      acc = (acc + seg) % every;
    }
  }

  // parcours d'un tuyau entre deux cellules du bord, en longeant l'extérieur du bâtiment
  _outsideRun(a, b) {
    const W = this.W, H = this.H, o = .55;
    const ring = ([x, y]) => {
      if (x === 0) return [-o, y + .5];
      if (x === W - 1) return [W + o, y + .5];
      if (y === 0) return [x + .5, -o];
      if (y === H - 1) return [x + .5, H + o];
      return null;
    };
    const ra = ring(a), rb = ring(b);
    const ca = [a[0] + .5, a[1] + .5], cb = [b[0] + .5, b[1] + .5];
    if (!ra || !rb) return [ca, cb];
    // position le long du périmètre (sens horaire depuis le coin nord-ouest)
    const L = 2 * (W + H + 4 * o);
    const per = ([x, y]) => {
      if (y <= -o + 1e-6) return x + o;
      if (x >= W + o - 1e-6) return (W + 2 * o) + (y + o);
      if (y >= H + o - 1e-6) return (W + 2 * o) + (H + 2 * o) + (W + o - x);
      return 2 * (W + 2 * o) + (H + 2 * o) + (H + o - y);
    };
    const corners = [[-o, -o], [W + o, -o], [W + o, H + o], [-o, H + o]].map(c => ({ c, t: per(c) % L }));
    let ta = per(ra), tb = per(rb);
    const cw = ((tb - ta) % L + L) % L <= L / 2;
    const pts = [ca, ra];
    const dist = (t) => cw ? ((t - ta) % L + L) % L : ((ta - t) % L + L) % L;
    const span = dist(tb);
    corners.filter(k => dist(k.t) > 0 && dist(k.t) < span).sort((p, q) => dist(p.t) - dist(q.t)).forEach(k => pts.push(k.c));
    pts.push(rb, cb);
    return pts;
  }

  // numéros d'étape et consignes, en coordonnées écran, sans chevauchement
  _drawMissionLabels(ctx, v) {
    const m = this._mission; if (!m || !this.layers.paths) return;
    const T = this.T, placed = [];
    if (!this.detail) {           // la rose des vents et son texte restent lisibles
      const { cx, cy, R } = this._roseAt(v);
      placed.push({ x: cx - R - 40, y: cy - R - 18, w: 2 * R + 80, h: 2 * R + 56 });
    }
    const hit = (r) => placed.some(p => r.x < p.x + p.w && r.x + r.w > p.x && r.y < p.y + p.h && r.y + r.h > p.y);
    const fit = (r) => r.x >= 2 && r.y >= 2 && r.x + r.w <= this.cssW - 2 && r.y + r.h <= this.cssH - 2;
    ctx.save();
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.textBaseline = "middle";
    // dangers sur les itinéraires : petites étiquettes ambre
    for (const r of m.routes) for (const h of r.hazards) {
      const [px, py] = this.toScreen(h.at[0] + .5, h.at[1] + .5);
      ctx.font = `700 11px ${FONT_COND}`;
      const w = ctx.measureText(h.text).width + 10, hh = 16;
      const cand = [[px + 8, py - hh - 4], [px - w - 8, py - hh - 4], [px + 8, py + 4], [px - w - 8, py + 4]]
        .map(([x, y]) => ({ x, y, w, h: hh }));
      const box = cand.find(b => fit(b) && !hit(b)) || cand[0];
      placed.push(box);
      ctx.strokeStyle = withAlpha(T["map-ink"], .7); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(box.x + (box.x > px ? 0 : box.w), box.y + hh / 2); ctx.stroke();
      ctx.fillStyle = T["chip-warn-bg"]; ctx.fillRect(box.x, box.y, w, hh);
      ctx.fillStyle = T["chip-warn-tx"]; ctx.textAlign = "left"; ctx.fillText(h.text, box.x + 5, box.y + hh / 2 + 1);
    }
    // étapes : pastille numérotée + consigne
    const fills = { rescue: T["entry"], safety: T["amber"], attack: T["alarm-fill"] };
    const showSub = v.s >= 14;
    for (const st of m.steps) {
      // la pastille se pose au-dessus de la victime ou de l'équipement, sur la position de lance sinon
      const lift = st.kind === "attack" && !st.noPos ? 0 : 1.15;
      const [px, py] = this.toScreen(st.x + .5, st.y + .5 - lift);
      const R = 11;
      if (this.detail) {                 // loupe : petite carte, pastilles seules (le détail est dans le panneau)
        ctx.lineWidth = 3; ctx.strokeStyle = T["map-halo"]; ctx.fillStyle = fills[st.kind];
        ctx.beginPath(); ctx.arc(px, py, R, 0, 7); ctx.fill(); ctx.stroke();
        ctx.fillStyle = st.kind === "safety" ? T["chip-warn-tx"] : T["on-accent"];
        ctx.font = `700 13px ${FONT_COND}`; ctx.textAlign = "center";
        ctx.fillText(String(st.n), px, py + 1);
        continue;
      }
      ctx.font = `700 13px ${FONT_COND}`;
      const tw = ctx.measureText(st.title).width;
      ctx.font = `500 11px ${FONT_COND}`;
      const sw = showSub ? ctx.measureText(st.sub).width : 0;
      const w = Math.max(tw, sw) + 14, h = showSub ? 34 : 20;
      const cand = [[px + R + 4, py - h / 2], [px - R - 4 - w, py - h / 2], [px - w / 2, py - R - 4 - h], [px - w / 2, py + R + 4]]
        .map(([x, y]) => ({ x, y, w, h }));
      const box = cand.find(b => fit(b) && !hit(b)) || cand.find(fit) || cand[0];
      placed.push(box, { x: px - R, y: py - R, w: 2 * R, h: 2 * R });
      ctx.fillStyle = T["map-tag-bg"]; ctx.fillRect(box.x, box.y, w, h);
      ctx.fillStyle = fills[st.kind]; ctx.fillRect(box.x, box.y, 3, h);
      ctx.textAlign = "left";
      ctx.font = `700 13px ${FONT_COND}`; ctx.fillStyle = T["map-tag-tx"];
      ctx.fillText(st.title, box.x + 9, box.y + (showSub ? 11 : h / 2 + 1));
      if (showSub) {
        ctx.font = `500 11px ${FONT_COND}`; ctx.fillStyle = withAlpha(T["map-tag-tx"], .78);
        ctx.fillText(st.sub, box.x + 9, box.y + 25);
      }
      ctx.lineWidth = 3; ctx.strokeStyle = T["map-halo"]; ctx.fillStyle = fills[st.kind];
      ctx.beginPath(); ctx.arc(px, py, R, 0, 7); ctx.fill(); ctx.stroke();
      if (st.urgent) { ctx.strokeStyle = T["alarm"]; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(px, py, R + 3, 0, 7); ctx.stroke(); }
      ctx.fillStyle = st.kind === "safety" ? T["chip-warn-tx"] : T["on-accent"];
      ctx.font = `700 13px ${FONT_COND}`; ctx.textAlign = "center";
      ctx.fillText(String(st.n), px, py + 1);
    }
    ctx.restore();
  }

  // trajectoire du drone : une seule ligne de vol lissée (Catmull-Rom centripète) passant
  // par les positions envoyées par le serveur ; les segments anciens s'estompent.
  _drawTrail(ctx, s, v) {
    const raw = s.trail || [];
    const pts = [];
    for (const [x, y] of raw) {
      const p = [x + .5, y + .5], q = pts[pts.length - 1];
      if (!q || q[0] !== p[0] || q[1] !== p[1]) pts.push(p);
    }
    if (!pts.length) return;
    const T = this.T, ink = T["map-ink"];
    if (pts.length > 1) {
      const n = pts.length - 1;
      ctx.lineCap = "round"; ctx.lineJoin = "round";
      ctx.lineWidth = 2 / v.s;
      for (let i = 0; i < n; i++) {
        const p0 = pts[Math.max(0, i - 1)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(n, i + 2)];
        const [c1, c2] = MapView._crControls(p0, p1, p2, p3);
        const a = 0.08 + 0.62 * Math.pow((i + 1) / n, 1.6);
        ctx.strokeStyle = withAlpha(ink, a);
        ctx.beginPath(); ctx.moveTo(p1[0], p1[1]); ctx.bezierCurveTo(c1[0], c1[1], c2[0], c2[1], p2[0], p2[1]); ctx.stroke();
      }
    }
    // point d'entrée, et point de sortie une fois le drone dehors
    const mark = (p, filled, text) => {
      ctx.lineWidth = 2 / v.s; ctx.strokeStyle = ink; ctx.fillStyle = filled ? ink : T["map-halo"];
      ctx.beginPath(); ctx.arc(p[0], p[1], .32, 0, 7); ctx.fill(); ctx.stroke();
      ctx.save(); ctx.scale(1 / v.s, 1 / v.s);
      ctx.font = `600 11px ${FONT_COND}`; ctx.textAlign = "center"; ctx.textBaseline = "bottom";
      ctx.lineWidth = 3; ctx.strokeStyle = T["map-halo"]; ctx.strokeText(text, p[0] * v.s, (p[1] - .45) * v.s);
      ctx.fillStyle = ink; ctx.fillText(text, p[0] * v.s, (p[1] - .45) * v.s);
      ctx.restore();
    };
    const first = pts[0], fe = this.nearestExit(first[0] - .5, first[1] - .5);
    mark(first, false, fe ? `Entrée ${fe.id}` : "Entrée");
    if (s.drone && s.drone.state === "OUT" && pts.length > 1) {
      const last = pts[pts.length - 1], le = this.nearestExit(last[0] - .5, last[1] - .5);
      mark(last, true, le ? `Sortie ${le.id}` : "Sortie");
    }
  }

  // points de contrôle Bézier d'un segment p1→p2 de Catmull-Rom centripète (alpha = 0,5)
  static _crControls(p0, p1, p2, p3) {
    const d = (a, b) => Math.sqrt(Math.hypot(b[0] - a[0], b[1] - a[1]));
    const d1 = d(p0, p1), d2 = d(p1, p2), d3 = d(p2, p3), e = 1e-6;
    let c1 = p1, c2 = p2;
    if (d1 > e) {
      const a = d1 * d1, b = d2 * d2, k = 2 * a + 3 * d1 * d2 + b, m = 3 * d1 * (d1 + d2);
      c1 = [(a * p2[0] - b * p0[0] + k * p1[0]) / m, (a * p2[1] - b * p0[1] + k * p1[1]) / m];
    } else c1 = [p1[0] + (p2[0] - p1[0]) / 3, p1[1] + (p2[1] - p1[1]) / 3];
    if (d3 > e) {
      const a = d3 * d3, b = d2 * d2, k = 2 * a + 3 * d3 * d2 + b, m = 3 * d3 * (d3 + d2);
      c2 = [(a * p1[0] - b * p3[0] + k * p2[0]) / m, (a * p1[1] - b * p3[1] + k * p2[1]) / m];
    } else c2 = [p2[0] - (p2[0] - p1[0]) / 3, p2[1] - (p2[1] - p1[1]) / 3];
    return [c1, c2];
  }

  _drawSensors(ctx, s, v) {
    const T = this.T;
    for (const se of s.sensors || []) {
      const col = se.level === "ALARM" ? T["alarm"] : se.level === "WARNING" ? T["amber"] : null;
      ctx.fillStyle = col || T["map-halo"]; ctx.strokeStyle = col || T["map-ink-2"]; ctx.lineWidth = 1.5 / v.s;
      ctx.fillRect(se.x + .25, se.y + .25, .5, .5); ctx.strokeRect(se.x + .25, se.y + .25, .5, .5);
      if (this.detail) {
        ctx.fillStyle = T["map-ink-2"]; ctx.font = `600 .42px ${FONT_COND}`; ctx.textAlign = "center"; ctx.textBaseline = "top";
        ctx.fillText(`${se.id}${se.src === "real" ? " (réel)" : ""}`, se.x + .5, se.y + .85);
      }
    }
  }

  // forme de statut (lisible aussi en niveaux de gris) : rond plein = marche,
  // triangle = blessé, rond vide = ne répond pas, losange vide = état inconnu
  _shape(ctx, status, x, y, r, v) {
    const T = this.T;
    ctx.lineWidth = 2.2 / v.s;
    ctx.beginPath();
    if (status === "injured") { ctx.moveTo(x, y - r * 1.1); ctx.lineTo(x + r, y + r * .75); ctx.lineTo(x - r, y + r * .75); ctx.closePath(); }
    else if (status === "walking" || status === "no_answer") ctx.arc(x, y, r * .85, 0, 7);
    else { ctx.moveTo(x, y - r); ctx.lineTo(x + r, y); ctx.lineTo(x, y + r); ctx.lineTo(x - r, y); ctx.closePath(); }
    const col = status === "walking" ? T["evac"] : status === "injured" ? T["alarm"] : status === "no_answer" ? T["amber"] : T["map-ink"];
    ctx.save();
    ctx.strokeStyle = T["map-halo"]; ctx.lineWidth = 5 / v.s; ctx.stroke();
    ctx.restore();
    if (status === "walking" || status === "injured") { ctx.fillStyle = col; ctx.fill(); }
    else { ctx.fillStyle = T["map-halo"]; ctx.fill(); ctx.strokeStyle = col; ctx.stroke(); }
  }

  _drawVictims(ctx, s, now, v) {
    const T = this.T;
    // victimes déjà connues à l'ouverture de la page : pas d'impulsion (seules les nouvelles en ont une)
    if (!this._victimInit) {
      for (const vi of s.victims || []) if (vi.found) this._victimSeen.set(vi.id, -1e9);
      this._victimInit = true;
    }
    for (const vi of s.victims || []) {
      if (!vi.found) continue;
      if (!this._victimSeen.has(vi.id)) this._victimSeen.set(vi.id, now);
      const x = vi.x + .5, y = vi.y + .5;
      const age = (now - this._victimSeen.get(vi.id)) / 1000;
      if (!REDUCED_MOTION && age < 1.4) {            // une impulsion à l'apparition
        this._animUntil = Math.max(this._animUntil, now + 50);
        ctx.strokeStyle = withAlpha(T["map-ink"], 0.9 * (1 - age / 1.4)); ctx.lineWidth = 2 / v.s;
        ctx.beginPath(); ctx.arc(x, y, .5 + age * 2.2, 0, 7); ctx.stroke();
      }
      this._shape(ctx, vi.status, x, y, .5, v);
      ctx.font = `700 .62px ${FONT_COND}`; ctx.textAlign = "left"; ctx.textBaseline = "middle";
      ctx.lineWidth = 3 / v.s; ctx.strokeStyle = T["map-halo"]; ctx.strokeText(vi.id, x + .7, y);
      ctx.fillStyle = T["map-ink"]; ctx.fillText(vi.id, x + .7, y);
    }
  }

  _drawDrone(ctx, s, now, v) {
    const d = s.drone, T = this.T;
    if (!d || d.state === "OUT" && !this.drone) return;
    const tx = d.x + .5, ty = d.y + .5;
    if (!this.drone) this.drone = { x: tx, y: ty };
    const dt = Math.min(0.1, (now - (this._lastNow || now)) / 1000); this._lastNow = now;
    const k = REDUCED_MOTION ? 1 : 1 - Math.exp(-dt * 7);
    const dx = tx - this.drone.x, dy = ty - this.drone.y;
    if (Math.hypot(dx, dy) > 6) { this.drone.x = tx; this.drone.y = ty; }
    this.drone.x += dx * k; this.drone.y += dy * k;
    if (Math.hypot(dx, dy) > .01) this._animUntil = Math.max(this._animUntil, now + 50);
    if (Math.hypot(dx, dy) > .05) {
      let diff = Math.atan2(dy, dx) - this.droneHeading;
      while (diff > Math.PI) diff -= 2 * Math.PI;
      while (diff < -Math.PI) diff += 2 * Math.PI;
      this.droneHeading += diff * k;
    }
    const x = this.drone.x, y = this.drone.y;
    if (d.state === "OUT") return;

    // portée de la caméra thermique (3 m), tracé fixe
    ctx.strokeStyle = withAlpha(T["map-ink"], .3); ctx.lineWidth = 1 / v.s; ctx.setLineDash([3 / v.s, 3 / v.s]);
    ctx.beginPath(); ctx.arc(x, y, 3.2, 0, 7); ctx.stroke(); ctx.setLineDash([]);

    // quadricoptère vu de dessus (notre équipement : couleur d'encre, pas une couleur de danger)
    ctx.save();
    ctx.translate(x, y); ctx.rotate(this.droneHeading);
    ctx.strokeStyle = T["map-halo"]; ctx.lineWidth = 5 / v.s;
    ctx.beginPath(); ctx.moveTo(-.4, -.4); ctx.lineTo(.4, .4); ctx.moveTo(.4, -.4); ctx.lineTo(-.4, .4); ctx.stroke();
    ctx.strokeStyle = T["map-ink"]; ctx.lineWidth = 2 / v.s; ctx.stroke();
    for (const [rx, ry] of [[-.4, -.4], [.4, -.4], [-.4, .4], [.4, .4]]) {
      ctx.fillStyle = T["map-halo"]; ctx.beginPath(); ctx.arc(rx, ry, .2, 0, 7); ctx.fill();
      ctx.strokeStyle = T["map-ink"]; ctx.lineWidth = 1.5 / v.s; ctx.stroke();
    }
    ctx.fillStyle = T["map-ink"];
    ctx.beginPath(); ctx.moveTo(.34, 0); ctx.lineTo(-.14, -.2); ctx.lineTo(-.14, .2); ctx.closePath(); ctx.fill();
    ctx.restore();
    this._droneLabel = { x, y, d };     // dessinée en dernier, au-dessus des étiquettes de zone
  }

  // étiquette de température du drone, liseré aux couleurs de la palette thermique
  _drawDroneLabel(ctx, v) {
    const L = this._droneLabel; this._droneLabel = null;
    if (!L) return;
    const { x, y, d } = L, T = this.T;
    const temp = d.temp || 20;
    const [r, g, b] = this.infernoAt(U.clamp((temp - 20) / 60, 0, 1) * .85 + .15);
    const label = `${Math.round(temp)} °C${d.state === "RETURNING" ? " retour" : ""}`;
    ctx.save();
    ctx.scale(1 / v.s, 1 / v.s);
    ctx.font = `700 12px ${FONT_COND}`; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    const w = ctx.measureText(label).width + 12, px = x * v.s, py = (y - 1.15) * v.s;
    ctx.fillStyle = temp >= 60 ? T["alarm-fill"] : T["map-tag-bg"];
    ctx.fillRect(px - w / 2, py - 9, w, 18);
    ctx.fillStyle = `rgb(${r},${g},${b})`; ctx.fillRect(px - w / 2, py + 7, w, 2);
    ctx.fillStyle = temp >= 60 ? T["on-accent"] : T["map-tag-tx"]; ctx.fillText(label, px, py);
    ctx.restore();
  }

  // valeur la plus grave de chaque zone en alerte, posée là où elle a été mesurée
  _drawZoneChips(ctx, s, v) {
    const T = this.T;
    ctx.save();
    ctx.scale(1 / v.s, 1 / v.s);
    for (const [zid, z] of Object.entries(s.zones || {})) {
      if (z.level === "NORMAL" || !z.top || !z.top.length) continue;
      const r = z.top[0];
      const val = Tween.get("chip" + zid, r.value);
      if (val !== r.value) this._animUntil = Math.max(this._animUntil, performance.now() + 50);
      const txt = `${r.label} ${U.fmt(val)} ${r.unit}${r.trend === "up" ? " ▲" : ""}`;
      const danger = z.level === "DANGER";
      this._chip(ctx, txt, (r.x + .5) * v.s, (r.y - .35) * v.s, danger ? T["alarm-fill"] : T["chip-warn-bg"],
        danger ? T["on-accent"] : T["chip-warn-tx"], 13);
    }
    ctx.restore();
  }

  _drawDetailLabels(ctx, s, v) {
    const z = s.zones && s.zones[this.focusZone], T = this.T;
    ctx.save();
    ctx.scale(1 / v.s, 1 / v.s);
    const zr = this.zoneById[this.focusZone];
    for (const e of this.f.equipment || []) {
      if (zr) {
        const [x0, y0, x1, y1] = zr.rect;
        if (e.x < x0 - 1 || e.x > x1 + 1 || e.y < y0 - 1 || e.y > y1 + 1) continue;
      }
      ctx.font = `500 11px ${FONT_COND}`; ctx.textAlign = "center"; ctx.textBaseline = "top";
      // étiquette gardée dans le cadre de la vue détaillée
      const lw = ctx.measureText(e.label).width, ox = this._ox || 0;
      const lx = U.clamp((e.x + .5) * v.s, lw / 2 + 3 - ox, this.cssW - lw / 2 - 3 - ox), ly = (e.y + 1) * v.s + 2;
      ctx.lineWidth = 3; ctx.strokeStyle = T["map-halo"]; ctx.strokeText(e.label, lx, ly);
      ctx.fillStyle = T["map-ink"]; ctx.fillText(e.label, lx, ly);
    }
    if (z && z.top) {
      z.top.forEach((r, i) => {
        const val = Tween.get("lbl" + this.focusZone + r.type, r.value);
        if (val !== r.value) this._animUntil = Math.max(this._animUntil, performance.now() + 50);
        const txt = `${r.label} ${U.fmt(val)} ${r.unit}${r.trend === "up" ? " ▲" : r.trend === "down" ? " ▼" : ""}`;
        const px = (r.x + .5) * v.s, py = (r.y + .5) * v.s;
        const ly = py - 26 - i * 4;
        ctx.strokeStyle = withAlpha(T["map-ink"], .6); ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(px, ly + 9); ctx.stroke();
        ctx.fillStyle = T["map-ink"]; ctx.beginPath(); ctx.arc(px, py, 2.5, 0, 7); ctx.fill();
        const hot = r.score >= 1;
        this._chip(ctx, txt, px, ly, hot ? T["alarm-fill"] : T["chip-warn-bg"], hot ? T["on-accent"] : T["chip-warn-tx"], 13);
      });
    }
    ctx.restore();
  }

  _chip(ctx, txt, px, py, bg, fg, size) {
    ctx.font = `700 ${size}px ${FONT_COND}`;
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    const w = ctx.measureText(txt).width + 12, h = size + 8;
    const ox = this._ox || 0;
    const x = U.clamp(px, w / 2 + 2 - ox, this.cssW - w / 2 - 2 - ox);
    ctx.fillStyle = bg;
    ctx.fillRect(x - w / 2, py - h / 2, w, h);
    ctx.fillStyle = fg;
    ctx.fillText(txt, x, py + 1);
  }

  // centre et rayon de la rose des vents, en coordonnées écran
  _roseAt(v) {
    const R = 27, right = v.ox + this.W * v.s, margin = this.cssW - right;
    const inMargin = margin >= 2 * R + 14;
    return { R, cx: inMargin ? right + margin / 2 : this.cssW - R - 14, cy: inMargin ? v.oy + R + 14 : R + 16 };
  }

  // échelle 5 m et rose des vents (vue globale seulement), en coordonnées écran
  _overlays(ctx, s, v) {
    const T = this.T;
    ctx.save();
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    // échelle graphique
    const L = 5 * v.s, x0 = Math.max(16, v.ox), y0 = this.cssH - 16;
    ctx.strokeStyle = T["map-ink-2"]; ctx.fillStyle = T["map-ink-2"]; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x0 + L, y0);
    for (const k of [0, .5, 1]) { ctx.moveTo(x0 + L * k, y0 - (k === .5 ? 4 : 6)); ctx.lineTo(x0 + L * k, y0); }
    ctx.stroke();
    ctx.fillRect(x0, y0 - 3, L / 2, 3);
    ctx.font = `600 12px ${FONT_COND}`; ctx.textBaseline = "bottom"; ctx.textAlign = "left";
    ctx.fillText("5 m", x0 + L + 6, y0 + 2);

    // rose des vents : nord en haut, flèche = direction VERS laquelle souffle le vent
    const { cx, cy, R } = this._roseAt(v);
    ctx.fillStyle = withAlpha(T["map-bg"], .85); ctx.strokeStyle = T["map-ink-2"]; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, 7); ctx.fill(); ctx.stroke();
    for (let i = 0; i < 8; i++) {
      const a = i * Math.PI / 4, l = i % 2 ? 3 : 6;
      ctx.beginPath();
      ctx.moveTo(cx + Math.sin(a) * (R - l), cy - Math.cos(a) * (R - l));
      ctx.lineTo(cx + Math.sin(a) * R, cy - Math.cos(a) * R); ctx.stroke();
    }
    ctx.fillStyle = T["map-ink"]; ctx.font = `700 12px ${FONT_COND}`; ctx.textAlign = "center"; ctx.textBaseline = "bottom";
    ctx.fillText("N", cx, cy - R - 2);
    const w = s && s.wind;
    ctx.font = `600 12px ${FONT_COND}`; ctx.textBaseline = "top"; ctx.fillStyle = T["map-ink-2"];
    if (w && w.kmh > 0) {
      const a = (w.deg || 0) * Math.PI / 180, ux = Math.sin(a), uy = -Math.cos(a);
      const L2 = R - 7;
      ctx.strokeStyle = T["map-ink"]; ctx.fillStyle = T["map-ink"]; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(cx - ux * L2, cy - uy * L2); ctx.lineTo(cx + ux * (L2 - 6), cy + uy * (L2 - 6)); ctx.stroke();
      const hx = cx + ux * L2, hy = cy + uy * L2, aa = Math.atan2(uy, ux);
      ctx.beginPath(); ctx.moveTo(hx, hy);
      ctx.lineTo(hx - 9 * Math.cos(aa - .45), hy - 9 * Math.sin(aa - .45));
      ctx.lineTo(hx - 9 * Math.cos(aa + .45), hy - 9 * Math.sin(aa + .45)); ctx.closePath(); ctx.fill();
      ctx.fillStyle = T["map-ink-2"];
      ctx.fillText(`Vent ${Math.round(w.kmh)} km/h`, cx, cy + R + 6);
      ctx.fillText(`vers ${WIND_TO[Math.round(((w.deg % 360) + 360) % 360 / 45) % 8]}`, cx, cy + R + 21);
    } else {
      ctx.fillText(w ? "Vent nul" : "Vent non relevé", cx, cy + R + 6);
    }
    ctx.restore();
  }
}
