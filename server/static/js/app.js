// app.js — démarrage : carte principale, loupe, panneau, interactions, boucle 60 images/s.
"use strict";

let MainMap = null;

(async function main() {
  await Live.start();
  const f = Live.factory;
  MainMap = new MapView(document.getElementById("map"), f);
  Loupe.init(f);
  Panel.init(f);
  Thermal.init();

  Live.on((s) => { Panel.onState(s); Loupe.onState(s); });

  // calques : tous toujours affichés (feu, fumée, gaz, flèches des plans, zones non vues)
  Live.on(() => { if (Loupe.zone) Loupe.dirty = true; });

  // survol + clic sur la carte
  const cv = document.getElementById("map");
  const tip = document.getElementById("tooltip");
  cv.addEventListener("mousemove", (ev) => {
    const r = cv.getBoundingClientRect();
    const [x, y] = MainMap.toCell(ev.clientX - r.left, ev.clientY - r.top);
    if (x < 0 || y < 0 || x >= MainMap.W || y >= MainMap.H) { MainMap.hover = null; tip.style.display = "none"; return; }
    MainMap.hover = [x, y];
    tip.innerHTML = describeCell(x, y);
    tip.style.display = "block";
    const tx = ev.clientX - r.left + 14, ty = ev.clientY - r.top + 14;
    tip.style.left = Math.min(tx, r.width - 270) + "px";
    tip.style.top = Math.min(ty, r.height - 120) + "px";
  });
  cv.addEventListener("mouseleave", () => { MainMap.hover = null; tip.style.display = "none"; });
  cv.addEventListener("click", (ev) => {
    const r = cv.getBoundingClientRect();
    const [x, y] = MainMap.toCell(ev.clientX - r.left, ev.clientY - r.top);
    const s = Live.s; if (!s) return;
    const ex = (f.exits || []).find(e => Math.abs(e.x - x) <= 1 && Math.abs(e.y - y) <= 1);
    if (ex && s.phase === "EN_ROUTE") { Panel.pickEntry(ex.id); return; }
    const z = MainMap.zoneAt(x, y);
    if (z) Loupe.open(z.id);
  });

  // thème clair / sombre (bouton soleil/lune, mémorisé)
  const themeBtn = document.getElementById("themeBtn");
  const syncTheme = () => {
    const light = Theme.mode === "light";
    themeBtn.setAttribute("aria-pressed", String(light));
    themeBtn.title = light ? "Thème sombre" : "Thème clair";
    themeBtn.setAttribute("aria-label", "Thème clair");
  };
  themeBtn.onclick = () => Theme.toggle();
  Theme.on(syncTheme); syncTheme();

  // panneau démo : caché par défaut, touche D ou petit bouton ; il s'ouvre dans la colonne de droite
  const demo = document.getElementById("demo");
  const demoBtn = document.getElementById("demoBtn");
  const toggleDemo = () => {
    demo.hidden = !demo.hidden;
    demoBtn.setAttribute("aria-expanded", String(!demo.hidden));
    if (!demo.hidden) demo.scrollIntoView({ block: "nearest" });
  };
  demoBtn.onclick = toggleDemo;
  document.addEventListener("keydown", (e) => {
    if (e.target.tagName === "INPUT") return;
    if (e.key === "d" || e.key === "D") toggleDemo();
    if (e.key === "Escape") Loupe.close();
  });
  demo.querySelectorAll("[data-demo]").forEach(b => b.onclick = async () => {
    const a = b.dataset.demo;
    if (a === "reset") Loupe.close();
    const out = await Live.post(a === "reset" ? "/api/reset" : "/api/demo/" + a);
    if (a === "reset" && out.ok) {
      Live.revealAt.clear(); Live.burnt.clear(); MainMap.drone = null; Loupe.view.drone = null;
      Live.refresh();
    }
  });
  demo.querySelectorAll("[data-speed]").forEach(b => b.onclick = () => Live.post("/api/demo/speed", { value: +b.dataset.speed }, { label: `Vitesse ×${b.dataset.speed}` }));

  // boucle de rendu
  let lastThermal = 0;
  function frame(now) {
    try {
      if (!(window.View3D && window.View3D.active)) MainMap.draw(now);   // la 3D a sa propre boucle
      Loupe.draw(now);
      Panel.frame(now);
      if (now - lastThermal > 70) { Thermal.draw(now); lastThermal = now; }
    } catch (e) { console.error(e); }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
})();

function describeCell(x, y) {
  const f = Live.factory, s = Live.s || {};
  const ch = (f.grid[y] || "")[x];
  const z = MainMap.zoneAt(x, y);
  const k = x + "," + y;
  const parts = [`<b>${z ? U.esc(z.id + " " + z.name) : "Hors zone"}</b>`];
  parts.push(`<span class="muted">${(MAT[ch] || {}).name || ""}, x ${x} y ${y}</span>`);
  const eq = (f.equipment || []).find(e => e.x === x && e.y === y);
  if (eq) parts.push(`${Icons.picto(eq.type)} ${U.esc(eq.label)}`);
  const ex = (f.exits || []).find(e => e.x === x && e.y === y);
  if (ex) parts.push(`${Icons.picto("exit")} ${U.esc(ex.id)}, ${U.esc(ex.name || "")}${s.phase === "EN_ROUTE" ? ". Cliquer pour y faire entrer le drone" : ""}`);
  const se = (s.sensors || []).find(e => e.x === x && e.y === y);
  if (se) parts.push(U.esc(`Capteur ${se.id} (${se.src === "real" ? "ESP32 réel" : "simulé"}) : ${({ NORMAL: "normal", WARNING: "pré-alerte", ALARM: "alarme" })[se.level] || se.level}, ${se.temp} °C, gaz ${se.gas}`));
  const known = !Live.fogOn() || Live.revealAt.has(k);
  if (Live.fogOn() && !known) parts.push(`<span class="muted">Pas encore vu par le drone</span>`);
  if (known) {
    if (Live.fireNow.has(k)) parts.push('<span class="warn">En feu</span>');
    else if (Live.burnt.has(k)) parts.push("Brûlé");
    if (Live.smokeNow.has(k)) parts.push("Fumée");
    if (Live.gasNow.has(k)) parts.push("Gaz");
  }
  const zs = z && s.zones && s.zones[z.id];
  if (zs && zs.level !== "NORMAL") parts.push(`<span class="warn">Zone ${zs.level === "DANGER" ? "en danger" : "en vigilance"}. Cliquer pour la vue détaillée</span>`);
  return parts.join("<br>");
}
