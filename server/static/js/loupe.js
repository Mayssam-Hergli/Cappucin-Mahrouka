// loupe.js — vue détaillée d'une zone en danger.
// S'ouvre toute seule à chaque nouvelle alerte DANGER (ou au clic sur une zone),
// zoome en douceur sur la pièce et affiche : équipements, valeurs mesurées à leur place,
// top 3 des mesures (filtrées), mini-courbes, tendance, âge de la mesure, risques.
"use strict";

const READING_ICON = { temp: "thermo", co: "co", gas: "gas", smoke: "smoke", o2: "o2", mq: "sensor" };
const LEVEL_FR = { DANGER: "Danger", WARNING: "Vigilance", NORMAL: "Normal" };

const Loupe = {
  el: null, view: null, zone: null, items: new Map(),

  init(factory) {
    this.el = document.getElementById("loupe");
    this.view = new MapView(document.getElementById("loupeMap"), factory, { detail: true });
    document.getElementById("loupeClose").onclick = () => this.close();
  },

  open(zoneId) {
    const wasOpen = this.el.classList.contains("open");
    const changed = this.zone !== zoneId;
    this.zone = zoneId;
    this.el.classList.add("open");
    this.el.setAttribute("aria-hidden", "false");
    this.view.resize();
    this.view.focus(zoneId, !wasOpen);   // fermée -> cadrage direct ; ouverte -> zoom animé
    if (changed) { document.getElementById("loupeReadings").innerHTML = ""; this.items.clear(); }
  },

  close() {
    this.el.classList.remove("open");
    this.el.setAttribute("aria-hidden", "true");
    this.zone = null;
  },

  // appelé à chaque nouvel état
  onState(s) {
    for (const a of s.alerts || []) {
      if (a.id > Live.seenAlert) {
        Live.seenAlert = a.id;
        if (Live.serverNow() - a.at < 10) this.open(a.zone);
      }
    }
  },

  draw(now) {
    if (!this.zone || !Live.s) return;
    this.view.layers = MainMap.layers;
    this.view.draw(now);
    const z = (Live.s.zones || {})[this.zone];
    if (!z) return;
    const lvl = document.getElementById("loupeLvl");
    lvl.textContent = LEVEL_FR[z.level] || z.level; lvl.className = "lvl " + z.level;
    this.el.classList.toggle("warn", z.level !== "DANGER");
    document.getElementById("loupeTitle").textContent = `${this.zone} ${z.name}`;
    document.getElementById("loupeScan").textContent = `Scannée à ${Math.round(z.scanned * 100)} %`;

    // top 3 mesures : la structure DOM change rarement, les chiffres défilent à chaque image
    const ul = document.getElementById("loupeReadings");
    const keys = (z.top || []).map(r => r.type);
    if (keys.join() !== [...this.items.keys()].join()) {
      ul.innerHTML = "";
      this.items.clear();
      if (!keys.length) ul.innerHTML = '<li class="empty" style="display:block;border:0;background:none">Aucune valeur anormale.</li>';
      for (const r of z.top || []) {
        const li = U.el("li");
        li.innerHTML = `${Icons.ui(READING_ICON[r.type] || "sensor")}<span class="lab">${U.esc(r.label)}</span>
          <span class="val"><b>--</b><small>${U.esc(r.unit)}</small></span>
          <span class="meta"></span><canvas width="140" height="40"></canvas>`;
        ul.appendChild(li);
        this.items.set(r.type, li);
      }
    }
    for (const r of z.top || []) {
      const li = this.items.get(r.type); if (!li) continue;
      li.classList.toggle("hot", r.score >= 1);
      const v = Tween.get("loupe" + this.zone + r.type, r.value);
      li.querySelector(".val b").textContent = U.fmt(v);
      const arrow = r.trend === "up" ? '<span class="trend-up">EN HAUSSE</span>' :
        r.trend === "down" ? '<span class="trend-down">EN BAISSE</span>' : "<span>STABLE</span>";
      const src = r.src === "drone" ? "Drone" : "Capteur " + r.src;
      const age = r.age + (Live.serverNow() - Live.s.server_time);
      li.querySelector(".meta").innerHTML = `${arrow}<span>${src}</span><span>${U.ago(age)}</span>`;
      const tk = Theme.read(["alarm", "amber"]);
      this._spark(li.querySelector("canvas"), r.hist || [], r.score >= 1 ? tk.alarm : tk.amber);
    }
    const risks = document.getElementById("loupeRisks");
    const tags = z.risk_tags || [];
    const html = (z.risks || []).map((r, i) => {
      const t = tags[i];
      const tag = t ? `<span class="rtag sev${Math.min(4, t.sev)}">${U.esc(t.tag)}</span>` : "";
      return `<li class="${t ? "tagged" : ""}">${tag}<span>${U.esc(stripEmoji(r))}</span></li>`;
    }).join("") || '<li class="none">Aucun risque identifié.</li>';
    if (risks.innerHTML !== html) risks.innerHTML = html;
    if (typeof HazardSheet !== "undefined") HazardSheet.fill(document.getElementById("loupeSheet"), this.zone);   // fiche de danger (action.js)
  },

  _spark(cv, h, col) {
    const g = cv.getContext("2d");
    g.clearRect(0, 0, cv.width, cv.height);
    if (h.length < 2) return;
    const mn = Math.min(...h), mx = Math.max(...h), span = mx - mn || 1;
    g.strokeStyle = col; g.lineWidth = 2.5; g.lineJoin = "round";
    g.beginPath();
    h.forEach((v, i) => {
      const x = (i / (h.length - 1)) * (cv.width - 6) + 3;
      const y = cv.height - 4 - ((v - mn) / span) * (cv.height - 8);
      i ? g.lineTo(x, y) : g.moveTo(x, y);
    });
    g.stroke();
    const lx = cv.width - 3, ly = cv.height - 4 - ((h[h.length - 1] - mn) / span) * (cv.height - 8);
    g.fillStyle = col; g.beginPath(); g.arc(lx, ly, 3.5, 0, 7); g.fill();
  },
};
