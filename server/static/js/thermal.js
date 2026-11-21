// thermal.js — "caméra thermique" du drone.
// Si le script webcam de Teammate 1 envoie des images (/api/vision), on les affiche.
// Sinon on fabrique une vue thermique simulée à partir de la carte autour du drone
// (feu = blanc/jaune, fumée chaude = violet, corps humain ~37 °C = orange), pour que
// l'écran reste vivant même sans webcam.
"use strict";

const Thermal = {
  cv: null, ctx: null, img: null, tag: null, small: null,
  // palette type "inferno"
  stops: [[0, [0, 0, 4]], [.2, [40, 11, 84]], [.4, [120, 28, 109]], [.6, [200, 60, 77]],
          [.8, [248, 140, 30]], [1, [252, 255, 164]]],

  init() {
    this.cv = document.getElementById("thermal");
    this.ctx = this.cv.getContext("2d");
    this.img = document.getElementById("camImg");
    this.tag = document.getElementById("camTag");
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

  draw(now) {
    const s = Live.s;
    const cam = s && s.camera;
    const fresh = cam && cam.jpg && (Live.serverNow() - cam.at) < 3;
    if (fresh) {
      if (this.img.dataset.at !== String(cam.at)) {
        this.img.src = "data:image/jpeg;base64," + cam.jpg;
        this.img.dataset.at = String(cam.at);
      }
      this.img.style.display = "block";
      this.tag.textContent = cam.person ? `PERSONNE DÉTECTÉE · ${Math.round((cam.conf || 0) * 100)} %` : "CAMÉRA DRONE · LIVE";
      return;
    }
    this.img.style.display = "none";
    const d = s && s.drone;
    const g = this.ctx;
    if (!d || d.state === "OUT") {
      g.fillStyle = "#000"; g.fillRect(0, 0, 200, 150);
      g.fillStyle = "#33404f"; g.font = "12px system-ui"; g.textAlign = "center";
      g.fillText(d ? "Drone hors du bâtiment" : "Pas de signal", 100, 78);
      this.tag.textContent = "CAMÉRA THERMIQUE · SIMULÉE";
      return;
    }
    // vue 10 m x 7,5 m centrée sur le drone, 4 pixels par mètre
    const t = now / 1000;
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
    // HUD
    g.strokeStyle = "rgba(255,255,255,.7)"; g.lineWidth = 1;
    g.beginPath(); g.moveTo(92, 75); g.lineTo(108, 75); g.moveTo(100, 67); g.lineTo(100, 83); g.stroke();
    g.font = "bold 10px ui-monospace, monospace"; g.fillStyle = "#fff"; g.textAlign = "left";
    g.fillText(`x${d.x} y${d.y}`, 6, 13);
    g.textAlign = "right";
    g.fillText(`${Math.round(d.temp)}°C`, 194, 13);
    for (const v of victims) {
      const sx = 100 + (v.x - d.x) * 20, sy = 75 + (v.y - d.y) * 20;
      g.strokeStyle = "#2ee87a"; g.lineWidth = 1.5; g.strokeRect(sx - 12, sy - 14, 24, 28);
      g.fillStyle = "#2ee87a"; g.textAlign = "center"; g.fillText(v.id, sx, sy - 17);
    }
    this.tag.textContent = victims.length ? "PERSONNE DÉTECTÉE · SIMULÉE" : "CAMÉRA THERMIQUE · SIMULÉE";
  },
};
