// theme.js — thème clair / sombre du poste de commandement.
// Chargé dans <head> : le thème est posé avant le premier affichage (pas de flash).
// Par défaut on suit le système (prefers-color-scheme) ; un choix explicite est
// mémorisé dans localStorage. Toutes les couleurs sont des propriétés CSS ;
// le canvas de la carte les relit via Theme.read() à chaque changement.
"use strict";

const Theme = (() => {
  const KEY = "hrika-theme";
  const root = document.documentElement;
  const mq = window.matchMedia ? window.matchMedia("(prefers-color-scheme: light)") : null;
  let chosen = null;
  try { const v = localStorage.getItem(KEY); if (v === "light" || v === "dark") chosen = v; } catch (e) { /* stockage indisponible */ }
  let mode = chosen || (mq && mq.matches ? "light" : "dark");
  root.dataset.theme = mode;
  const listeners = [];

  function set(m, remember) {
    mode = m;
    root.dataset.theme = m;
    if (remember) {
      chosen = m;
      try { localStorage.setItem(KEY, m); } catch (e) { /* stockage indisponible */ }
    }
    for (const fn of listeners) fn(m);
  }
  if (mq && mq.addEventListener) mq.addEventListener("change", (e) => { if (!chosen) set(e.matches ? "light" : "dark", false); });

  return {
    get mode() { return mode; },
    toggle() { set(mode === "light" ? "dark" : "light", true); },
    on(fn) { listeners.push(fn); },
    // lit des propriétés CSS (--nom) et renvoie { nom: valeur }
    read(names) {
      const cs = getComputedStyle(root);
      const o = {};
      for (const n of names) o[n] = cs.getPropertyValue("--" + n).trim();
      return o;
    },
  };
})();

// couleur CSS (#rgb, #rrggbb, rgb(), rgba()) avec une opacité donnée, pour le canvas
function withAlpha(color, a) {
  const c = String(color).trim();
  let m = c.match(/^#([0-9a-f]{3})$/i);
  if (m) { const h = m[1]; return `rgba(${parseInt(h[0] + h[0], 16)},${parseInt(h[1] + h[1], 16)},${parseInt(h[2] + h[2], 16)},${a})`; }
  m = c.match(/^#([0-9a-f]{6})/i);
  if (m) { const h = m[1]; return `rgba(${parseInt(h.slice(0, 2), 16)},${parseInt(h.slice(2, 4), 16)},${parseInt(h.slice(4, 6), 16)},${a})`; }
  m = c.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/i);
  if (m) return `rgba(${m[1]},${m[2]},${m[3]},${a})`;
  return c;
}
