// thermal.js — "caméra thermique" du drone.
// Si le script webcam envoie des images (/api/vision), on les affiche.
// Sinon on fabrique une vue thermique simulée à partir de la carte autour du drone
// (feu = blanc/jaune, fumée chaude = violet, corps humain ~37 °C = orange).
// Le cadre du viseur (coins, réticule, REC, relevés) est en HTML par-dessus le canvas.
"use strict";

const Thermal = {
  cv: null, ctx: null, img: null, tag: null, small: null, frameEl: null, pos: null, hudT: null,
  // palette INFERNO, la même que la carte et la jauge
  stops: [[0, [0, 0, 4]], [.2, [66, 10, 104]], [.42, [147, 38, 103]], [.62, [221, 81, 58]],
          [.82, [252, 165, 10]], [1, [252, 255, 164]]],

  init() {
    this.cv = document.getElementById("thermal");
    this.ctx = this.cv.getContext("2d");
    this.img = document.getElementById("camImg");
    this.tag = document.getElementById("camTag");
    this.frameEl = document.getElementById("cam");
    this.pos = document.getElementById("camPos");
    this.hudT = document.getElementById("camHudTemp");
    this.small = document.createElement("canvas");
    this.small.width = 40; this.small.height = 30;
    this.lut = [];
    for (let i = 0; i < 256; i++) this.lut.push(this._color(i / 255));
  },

  _color(v) {
    const s = this.stops;
    for (let i = 1; i < s.length; i++) {
      if (v <= s[i][0]) {
        const k = (v - s[i - 1][0]) / (s[i][0] - s[i - 1][0]);
        return s[i - 1][1].map((c, j) => Math.round(c + (s[i][1][j] - c) * k));
      }
    }
    return s[s.length - 1][1];
  },

  _setTag(txt) { if (this.tag.textContent !== txt) this.tag.textContent = txt; },

  // écran d'attente calme : dégradé du bas de la palette, deux lignes de texte
  _idle(title, line) {
    const g = this.ctx;
    const gr = g.createLinearGradient(0, 0, 0, 150);
    gr.addColorStop(0, "#07050c"); gr.addColorStop(1, "#1a0b26");
    g.fillStyle = gr; g.fillRect(0, 0, 200, 150);
    g.fillStyle = "rgba(255,255,255,.03)";
    for (let y = 0; y < 150; y += 3) g.fillRect(0, y, 200, 1);
    g.textAlign = "center"; g.textBaseline = "middle";
    g.fillStyle = "#e8e6e1"; g.font = '600 14px "IBM Plex Sans Condensed", "Arial Narrow", sans-serif';
    g.fillText(title, 100, 68);
    g.fillStyle = "#a3acb7"; g.font = '500 11px "IBM Plex Sans Condensed", "Arial Narrow", sans-serif';
    g.fillText(line, 100, 88);
  },

  draw(now) {
    const s = Live.s;
    const cam = s && s.camera;
    const d = s && s.drone;
    const fresh = cam && cam.jpg && (Live.serverNow() - cam.at) < 3;
    if (fresh) {
      if (this.img.dataset.at !== String(cam.at)) {
        this.img.src = "data:image/jpeg;base64," + cam.jpg;
        this.img.dataset.at = String(cam.at);
      }
      this.img.style.display = "block";
      this._idleKey = null;
      this.frameEl.classList.remove("nosig");
      this._setTag(cam.person ? `Personne détectée, ${Math.round((cam.conf || 0) * 100)} %` : "Caméra du drone en direct");
      this.hudT.textContent = d ? `${Math.round(d.temp)} °C` : "";
      this.pos.textContent = d ? `X ${d.x}  Y ${d.y}` : "";
      return;
    }
    if (this.img.style.display !== "none") this.img.style.display = "none";
    if (!d || d.state === "OUT") {
      // écran d'attente fixe : dessiné une seule fois
      const ik = d ? "out" : "ground";
      if (this._idleKey === ik) return;
      this._idleKey = ik;
      this.frameEl.classList.add("nosig");
      if (d) this._idle("Drone sorti du bâtiment", "Flux interrompu");
      else this._idle("Drone au sol", "Le flux s'affiche au lancement");
      this._setTag("Caméra thermique simulée");
      this.hudT.textContent = ""; this.pos.textContent = "";
      return;
    }
    this._idleKey = null;
    this.frameEl.classList.remove("nosig");
    // vue 10 m x 7,5 m centrée sur le drone, 4 pixels par mètre
    const t = now / 1000;
    const g = this.ctx;
    const sm = this.small.getContext("2d");
    const id = sm.createImageData(40, 30);
    const fire = [...Live.fireNow].map(k => k.split(",").map(Number)).filter(([x, y]) => Math.abs(x - d.x) < 9 && Math.abs(y - d.y) < 8);
    const victims = (s.victims || []).filter(v => v.found && Math.abs(v.x - d.x) < 6 && Math.abs(v.y - d.y) < 5);
    const f = Live.factory;
    for (let py = 0; py < 30; py++) {
      for (let px = 0; px < 40; px++) {
        const wx = d.x + .5 + (px - 20) / 4, wy = d.y + .5 + (py - 15) / 4;
        const cx = Math.floor(wx), cy = Math.floor(wy);
        let T = 21 + 2 * U.noise(px * .2, py * .2, t * .5);
        const ch = (f.grid[cy] || "")[cx];
        if (ch === "#" || ch === undefined) T = 19;
        for (const [fx, fy] of fire) {
          const dd = (fx + .5 - wx) ** 2 + (fy + .5 - wy) ** 2;
          T += 480 / (1 + dd * 1.4);
        }
        if (Live.smokeNow.has(cx + "," + cy)) T += 12 * U.noise(cx, cy, t);
        for (const v of victims) {
          const dd = (v.x + .5 - wx) ** 2 + ((v.y + .5 - wy) * 1.4) ** 2;
          if (dd < .5) T = Math.max(T, 36 + 2 * (1 - dd));
        }
        const val = U.clamp((T - 18) / (T - 18 + 45), 0, 1);
        const c = this.lut[Math.round(val * 255)];
        const n = (Math.random() - .5) * 14;                // grain du capteur
        const i = (py * 40 + px) * 4;
        id.data[i] = U.clamp(c[0] + n, 0, 255); id.data[i + 1] = U.clamp(c[1] + n, 0, 255);
        id.data[i + 2] = U.clamp(c[2] + n, 0, 255); id.data[i + 3] = 255;
      }
    }
    sm.putImageData(id, 0, 0);
    g.imageSmoothingEnabled = true;
    g.drawImage(this.small, 0, 0, 200, 150);
    // cadres de détection autour des personnes
    g.strokeStyle = "#e8e6e1"; g.lineWidth = 1.5;
    g.font = '600 10px "IBM Plex Sans Condensed", "Arial Narrow", sans-serif'; g.textAlign = "center"; g.fillStyle = "#e8e6e1";
    for (const v of victims) {
      const sx = 100 + (v.x - d.x) * 20, sy = 75 + (v.y - d.y) * 20;
      g.strokeRect(sx - 12, sy - 14, 24, 28);
      g.fillText(v.id, sx, sy - 18);
    }
    this.hudT.textContent = `${Math.round(d.temp)} °C`;
    this.pos.textContent = `X ${d.x}  Y ${d.y}`;
    this._setTag(victims.length ? "Personne détectée (simulation)" : "Caméra thermique simulée");
  },
};
