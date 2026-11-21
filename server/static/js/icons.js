// icons.js — icônes SVG du poste de commandement.
//  * UI : traits fins en currentColor (titres de section, boutons, calques).
//  * PICTO : pictogrammes de sécurité dans l'esprit ISO 7010 (sortie, poteau incendie,
//    extincteur, vanne gaz, dangers). Les mêmes dessins servent au HTML (sprite <symbol>)
//    et au canvas de la carte (images générées à partir du même SVG).
// Chargé juste après <body> : le sprite existe avant que le reste de la page ne s'affiche.
"use strict";

const Icons = (() => {
  const UI = {
    shield: '<path d="M12 3l7.5 3v5.2c0 4.7-3.1 8.4-7.5 9.8-4.4-1.4-7.5-5.1-7.5-9.8V6z"/><path d="M12 8.2v6.6M8.7 11.5h6.6"/>',
    drone: '<circle cx="6" cy="6" r="2.6"/><circle cx="18" cy="6" r="2.6"/><circle cx="6" cy="18" r="2.6"/><circle cx="18" cy="18" r="2.6"/><path d="M8 8l2.3 2.3M16 8l-2.3 2.3M8 16l2.3-2.3M16 16l-2.3-2.3"/><rect x="10" y="10" width="4" height="4" rx="1"/>',
    person: '<circle cx="12" cy="7" r="3.2"/><path d="M5.5 20.5c.6-4 3.2-6.3 6.5-6.3s5.9 2.3 6.5 6.3"/>',
    plan: '<path d="M4.5 19.5c3.2-1 4-5.2 7.3-6.2s4.4-5 7.7-7"/><circle cx="4.5" cy="19.5" r="1.7"/><path d="M16.2 4.3l3.3 2-2 3.3"/>',
    journal: '<path d="M6 3.5h12v17H6z"/><path d="M9 8h6M9 12h6M9 16h3.5"/>',
    fire: '<path d="M12 3c.5 3.1 4.6 4.6 4.6 9.3a4.6 4.6 0 0 1-9.2 0c0-2.3 1.2-3.6 2.3-4.6.2 1.7 1 2.5 1.9 2.7C10.8 7.8 11.4 5.1 12 3z"/>',
    smoke: '<path d="M3.5 9.5h7a2.6 2.6 0 1 0-2.6-2.6"/><path d="M3.5 13.5h13a3 3 0 1 0-3-3"/><path d="M5.5 17.5h8.5a2.5 2.5 0 1 1-2.5 2.5"/>',
    gas: '<rect x="4" y="4" width="16" height="16" rx="1"/><path d="M4 12l8-8M4 20L20 4M12 20l8-8"/>',
    route: '<path d="M4 18.5h5.5l5-13H20"/><path d="M17 2.5l3 3-3 3"/>',
    fog: '<path d="M3.5 8h17M3.5 12h17M3.5 16h17" stroke-dasharray="3 2.2"/>',
    arrow: '<path d="M4 12h15M14 7l5 5-5 5"/>',
    phone: '<path d="M7 3.5l3 3.4-1.8 2.4c1.1 2.3 3.2 4.4 5.5 5.5l2.4-1.8 3.4 3-1.6 3.2C11.5 19.5 4.5 12.5 3.8 6.1z"/>',
    check: '<path d="M4.5 12.5l4.5 4.5 10-10"/>',
    close: '<path d="M6 6l12 12M18 6L6 18"/>',
    alert: '<path d="M12 3.5l9 16H3z"/><path d="M12 9.5v4.5M12 16.6v.4"/>',
    thermo: '<path d="M10 4.2a2 2 0 0 1 4 0v9.6a4 4 0 1 1-4 0z"/><path d="M12 9v7.3"/>',
    co: '<circle cx="8" cy="12" r="3.6"/><circle cx="16.4" cy="12" r="3.6"/>',
    o2: '<path d="M12 4v7"/><path d="M12 9.5c-2.2 0-3.2 1.3-3.2 3.4v6c-3.2 0-4.3-2.2-4.3-5.2S5.6 8 7.8 8"/><path d="M12 9.5c2.2 0 3.2 1.3 3.2 3.4v6c3.2 0 4.3-2.2 4.3-5.2S18.4 8 16.2 8"/>',
    sensor: '<path d="M7.8 7.8a6 6 0 0 0 0 8.4M16.2 7.8a6 6 0 0 1 0 8.4"/><path d="M5 5a10 10 0 0 0 0 14M19 5a10 10 0 0 1 0 14"/><circle cx="12" cy="12" r="1.8"/>',
    skip: '<path d="M5 5l9 7-9 7z"/><path d="M18 5v14"/>',
    reset: '<path d="M5 12a7 7 0 1 0 2.1-5"/><path d="M5 4.5V9h4.5"/>',
    factory: '<path d="M3.5 20.5V10l5 3V10l5 3V5h4l.5 15.5z"/><path d="M3 20.5h18"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M5.3 18.7l1.6-1.6M17.1 6.9l1.6-1.6"/>',
    moon: '<path d="M19.5 14.6A7.8 7.8 0 0 1 9.4 4.5a7.8 7.8 0 1 0 10.1 10.1z"/>',
    sliders: '<path d="M5 4v16M12 4v16M19 4v16"/><path d="M3 8h4M10 15h4M17 10h4"/>',
    chevron: '<path d="M9 6l6 6-6 6"/>',
  };

  // Icônes Lucide (copie locale figée, static/vendor/lucide/) : elles remplacent les tracés
  // ci-dessus quand elles existent. Les noms restent ceux du dashboard (#i-<nom>).
  // "drone" n'existe pas chez Lucide : le tracé maison reste.
  const LUCIDE_NAME = {
    shield: "shield-plus", person: "user", plan: "clipboard-list", journal: "notebook-text",
    fire: "flame", smoke: "cloud-fog", gas: "flask-conical", route: "route", fog: "layers-2",
    arrow: "arrow-right", phone: "phone", check: "check", close: "x", alert: "triangle-alert",
    thermo: "thermometer", co: "skull", o2: "wind", sensor: "radio", skip: "skip-forward",
    reset: "rotate-ccw", factory: "factory", sun: "sun", moon: "moon", sliders: "sliders-horizontal",
    chevron: "chevron-right",
    // nouvelles icônes (vue 3D, comptes à rebours, équipes)
    box: "box", map: "map", timer: "timer", users: "users", enter: "log-in", leave: "log-out",
    scan: "scan-eye", bell: "bell", door: "door-open", zap: "zap", fuel: "fuel",
    locate: "locate-fixed", siren: "siren", pulse: "heart-pulse", waypoints: "waypoints",
  };
  const LU = window.LUCIDE || {};
  for (const [k, l] of Object.entries(LUCIDE_NAME)) if (LU[l]) UI[k] = LU[l];

  const TRIANGLE = '<path d="M12 2.4l10.6 18.6H1.4z" fill="#F2C12E" stroke="#16181b" stroke-width="1.4" stroke-linejoin="round"/>';
  const PICTO = {
    exit: '<rect width="24" height="24" rx="2.4" fill="#1E8F57"/>'
      + '<path d="M15.6 4.4h4v15.2h-4" fill="none" stroke="#fff" stroke-width="1.7" stroke-linejoin="round"/>'
      + '<circle cx="10.6" cy="4.9" r="1.7" fill="#fff"/>'
      + '<path d="M9.9 8.1l-1.7 5.1 3.1 2.3-.9 4.2M8.2 13.2l-2.6 2.7-2.7-.4M9.9 8.1l3 1.7 2.3-1.6M9.9 8.1L6.6 9.5 5.3 12"'
      + ' fill="none" stroke="#fff" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/>',
    hydrant: '<rect width="24" height="24" rx="2.4" fill="#C2312B"/>'
      + '<path fill="#fff" d="M10.2 5.6a1.8 1.8 0 0 1 3.6 0V7h-3.6zM8.6 7.6h6.8v1.6h.9v2.1h-.9v7.1h1.1V20H7.5v-1.6h1.1v-7.1h-.9V9.2h.9z"/>'
      + '<path fill="#fff" d="M15.4 12.4h2.4v2.2h-2.4zM6.2 12.4h2.4v2.2H6.2z"/>',
    extinguisher: '<rect width="24" height="24" rx="2.4" fill="#C2312B"/>'
      + '<rect x="9" y="8.6" width="6" height="11.6" rx="1.8" fill="#fff"/><rect x="10.8" y="6.1" width="2.4" height="2.8" fill="#fff"/>'
      + '<path d="M9.8 5.6h4.8M13 6.6c3.6 0 4.6 2.1 4.6 5.8" fill="none" stroke="#fff" stroke-width="1.5" stroke-linecap="round"/>',
    valve: '<circle cx="12" cy="12" r="11" fill="#F2C12E" stroke="#16181b" stroke-width="1"/>'
      + '<circle cx="12" cy="9.4" r="4" fill="none" stroke="#16181b" stroke-width="1.6"/>'
      + '<path d="M12 5.4v8M8 9.4h8M12 13.4v3.4M5.2 17.4h13.6" fill="none" stroke="#16181b" stroke-width="1.7"/>',
    electric: TRIANGLE + '<path d="M12.9 8.2l-3.4 6h2.7l-1.3 5.2 3.8-6.8h-2.7l1.7-4.4z" fill="#16181b"/>',
    solvent: TRIANGLE + '<path d="M12 8.6c.3 2 2.6 2.8 2.6 5.6a2.6 2.6 0 0 1-5.2 0c0-1.3.7-2.1 1.3-2.7.1 1 .6 1.5 1.1 1.7-.4-1.7-.1-3.3.2-4.6z" fill="#16181b"/><path d="M8.2 19h7.6" stroke="#16181b" stroke-width="1.2"/>',
    gas: TRIANGLE + '<rect x="10" y="9.6" width="4" height="9" rx="1.7" fill="#16181b"/><rect x="11.2" y="7.8" width="1.6" height="2.1" fill="#16181b"/>',
    metal: '<rect width="24" height="24" rx="3" fill="#323a45"/>'
      + '<circle cx="12" cy="12" r="6.2" fill="none" stroke="#c9ced6" stroke-width="2.8" stroke-dasharray="2.4 1.85"/>'
      + '<circle cx="12" cy="12" r="3.1" fill="none" stroke="#c9ced6" stroke-width="1.6"/>',
  };

  const NS = "http://www.w3.org/2000/svg";
  const sprite = document.createElementNS(NS, "svg");
  sprite.setAttribute("aria-hidden", "true");
  sprite.style.cssText = "position:absolute;width:0;height:0;overflow:hidden";
  let defs = "";
  for (const [k, v] of Object.entries(UI)) {
    defs += `<symbol id="i-${k}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${v}</symbol>`;
  }
  for (const [k, v] of Object.entries(PICTO)) defs += `<symbol id="p-${k}" viewBox="0 0 24 24">${v}</symbol>`;
  sprite.innerHTML = defs;
  document.body.prepend(sprite);

  // images pour le canvas (même dessin que le HTML)
  const images = {};
  const ready = Promise.all(Object.entries(PICTO).map(([k, v]) => new Promise((res) => {
    const img = new Image();
    img.onload = () => { images[k] = img; res(); };
    img.onerror = () => res();
    img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(
      `<svg xmlns="${NS}" viewBox="0 0 24 24" width="96" height="96">${v}</svg>`);
  })));

  // Pictogrammes de la carte : SIGN_ALIAS associe les noms de la consigne aux dessins.
  const SIGN_ALIAS = { machine: "metal", fire_hydrant: "hydrant", explosion: "gas", flammable: "solvent" };
  const signImg = (type) => images[SIGN_ALIAS[type] || type] || null;

  // Dessine un pictogramme centré en (x, y), côté `size` px. Renvoie false si l'image
  // n'est pas encore prête (attendre Icons.ready).
  function drawSign(ctx, type, x, y, size) {
    const img = signImg(type);
    if (!img) return false;
    ctx.drawImage(img, x - size / 2, y - size / 2, size, size);
    return true;
  }

  return {
    ready,
    img: (name) => signImg(name),
    ui: (name, cls = "") => `<svg class="ic ${cls}" aria-hidden="true"><use href="#i-${name}"></use></svg>`,
    picto: (name, cls = "") => `<svg class="pic ${cls}" aria-hidden="true"><use href="#p-${name}"></use></svg>`,
    icon: (name, cls = "") => `<svg class="ic ${cls}" aria-hidden="true"><use href="#i-${name}"></use></svg>`,
    drawSign,
    signs: Object.keys(PICTO).concat(Object.keys(SIGN_ALIAS)),
  };
})();
const icon = Icons.icon;
const drawSign = Icons.drawSign;

// Retire un pictogramme emoji en tête d'un texte venu du serveur (risques, mesures).
function stripEmoji(s) {
  return String(s).replace(/^[^\p{L}\p{N}]+/u, "");
}

const REDUCED_MOTION = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
