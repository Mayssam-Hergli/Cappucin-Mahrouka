// map3d.js — vue 3D du plan d'intervention (module ES, Three.js r160 en local).
//
// Construite à partir de /api/factory (1 cellule = 1 m) et animée à partir de Live.s,
// exactement les mêmes données que la carte 2D (map.js), qui reste la vue par défaut.
// La scène n'est créée qu'au premier passage en 3D, et la boucle de rendu ne tourne
// que lorsque la vue 3D est affichée.
//
// Performances : un InstancedMesh par type d'objet, particules de feu calculées dans le
// shader (<= 1400), 6 lumières de feu au maximum, aucune ombre portée.
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

const WALL_H = 3;
const FIRE_MAX = 1400;
const FIRE_LIGHTS = 6;
const SMOKE_MAX = 420;          // cellules de fumée par couche (3 couches)
const SIDE_VEC = { N: [0, -1], S: [0, 1], E: [1, 0], W: [-1, 0] };
const TOK = ["map-bg", "map-floor", "map-grid", "map-wall", "map-label", "map-label-2", "map-ink", "map-ink-2",
  "map-halo", "map-fog", "map-burnt", "map-smoke", "map-gas", "evac", "entry", "alarm", "alarm-fill", "amber",
  "attack", "on-accent", "mat-p-base", "mat-f-base", "mat-g-base", "mat-x-base"];
const UP = new THREE.Vector3(0, 1, 0);
const CARTON = new THREE.Color(0xa88a62), CARTON_FIRE = new THREE.Color(0xd8501e), CARTON_BURNT = new THREE.Color(0x221b17);
const FONT = 'system-ui, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';

// ------------------------------------------------------------------ outils
function col(c) {
  const s = String(c || "#888888").trim();
  const m = s.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/i);
  if (m) return new THREE.Color().setRGB(m[1] / 255, m[2] / 255, m[3] / 255, THREE.SRGBColorSpace);
  return new THREE.Color().setStyle(s);
}
function hash(x, y, k = 0) {
  const h = Math.sin(x * 127.1 + y * 311.7 + k * 74.7) * 43758.5453;
  return h - Math.floor(h);
}
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const G = () => (typeof Live !== "undefined" ? Live : window.Live);
const mapLayers = () => (typeof MainMap !== "undefined" && MainMap && MainMap.layers) ||
  { fire: true, smoke: true, gas: true, paths: true, fog: true };

function canvasTex(cv) {
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}
// texture ronde et douce (fumée, gaz, halo du feu)
function softTex() {
  const cv = document.createElement("canvas"); cv.width = cv.height = 64;
  const g = cv.getContext("2d");
  const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  gr.addColorStop(0, "rgba(255,255,255,1)"); gr.addColorStop(0.45, "rgba(255,255,255,.55)"); gr.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
  return canvasTex(cv);
}
// chevrons blancs qui défilent sur les rubans de plans
function chevronTex() {
  const cv = document.createElement("canvas"); cv.width = 64; cv.height = 32;
  const g = cv.getContext("2d");
  g.strokeStyle = "#fff"; g.lineWidth = 6; g.lineCap = "round"; g.lineJoin = "round";
  g.beginPath(); g.moveTo(22, 7); g.lineTo(38, 16); g.lineTo(22, 25); g.stroke();
  const t = canvasTex(cv);
  t.wrapS = THREE.RepeatWrapping; t.wrapT = THREE.ClampToEdgeWrapping;
  return t;
}
// étiquette (sprite) : fond plein, texte en capitales, toujours lisible (pas de test de profondeur)
function label(text, bg, fg, h = 0.55, border) {
  const cv = document.createElement("canvas");
  const g = cv.getContext("2d");
  const fs = 44, pad = 16;
  g.font = `700 ${fs}px ${FONT}`;
  const w = Math.ceil(g.measureText(text).width) + pad * 2;
  cv.width = w; cv.height = fs + pad * 1.2;
  g.font = `700 ${fs}px ${FONT}`;
  g.fillStyle = bg; g.beginPath();
  if (g.roundRect) g.roundRect(0, 0, cv.width, cv.height, 6); else g.rect(0, 0, cv.width, cv.height);
  g.fill();
  if (border) { g.strokeStyle = border; g.lineWidth = 4; g.stroke(); }
  g.fillStyle = fg; g.textAlign = "center"; g.textBaseline = "middle";
  g.fillText(text, cv.width / 2, cv.height / 2 + 2);
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: canvasTex(cv), depthTest: false, transparent: true }));
  sp.scale.set(h * cv.width / cv.height, h, 1);
  sp.renderOrder = 20;
  return sp;
}

// ------------------------------------------------------------------ vue 3D
class View3DImpl {
  constructor(host, factory) {
    this.host = host;
    this.f = factory;
    this.W = factory.grid[0].length;
    this.H = factory.grid.length;
    this.active = false;
    this.clock = new THREE.Clock();
    this.lastPhase = null;
    this.keys = {};             // signatures des données déjà construites
    this.victims = new Map();
    this.drone = null;          // position lissée
    this.droneHeading = 0;
    this.fly = null;

    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    host.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(38, 1, 0.3, 400);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.maxPolarAngle = Math.PI * 0.46;
    this.controls.minDistance = 5;
    this.controls.maxDistance = 90;
    this.controls.zoomToCursor = true;          // la molette zoome vers le point visé
    this.controls.zoomSpeed = 1.2;
    this.controls.rotateSpeed = 0.7;
    this.wallH = WALL_H;        // hauteur affichée des murs (murs bas = vue en coupe)
    this.wallTarget = WALL_H;
    this.follow = false;        // la caméra suit le drone
    this.ghostMin = 3;          // flammes fantômes : prévision à +N min (0 = masquées)
    this.controls.addEventListener("start", () => { this.fly = null; });
    this.overview(true);

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x30343a, 1.15));
    const sun = new THREE.DirectionalLight(0xffffff, 1.1);
    sun.position.set(-12, 30, 16);
    this.scene.add(sun);
    this.fireLights = [];
    for (let i = 0; i < FIRE_LIGHTS; i++) {
      const l = new THREE.PointLight(0xff7a2a, 0, 10, 1.4);
      this.scene.add(l); this.fireLights.push(l);
    }

    this.soft = softTex();
    this.chev = chevronTex();
    this._pointer();
    new ResizeObserver(() => this.resize()).observe(host);
    Theme.on(() => { if (this.world) this.build(); });
  }

  wx(x) { return x + 0.5 - this.W / 2; }
  wz(y) { return y + 0.5 - this.H / 2; }
  cell(x, y) { return (this.f.grid[y] || "")[x] || "#"; }

  // -------------------------------------------------------------- construction
  async build() {
    await Icons.ready;
    if (this.world) { this.scene.remove(this.world); this._dispose(this.world); }
    this.keys = {}; this.victims.clear();
    this.T = Theme.read(TOK);
    const T = this.T, W = this.W, H = this.H;
    this.scene.background = col(T["map-bg"]);
    const world = this.world = new THREE.Group();
    this.scene.add(world);

    // sol : texture dessinée (grille 1 m, emprises des stocks, noms des zones)
    const px = 48, cv = document.createElement("canvas");
    cv.width = W * px; cv.height = H * px;
    const g = cv.getContext("2d");
    g.fillStyle = T["map-floor"]; g.fillRect(0, 0, cv.width, cv.height);
    const matBase = { P: "mat-p-base", F: "mat-f-base", G: "mat-g-base", X: "mat-x-base" };
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const c = this.cell(x, y);
      if (matBase[c]) { g.fillStyle = T[matBase[c]]; g.fillRect(x * px, y * px, px, px); }
    }
    g.strokeStyle = T["map-grid"]; g.lineWidth = 2;
    for (let x = 0; x <= W; x++) { g.beginPath(); g.moveTo(x * px, 0); g.lineTo(x * px, cv.height); g.stroke(); }
    for (let y = 0; y <= H; y++) { g.beginPath(); g.moveTo(0, y * px); g.lineTo(cv.width, y * px); g.stroke(); }
    g.textBaseline = "top";
    for (const z of this.f.zones || []) {
      const [x0, y0] = z.rect;
      g.fillStyle = T["map-label"]; g.font = `700 ${px * 0.62}px ${FONT}`;
      g.fillText(`${z.id}  ${(z.label_fr || z.name || "").toUpperCase()}`, (x0 + 0.35) * px, (y0 + 0.3) * px);
    }
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(W, H), new THREE.MeshBasicMaterial({ map: canvasTex(cv) }));
    floor.rotation.x = -Math.PI / 2;
    world.add(floor);
    this.floorPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

    // murs, linteaux des portes intérieures, chapeaux clairs (lecture nette vue de dessus)
    const walls = [], lintels = [], exits = [];
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const c = this.cell(x, y);
      if (c === "#") walls.push([x, y]);
      else if (c === "D") lintels.push([x, y]);
      else if (c === "E") exits.push([x, y]);
    }
    const light = Theme.mode === "light";
    const ink = col(T["map-wall"]);
    const wallCol = light ? ink.clone().lerp(col(T["map-floor"]), 0.55) : ink;
    const wallMat = new THREE.MeshStandardMaterial({ color: wallCol, roughness: 0.92, metalness: 0 });
    const capMat = new THREE.MeshBasicMaterial({ color: light ? ink : ink.clone().lerp(new THREE.Color(1, 1, 1), 0.22) });
    const m4 = new THREE.Matrix4();
    const inst = (geo, mat, cells, fn) => {
      const mesh = new THREE.InstancedMesh(geo, mat, Math.max(1, cells.length));
      mesh.count = cells.length;
      cells.forEach((c, i) => { fn(m4, c, i); mesh.setMatrixAt(i, m4); });
      mesh.instanceMatrix.needsUpdate = true;
      world.add(mesh);
      return mesh;
    };
    this.wallCells = walls;
    this.wallMesh = inst(new THREE.BoxGeometry(1, 1, 1), wallMat, walls, () => {});
    this.capMesh = inst(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), capMat, walls, () => {});
    this.lintelMesh = inst(new THREE.BoxGeometry(1, 0.7, 1), wallMat, lintels, (m, [x, y]) => m.makeTranslation(this.wx(x), WALL_H - 0.35, this.wz(y)));
    this._applyWalls(this.wallH);

    // stocks
    const P = [], F = [], Gc = [], X = [];
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const c = this.cell(x, y);
      if (c === "P") P.push([x, y]); else if (c === "F") F.push([x, y]); else if (c === "G") Gc.push([x, y]); else if (c === "X") X.push([x, y]);
    }
    const wood = new THREE.MeshStandardMaterial({ color: 0x7a5f3e, roughness: 1 });
    const carton = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95 });
    inst(new THREE.BoxGeometry(0.92, 0.12, 0.92), wood, P, (m, [x, y]) => m.makeTranslation(this.wx(x), 0.06, this.wz(y)));
    this.cartons = inst(new THREE.BoxGeometry(0.84, 1, 0.84), carton, P, (m, [x, y]) => {
      const h = 0.8 + hash(x, y) * 0.9;
      m.compose(new THREE.Vector3(this.wx(x), 0.12 + h / 2, this.wz(y)), new THREE.Quaternion(), new THREE.Vector3(1, h, 1));
    });
    this.cartonCells = P;
    P.forEach((c, i) => this.cartons.setColorAt(i, CARTON));
    this.cartons.instanceColor.needsUpdate = true;
    // hauteur du dessus des stocks : les flammes partent de là
    this.stockTop = (x, y) => {
      const c = this.cell(x, y);
      if (c === "P") return (G().burnt.has(x + "," + y) && !G().fireNow.has(x + "," + y)) ? 0.3 : 0.12 + 0.8 + hash(x, y) * 0.9;
      return c === "F" ? 0.88 : c === "G" ? 1.3 : c === "X" ? 1.9 : 0;
    };
    const quad = [[-0.22, -0.22], [0.22, -0.22], [-0.22, 0.22], [0.22, 0.22]];
    const by4 = (cells) => cells.flatMap(([x, y]) => quad.map(([dx, dz]) => [x, y, dx, dz]));
    const drum = new THREE.MeshStandardMaterial({ color: 0x5a4a7c, roughness: 0.55, metalness: 0.35 });
    inst(new THREE.CylinderGeometry(0.19, 0.19, 0.86, 16), drum, by4(F), (m, [x, y, dx, dz]) => m.makeTranslation(this.wx(x) + dx, 0.43, this.wz(y) + dz));
    const bottle = new THREE.MeshStandardMaterial({ color: 0x8f9a3c, roughness: 0.5, metalness: 0.3 });
    const valveCap = new THREE.MeshStandardMaterial({ color: 0x4a4f57, roughness: 0.6, metalness: 0.5 });
    inst(new THREE.CylinderGeometry(0.1, 0.1, 1.25, 12), bottle, by4(Gc), (m, [x, y, dx, dz]) => m.makeTranslation(this.wx(x) + dx, 0.625, this.wz(y) + dz));
    inst(new THREE.CylinderGeometry(0.045, 0.07, 0.16, 8), valveCap, by4(Gc), (m, [x, y, dx, dz]) => m.makeTranslation(this.wx(x) + dx, 1.33, this.wz(y) + dz));
    const cabinet = new THREE.MeshStandardMaterial({ color: 0x3e4c5e, roughness: 0.6, metalness: 0.4 });
    inst(new THREE.BoxGeometry(0.86, 1.9, 0.55), cabinet, X, (m, [x, y]) => m.makeTranslation(this.wx(x), 0.95, this.wz(y)));

    // équipements + panneaux ISO flottants (sprites)
    const machine = new THREE.MeshStandardMaterial({ color: 0x6b7480, roughness: 0.55, metalness: 0.5 });
    const red = new THREE.MeshStandardMaterial({ color: 0xc2312b, roughness: 0.5 });
    const yellow = new THREE.MeshStandardMaterial({ color: 0xd9ad2b, roughness: 0.5, metalness: 0.2 });
    const signs = [];
    const addSign = (type, x, y, h = 2.45) => {
      const img = Icons.img(type);
      if (!img) return;
      const tex = new THREE.Texture(img); tex.colorSpace = THREE.SRGBColorSpace; tex.needsUpdate = true;
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true }));
      sp.position.set(this.wx(x), h, this.wz(y)); sp.scale.set(0.72, 0.72, 1);
      world.add(sp); signs.push(sp);
    };
    for (const e of this.f.equipment || []) {
      const x = this.wx(e.x), z = this.wz(e.y), c = this.cell(e.x, e.y);
      let mesh = null;
      if (e.type === "metal") {
        mesh = new THREE.Group();
        const b = new THREE.Mesh(new THREE.BoxGeometry(1.5, 1.0, 1.1), machine); b.position.y = 0.5;
        const t = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.7, 0.7), machine); t.position.set(0.25, 1.35, 0);
        mesh.add(b, t);
      } else if (e.type === "electric" && c !== "X") {
        mesh = new THREE.Mesh(new THREE.BoxGeometry(0.8, 1.8, 0.45), cabinet); mesh.position.y = 0.9;
      } else if (e.type === "solvent" && c !== "F") {
        mesh = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 0.9, 16), drum); mesh.position.y = 0.45;
      } else if (e.type === "gas" || e.type === "valve") {
        mesh = new THREE.Group();
        const p = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 1.1, 8), yellow); p.position.y = 0.55;
        const w = new THREE.Mesh(new THREE.TorusGeometry(0.16, 0.035, 8, 20), red); w.position.y = 1.1; w.rotation.x = Math.PI / 2;
        mesh.add(p, w);
      } else if (e.type === "extinguisher") {
        mesh = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.13, 0.6, 12), red); mesh.position.y = 0.3;
      }
      if (mesh) { mesh.position.x += x; mesh.position.z += z; world.add(mesh); }
      addSign(e.type === "metal" ? "machine" : e.type, e.x, e.y, e.type === "metal" ? 2.4 : 2.25);
    }
    for (const h of this.f.hydrants || []) {
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.16, 0.8, 12), red);
      post.position.set(this.wx(h.x), 0.4, this.wz(h.y)); world.add(post);
      addSign("hydrant", h.x, h.y, 1.5);
    }
    for (const v of this.f.gas_valves || []) addSign("valve", v.x, v.y, 1.9);

    // sorties : cadre vert lumineux, halo au sol, panneau ISO et numéro E1/E2/E3
    const evac = col(T["evac"]);
    const frameMat = new THREE.MeshBasicMaterial({ color: evac });
    const glowMat = new THREE.MeshBasicMaterial({ color: evac, map: this.soft, transparent: true, opacity: 0.55, depthWrite: false, blending: THREE.AdditiveBlending });
    const exitList = (this.f.exits && this.f.exits.length) ? this.f.exits
      : exits.map(([x, y], i) => ({ id: "E" + (i + 1), x, y }));
    this.exits = exitList;
    for (const e of exitList) {
      const side = e.side || (e.x === 0 ? "W" : e.x === W - 1 ? "E" : e.y === 0 ? "N" : "S");
      const alongZ = side === "W" || side === "E";
      const grp = new THREE.Group();
      grp.position.set(this.wx(e.x), 0, this.wz(e.y));
      const post = new THREE.BoxGeometry(0.1, 2.3, 0.1);
      for (const s of [-0.45, 0.45]) {
        const m = new THREE.Mesh(post, frameMat);
        m.position.set(alongZ ? 0 : s, 1.15, alongZ ? s : 0); grp.add(m);
      }
      const top = new THREE.Mesh(new THREE.BoxGeometry(alongZ ? 0.1 : 1, 0.1, alongZ ? 1 : 0.1), frameMat);
      top.position.y = 2.3; grp.add(top);
      const glow = new THREE.Mesh(new THREE.PlaneGeometry(2.6, 2.6).rotateX(-Math.PI / 2), glowMat);
      glow.position.y = 0.02; grp.add(glow);
      const lab = label(e.id, T["evac"], "#ffffff", 0.6);
      lab.position.set(0, 3.7, 0); grp.add(lab);
      world.add(grp);
      addSign("exit", e.x, e.y, 3.0);
    }

    // couches dynamiques
    this._buildDynamic(world);
    this.resize();
    if (!this.built) { this.overview(true); this.built = true; }
  }

  _buildDynamic(world) {
    const T = this.T, W = this.W, H = this.H;
    const flat = () => new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    const mkInst = (geo, mat, n) => {
      const m = new THREE.InstancedMesh(geo, mat, n);
      m.count = 0; m.frustumCulled = false; m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      world.add(m); return m;
    };

    // brûlé, halo du feu au sol
    this.burntMesh = mkInst(flat(), new THREE.MeshBasicMaterial({ color: col(T["map-burnt"]), transparent: true, opacity: 0.85, depthWrite: false }), W * H);
    this.emberMesh = mkInst(flat(), new THREE.MeshBasicMaterial({ color: 0xc8361a, transparent: true, opacity: 0.85, depthWrite: false }), W * H);
    this.glowMesh = mkInst(flat(), new THREE.MeshBasicMaterial({ color: 0xff7a1a, map: this.soft, transparent: true, opacity: 0.32, depthWrite: false }), W * H);

    // feu : particules calculées dans le shader
    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(FIRE_MAX * 3), seed = new Float32Array(FIRE_MAX);
    for (let i = 0; i < FIRE_MAX; i++) seed[i] = Math.random();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute("aSeed", new THREE.BufferAttribute(seed, 1));
    geo.setDrawRange(0, 0);
    this.fireMat = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uScale: { value: 300 } },
      vertexShader: `
        attribute float aSeed; uniform float uTime; uniform float uScale; varying float vLife;
        void main() {
          float life = fract(uTime * (0.55 + 0.4 * fract(aSeed * 7.13)) + aSeed);
          vec3 p = position;
          float a = aSeed * 43.0, r = 0.4 * fract(aSeed * 91.7);
          p.x += cos(a) * r * (1.0 - life * 0.6) + sin(uTime * 3.0 + aSeed * 20.0) * 0.06 * life;
          p.z += sin(a) * r * (1.0 - life * 0.6) + cos(uTime * 2.6 + aSeed * 17.0) * 0.06 * life;
          p.y = position.y + 0.05 + life * (1.0 + 1.1 * fract(aSeed * 13.1));
          vLife = life;
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          gl_PointSize = uScale * (1.0 - life * 0.65) * (0.7 + 0.6 * fract(aSeed * 5.3)) / -mv.z;
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        varying float vLife;
        void main() {
          float r = length(gl_PointCoord - 0.5); if (r > 0.5) discard;
          float soft = smoothstep(0.5, 0.0, r);
          vec3 hot = vec3(1.0, 0.93, 0.6), mid = vec3(1.0, 0.52, 0.1), cool = vec3(0.7, 0.1, 0.03);
          vec3 c = vLife < 0.35 ? mix(hot, mid, vLife / 0.35) : mix(mid, cool, (vLife - 0.35) / 0.65);
          float a = soft * (1.0 - vLife) * 0.85;
          gl_FragColor = vec4(c * a, a);
        }`,
      transparent: true, depthWrite: false,
      // couleur prémultipliée : lumineux sur fond sombre, toujours visible sur fond clair
      blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
    });
    this.firePts = new THREE.Points(geo, this.fireMat);
    this.firePts.frustumCulled = false;
    world.add(this.firePts);

    // fumée : 3 couches de plus en plus denses vers le plafond ; gaz : nappe basse
    const smokeCol = col(T["map-smoke"]).multiplyScalar(Theme.mode === "light" ? 0.55 : 0.6);
    this.smokeLayers = [[1.7, 0.16], [2.3, 0.26], [2.85, 0.38]].map(([h, op]) => {
      const m = mkInst(flat(), new THREE.MeshBasicMaterial({ color: smokeCol, map: this.soft, transparent: true, opacity: op, depthWrite: false }), SMOKE_MAX);
      m.userData.h = h; m.renderOrder = 5; return m;
    });
    this.gasMesh = mkInst(flat(), new THREE.MeshBasicMaterial({ color: col(T["map-gas"]), map: this.soft, transparent: true, opacity: 0.28, depthWrite: false }), W * H);

    // brouillard : plafond sombre sur les cellules pas encore vues par le drone
    this.fogCells = [];
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (this.cell(x, y) !== "#") this.fogCells.push([x, y]);
    const hc = document.createElement("canvas"); hc.width = hc.height = 32;
    const hg = hc.getContext("2d");
    hg.fillStyle = T["map-fog"]; hg.fillRect(0, 0, 32, 32);
    hg.strokeStyle = Theme.mode === "light" ? "rgba(0,0,0,.18)" : "rgba(160,175,195,.22)"; hg.lineWidth = 3;
    for (const o of [-32, 0, 32]) { hg.beginPath(); hg.moveTo(o, 32); hg.lineTo(o + 32, 0); hg.stroke(); }
    this.fogMesh = mkInst(flat(), new THREE.MeshBasicMaterial({ map: canvasTex(hc), transparent: true, opacity: 0.72, depthWrite: false }), this.fogCells.length);
    this.fogMesh.renderOrder = 6;

    // cadres des zones en alerte, posés sur le haut des murs
    this.zoneFrames = {};
    for (const z of this.f.zones || []) {
      const [x0, y0, x1, y1] = z.rect;
      const grp = new THREE.Group();
      const mat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, depthTest: false });
      const w = x1 - x0 + 1, h = y1 - y0 + 1, cx = (x0 + x1 + 1) / 2 - W / 2, cz = (y0 + y1 + 1) / 2 - H / 2, t = 0.14;
      for (const [sx, sz, px, pz] of [[w, t, 0, -h / 2], [w, t, 0, h / 2], [t, h, -w / 2, 0], [t, h, w / 2, 0]]) {
        const m = new THREE.Mesh(new THREE.BoxGeometry(sx, 0.05, sz), mat);
        m.position.set(cx + px, WALL_H + 0.06, cz + pz); m.renderOrder = 8; grp.add(m);
      }
      grp.visible = false; grp.userData.mat = mat;
      world.add(grp); this.zoneFrames[z.id] = grp;
    }

    // capteurs fixes
    this.sensorMeshes = new Map();

    // prévision : flammes fantômes là où le feu arrivera dans les N prochaines minutes
    this.ghostMesh = mkInst(new THREE.ConeGeometry(0.3, 1, 10).translate(0, 0.5, 0),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.32, depthWrite: false }), W * H);
    this.ghostTile = mkInst(flat(), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.22, depthWrite: false }), W * H);
    this.ghostMesh.renderOrder = 4;

    // plans et trajectoire
    this.planGroup = new THREE.Group(); world.add(this.planGroup);
    this.trailGroup = new THREE.Group(); world.add(this.trailGroup);
    this.victimGroup = new THREE.Group(); world.add(this.victimGroup);

    // drone
    const ink = col(T["map-ink"]);
    this.droneRoot = new THREE.Group();
    const body = this.droneBody = new THREE.Group();
    this.droneMat = new THREE.MeshStandardMaterial({ color: ink, roughness: 0.4, metalness: 0.3, emissive: 0x000000 });
    body.add(new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.1, 0.32), this.droneMat));
    for (const r of [Math.PI / 4, -Math.PI / 4]) {
      const arm = new THREE.Mesh(new THREE.BoxGeometry(0.92, 0.035, 0.06), this.droneMat); arm.rotation.y = r; body.add(arm);
    }
    this.rotors = [];
    const rotorMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.35, depthWrite: false });
    for (const [x, z] of [[0.33, 0.33], [-0.33, 0.33], [0.33, -0.33], [-0.33, -0.33]]) {
      const r = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.17, 0.012, 20), rotorMat);
      const blade = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.014, 0.035), this.droneMat);
      const hub = new THREE.Group(); hub.position.set(x, 0.07, z); hub.add(r, blade);
      body.add(hub); this.rotors.push(hub);
    }
    const nose = new THREE.Mesh(new THREE.SphereGeometry(0.05, 10, 8), new THREE.MeshBasicMaterial({ color: col(T["entry"]) }));
    nose.position.set(0.2, 0, 0); body.add(nose);
    body.scale.setScalar(1.5);
    body.position.y = 1.5;
    const coneH = 1.45;
    const cone = new THREE.Mesh(new THREE.ConeGeometry(3, coneH, 40, 1, true),
      new THREE.MeshBasicMaterial({ color: col(T["entry"]), transparent: true, opacity: 0.07, depthWrite: false, side: THREE.DoubleSide }));
    cone.position.y = coneH / 2 + 0.02;
    const ring = new THREE.Mesh(new THREE.RingGeometry(2.95, 3.05, 64).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: col(T["entry"]), transparent: true, opacity: 0.45, depthWrite: false }));
    ring.position.y = 0.03;
    this.droneRoot.add(body, cone, ring);
    this.droneRoot.visible = false;
    world.add(this.droneRoot);
  }

  _dispose(obj) {
    obj.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      const mats = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
      for (const m of mats) {
        if (m.map && m.map !== this.soft && m.map !== this.chev) m.map.dispose();
        m.dispose();
      }
    });
  }

  // -------------------------------------------------------------- ruban au sol (plans, trajectoire)
  _ribbon(cells, width, y, mat) {
    const pts = [];
    for (const [x, z] of cells) {
      const v = new THREE.Vector3(this.wx(x), y, this.wz(z));
      if (!pts.length || pts[pts.length - 1].distanceTo(v) > 1e-3) pts.push(v);
    }
    if (pts.length < 2) return null;
    const curve = new THREE.CatmullRomCurve3(pts, false, "centripetal");
    const n = Math.max(8, pts.length * 6);
    const sp = curve.getSpacedPoints(n);
    const pos = [], uv = [], idx = [];
    let L = 0;
    for (let i = 0; i <= n; i++) {
      const p = sp[i], a = sp[Math.max(0, i - 1)], b = sp[Math.min(n, i + 1)];
      let tx = b.x - a.x, tz = b.z - a.z;
      const l = Math.hypot(tx, tz) || 1; tx /= l; tz /= l;
      const nx = -tz * width / 2, nz = tx * width / 2;
      if (i > 0) L += p.distanceTo(sp[i - 1]);
      pos.push(p.x + nx, y, p.z + nz, p.x - nx, y, p.z - nz);
      uv.push(L / 1.1, 0, L / 1.1, 1);
      if (i < n) { const k = i * 2; idx.push(k, k + 1, k + 2, k + 1, k + 3, k + 2); }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
    geo.setIndex(idx);
    const m = new THREE.Mesh(geo, mat);
    m.frustumCulled = false;
    return m;
  }

  _clear(group) {
    for (const c of [...group.children]) { group.remove(c); this._dispose(c); }
  }

  // -------------------------------------------------------------- synchronisation avec Live.s
  _sync(s, now, t, dt) {
    const T = this.T, L = mapLayers(), Lv = G();
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), v3 = new THREE.Vector3(), sc = new THREE.Vector3();
    const key = (k, v) => { const j = JSON.stringify(v); if (this.keys[k] === j) return false; this.keys[k] = j; return true; };
    const cellsOf = (set) => [...set].map((k) => k.split(",").map(Number));

    // phase : plongée vers la zone en alarme au passage en ALERT
    if (this.lastPhase !== null && s.phase !== this.lastPhase && s.phase === "ALERT") {
      const z = s.alarm && (this.f.zones || []).find((zz) => zz.id === s.alarm.zone);
      if (z) this.flyToZone(z.id, 2000, 15);
    }
    this.lastPhase = s.phase;

    // brûlé + halo + particules + lumières
    const fire = cellsOf(Lv.fireNow);
    if (key("burnt", [...Lv.burnt].length + ":" + fire.length)) {
      const burnt = cellsOf(Lv.burnt);
      this.burntMesh.count = burnt.length;
      burnt.forEach(([x, y], i) => { m4.makeTranslation(this.wx(x), 0.012, this.wz(y)); this.burntMesh.setMatrixAt(i, m4); });
      this.burntMesh.instanceMatrix.needsUpdate = true;
    }
    if (key("fire", [[...Lv.fireNow].sort(), Lv.burnt.size])) {
      const n = fire.length;
      const budget = Math.floor(FIRE_MAX * (this.fireBudget || 1));
      const per = n ? Math.max(3, Math.min(28, Math.floor(budget / n))) : 0;
      const total = Math.min(budget, n * per);
      const pos = this.firePts.geometry.attributes.position;
      for (let i = 0; i < total; i++) {
        const [x, y] = fire[i % n];
        pos.setXYZ(i, this.wx(x), this.stockTop(x, y), this.wz(y));
      }
      pos.needsUpdate = true;
      this.firePts.geometry.setDrawRange(0, total);
      // lumières : les 6 plus gros foyers (blocs de 6 x 6 m)
      const blocks = new Map();
      for (const [x, y] of fire) {
        const k = Math.floor(x / 6) + "," + Math.floor(y / 6);
        const b = blocks.get(k) || { n: 0, x: 0, y: 0 }; b.n++; b.x += x; b.y += y; blocks.set(k, b);
      }
      this.fireFoci = [...blocks.values()].sort((a, b) => b.n - a.n).slice(0, FIRE_LIGHTS)
        .map((b) => ({ x: this.wx(b.x / b.n), z: this.wz(b.y / b.n), n: b.n }));
      // cartons : en feu = rouge-orange, brûlés = affaissés et noirs
      const m = new THREE.Matrix4(), qq = new THREE.Quaternion(), vv = new THREE.Vector3(), ss = new THREE.Vector3();
      this.cartonCells.forEach(([x, y], i) => {
        const k = x + "," + y, onFire = Lv.fireNow.has(k), burnt = Lv.burnt.has(k) && !onFire;
        const h = burnt ? 0.18 : 0.8 + hash(x, y) * 0.9;
        m.compose(vv.set(this.wx(x), 0.12 + h / 2, this.wz(y)), qq, ss.set(burnt ? 0.9 : 1, h, burnt ? 0.9 : 1));
        this.cartons.setMatrixAt(i, m);
        this.cartons.setColorAt(i, onFire ? CARTON_FIRE : burnt ? CARTON_BURNT : CARTON);
      });
      this.cartons.instanceMatrix.needsUpdate = true;
      this.cartons.instanceColor.needsUpdate = true;
    }
    const fireOn = L.fire && fire.length > 0;
    this.firePts.visible = fireOn;
    this.glowMesh.visible = fireOn;
    this.emberMesh.visible = fireOn;
    if (fireOn) {
      this.emberMesh.count = fire.length;
      fire.forEach(([x, y], i) => { m4.makeTranslation(this.wx(x), 0.022, this.wz(y)); this.emberMesh.setMatrixAt(i, m4); });
      this.emberMesh.instanceMatrix.needsUpdate = true;
      this.glowMesh.count = fire.length;
      fire.forEach(([x, y], i) => {
        const f = 1.9 + 0.35 * Math.sin(t * 7 + x * 1.7 + y * 2.3);
        m4.compose(v3.set(this.wx(x), 0.026, this.wz(y)), q.identity(), sc.set(f, 1, f));
        this.glowMesh.setMatrixAt(i, m4);
      });
      this.glowMesh.instanceMatrix.needsUpdate = true;
    }
    this.fireMat.uniforms.uTime.value = t;
    this.fireLights.forEach((l, i) => {
      const f = fireOn && this.fireFoci && this.fireFoci[i];
      if (!f) { l.intensity = 0; return; }
      l.position.set(f.x, 1.3, f.z);
      l.intensity = (6 + Math.min(14, f.n * 0.6)) * (0.8 + 0.2 * Math.sin(t * 13 + i * 2.1) + 0.1 * Math.sin(t * 29 + i));
    });

    // fumée (dérive selon le vent) et gaz
    const smoke = cellsOf(Lv.smokeNow).slice(0, SMOKE_MAX);
    const wind = s.wind || { deg: 90, kmh: 10 };
    const wr = (wind.deg || 0) * Math.PI / 180, wv = Math.min(1, (wind.kmh || 0) / 25);
    const wxv = Math.sin(wr), wzv = -Math.cos(wr);
    this.smokeLayers.forEach((m, li) => {
      m.visible = L.smoke && smoke.length > 0;
      if (!m.visible) return;
      m.count = smoke.length;
      smoke.forEach(([x, y], i) => {
        const h = hash(x, y, li);
        const ph = (t * (0.08 + 0.05 * li) * (0.4 + wv) + h) % 1;
        const drift = (ph - 0.5) * 1.4 * (0.3 + wv);
        const s2 = 1.7 + 0.35 * Math.sin(t * 0.6 + h * 6.28) + li * 0.2;
        m4.compose(v3.set(this.wx(x) + wxv * drift, m.userData.h + 0.12 * Math.sin(t * 0.5 + h * 9), this.wz(y) + wzv * drift),
          q.setFromAxisAngle(UP, h * 6.28 + t * 0.05), sc.set(s2, 1, s2));
        m.setMatrixAt(i, m4);
      });
      m.instanceMatrix.needsUpdate = true;
    });
    const gas = cellsOf(Lv.gasNow);
    this.gasMesh.visible = L.gas && gas.length > 0;
    if (this.gasMesh.visible) {
      this.gasMesh.count = gas.length;
      gas.forEach(([x, y], i) => {
        const s2 = 1.6 + 0.25 * Math.sin(t * 1.3 + x + y);
        m4.compose(v3.set(this.wx(x), 0.35 + 0.05 * Math.sin(t + x), this.wz(y)), q.identity(), sc.set(s2, 1, s2));
        this.gasMesh.setMatrixAt(i, m4);
      });
      this.gasMesh.instanceMatrix.needsUpdate = true;
    }

    // brouillard (fondu à la découverte, même logique que la 2D)
    const fogOn = L.fog && Lv.fogOn();
    this.fogMesh.visible = fogOn;
    if (fogOn) {
      let n = 0;
      for (const [x, y] of this.fogCells) {
        const r = Lv.revealAt.get(x + "," + y);
        const k = r == null ? 1 : Math.max(0, 1 - (now - r) / 700);
        if (k <= 0) continue;
        m4.compose(v3.set(this.wx(x), 0.018, this.wz(y)), q.identity(), sc.set(k, 1, k));
        this.fogMesh.setMatrixAt(n++, m4);
      }
      this.fogMesh.count = n;
      this.fogMesh.instanceMatrix.needsUpdate = true;
    }

    // prévision : flammes fantômes (couleur : rouge = bientôt, ambre = plus tard)
    const eta = s.forecast_eta || {};
    const horizon = this.ghostMin * 60;
    const elapsed = (s.t != null && s.forecast_t0 != null) ? s.t - s.forecast_t0 : 0;
    const ghostOn = L.fire && horizon > 0 && ["EN_ROUTE", "DRONE_INSIDE", "PLANS_READY"].includes(s.phase);
    this.ghostMesh.visible = this.ghostTile.visible = ghostOn;
    if (ghostOn) {
      let n = 0;
      const c = new THREE.Color(), soon = col(T["alarm"]), late = col(T["amber"]);
      for (const [k, sec] of Object.entries(eta)) {
        const rem = sec - elapsed;
        if (rem <= 0 || rem > horizon || Lv.fireNow.has(k)) continue;
        const [x, y] = k.split(",").map(Number);
        const f = rem / horizon;
        c.copy(soon).lerp(late, f);
        const top = this.stockTop(x, y);
        const h = 0.6 + 0.5 * (1 - f) + 0.08 * Math.sin(t * 3 + x * 1.3 + y);
        m4.compose(v3.set(this.wx(x), top, this.wz(y)), q.identity(), sc.set(1, h, 1));
        this.ghostMesh.setMatrixAt(n, m4); this.ghostMesh.setColorAt(n, c);
        m4.makeTranslation(this.wx(x), 0.03, this.wz(y));
        this.ghostTile.setMatrixAt(n, m4); this.ghostTile.setColorAt(n, c);
        n++;
      }
      this.ghostMesh.count = this.ghostTile.count = n;
      this.ghostMesh.instanceMatrix.needsUpdate = this.ghostTile.instanceMatrix.needsUpdate = true;
      if (n) this.ghostMesh.instanceColor.needsUpdate = this.ghostTile.instanceColor.needsUpdate = true;
    }

    // zones en alerte
    for (const [id, grp] of Object.entries(this.zoneFrames)) {
      grp.position.y = this.wallH - WALL_H;
      const zs = s.zones && s.zones[id];
      const lvl = zs ? zs.level : "NORMAL";
      grp.visible = lvl !== "NORMAL";
      if (grp.visible) {
        grp.userData.mat.color = col(lvl === "DANGER" ? T["alarm"] : T["amber"]);
        grp.userData.mat.opacity = lvl === "DANGER" ? 0.65 + 0.35 * Math.sin(t * 4) : 0.85;
      }
    }

    // capteurs fixes : petit boîtier en haut du mur, couleur du niveau
    for (const se of s.sensors || []) {
      let m = this.sensorMeshes.get(se.id);
      if (!m) {
        m = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.2, 0.28), new THREE.MeshBasicMaterial({ color: 0xffffff }));
        this.world.add(m); this.sensorMeshes.set(se.id, m);
      }
      m.position.set(this.wx(se.x), 2.7, this.wz(se.y));
      m.material.color = col(se.level === "ALARM" ? T["alarm"] : se.level === "WARNING" ? T["amber"] : T["map-ink-2"]);
    }

    // plans : rubans au sol avec chevrons qui défilent
    const showPlans = L.paths && ["DRONE_INSIDE", "PLANS_READY"].includes(s.phase);
    this.planGroup.visible = showPlans;
    if (key("plans", [s.plans, Lv.fireNow.size])) {
      this._clear(this.planGroup);
      const p = s.plans || {};
      const halo = new THREE.MeshBasicMaterial({ color: col(T["map-halo"]), transparent: true, opacity: 0.7, depthWrite: false, side: THREE.DoubleSide });
      const add = (path, color, y) => {
        const base = new THREE.MeshBasicMaterial({ color: col(color), transparent: true, opacity: 0.95, depthWrite: false, side: THREE.DoubleSide });
        const chevMat = new THREE.MeshBasicMaterial({ color: 0xffffff, map: this.chev, transparent: true, opacity: 0.9, depthWrite: false, side: THREE.DoubleSide });
        for (const [w, mat, dy] of [[0.56, halo, 0], [0.38, base, 0.003], [0.34, chevMat, 0.006]]) {
          const r = this._ribbon(path, w, y + dy, mat); if (r) this.planGroup.add(r);
        }
      };
      for (const e of p.evacuation || []) if (e.path && e.path.length > 1) add(e.path, T["evac"], 0.05);
      if (p.entry && p.entry.path && p.entry.path.length > 1) add(p.entry.path, T["entry"], 0.07);
      // attaques : flèche rouge depuis le côté d'attaque + numéro
      const byZone = {};
      for (const [x, y] of fire) {
        const z = typeof MainMap !== "undefined" && MainMap ? MainMap.zoneAt(x, y) : null;
        if (z) (byZone[z.id] = byZone[z.id] || []).push([x, y]);
      }
      const atk = new THREE.MeshBasicMaterial({ color: col(T["attack"]) });
      for (const e of p.extinguish || []) {
        let cx, cy;
        if (e.at) { cx = e.at[0]; cy = e.at[1]; } else {
          const cells = byZone[e.zone]; if (!cells) continue;
          cx = cells.reduce((a, c) => a + c[0], 0) / cells.length; cy = cells.reduce((a, c) => a + c[1], 0) / cells.length;
        }
        const X = this.wx(cx), Z = this.wz(cy), dir = SIDE_VEC[e.attack_from];
        if (dir) {
          const len = 2.2, from = new THREE.Vector3(X + dir[0] * 3.4, 0.9, Z + dir[1] * 3.4);
          const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, len, 10), atk);
          const head = new THREE.Mesh(new THREE.ConeGeometry(0.22, 0.5, 14), atk);
          const d = new THREE.Vector3(-dir[0], 0, -dir[1]);
          const qq = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d);
          shaft.quaternion.copy(qq); head.quaternion.copy(qq);
          shaft.position.copy(from).addScaledVector(d, len / 2);
          head.position.copy(from).addScaledVector(d, len + 0.25);
          this.planGroup.add(shaft, head);
        }
        const n = label(String(e.order), T["alarm-fill"], T["on-accent"], 0.7);
        n.position.set(X, 2.6, Z); this.planGroup.add(n);
      }
    }
    if (showPlans) this.chev.offset.x -= dt * 0.9;

    // trajectoire du drone
    if (key("trail", s.trail || [])) {
      this._clear(this.trailGroup);
      const mat = new THREE.MeshBasicMaterial({ color: col(T["map-ink"]), transparent: true, opacity: 0.55, depthWrite: false, side: THREE.DoubleSide });
      const r = this._ribbon(s.trail || [], 0.09, 0.04, mat); if (r) this.trailGroup.add(r);
    }

    // victimes trouvées
    const STATUS = { walking: "evac", injured: "alarm", no_answer: "amber" };
    const seen = new Set();
    for (const vi of s.victims || []) {
      if (!vi.found) continue;
      seen.add(vi.id);
      const tok = STATUS[vi.status] || "map-ink";
      let v = this.victims.get(vi.id);
      if (!v || v.tok !== tok) {
        if (v) { this.victimGroup.remove(v.grp); this._dispose(v.grp); }
        const c = col(T[tok]);
        const grp = new THREE.Group();
        const disc = new THREE.Mesh(new THREE.CircleGeometry(0.42, 32).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: c }));
        disc.position.y = 0.05;
        const pulse = new THREE.Mesh(new THREE.RingGeometry(0.46, 0.58, 40).rotateX(-Math.PI / 2),
          new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: 0.8, depthWrite: false }));
        pulse.position.y = 0.06;
        const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 7, 10, 1, true),
          new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: 0.4, depthWrite: false, blending: THREE.AdditiveBlending }));
        beam.position.y = 3.5;
        const fg = tok === "map-ink" ? T["map-halo"] : "#ffffff";
        const lab = label(vi.id, T[tok], fg, 0.6);
        lab.position.y = 1.5;
        grp.add(disc, pulse, beam, lab);
        for (const o of [disc, beam, lab]) o.userData.victim = vi.id;
        this.victimGroup.add(grp);
        v = { grp, pulse, tok, born: v ? v.born : now };
        this.victims.set(vi.id, v);
      }
      v.grp.position.set(this.wx(vi.x), 0, this.wz(vi.y));
      const k = ((t * 0.8) % 1);
      v.pulse.scale.setScalar(1 + k * 2.2);
      v.pulse.material.opacity = 0.8 * (1 - k);
    }
    for (const [id, v] of this.victims) if (!seen.has(id)) { this.victimGroup.remove(v.grp); this._dispose(v.grp); this.victims.delete(id); }

    // drone : position lissée, hélices, couleur selon la température
    const d = s.drone;
    if (!d || (d.state === "OUT")) {
      this.droneRoot.visible = false;
      if (!d) this.drone = null;
    } else {
      const tx = this.wx(d.x), tz = this.wz(d.y);
      if (!this.drone) this.drone = { x: tx, z: tz };
      const k = 1 - Math.exp(-dt * 7);
      const dx = tx - this.drone.x, dz = tz - this.drone.z;
      if (Math.hypot(dx, dz) > 6) { this.drone.x = tx; this.drone.z = tz; }
      this.drone.x += dx * k; this.drone.z += dz * k;
      if (Math.hypot(dx, dz) > 0.05) {
        let diff = Math.atan2(dz, dx) - this.droneHeading;
        while (diff > Math.PI) diff -= 2 * Math.PI;
        while (diff < -Math.PI) diff += 2 * Math.PI;
        this.droneHeading += diff * k;
      }
      this.droneRoot.visible = true;
      this.droneRoot.position.set(this.drone.x, 0, this.drone.z);
      this.droneBody.rotation.y = -this.droneHeading;
      this.droneBody.position.y = 1.5 + 0.05 * Math.sin(t * 2.4);
      for (const r of this.rotors) r.rotation.y += dt * 40;
      const heat = Math.max(0, Math.min(1, ((d.temp || 20) - 35) / 25));
      this.droneMat.color.copy(col(T["map-ink"])).lerp(col(T["alarm"]), heat);
      this.droneMat.emissive.copy(col(T["alarm"])).multiplyScalar(heat * (0.4 + 0.3 * Math.sin(t * 8)));
    }
  }

  // -------------------------------------------------------------- caméra
  overview(instant) {
    const tan = Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
    const d = Math.max(this.H * 0.95, (this.W * 0.9) / (this.camera.aspect || 1.6)) / (2 * tan);
    const tgt = new THREE.Vector3(0, 0, 0.5), pos = new THREE.Vector3(0, d * 0.8, d * 0.6);
    if (instant) { this.camera.position.copy(pos); this.controls.target.copy(tgt); this.controls.update(); }
    else this._flyTo(tgt, pos, 1200);
  }
  flyToCell(x, y, dist = 10, dur = 1200) {
    const tgt = new THREE.Vector3(this.wx(x), 0, this.wz(y));
    const off = this.camera.position.clone().sub(this.controls.target);
    const az = Math.atan2(off.x, off.z), polar = 0.9;
    const pos = tgt.clone().add(new THREE.Vector3(Math.sin(polar) * Math.sin(az), Math.cos(polar), Math.sin(polar) * Math.cos(az)).multiplyScalar(dist));
    this._flyTo(tgt, pos, dur);
  }
  flyToZone(id, dur = 1200, dist) {
    const z = (this.f.zones || []).find((zz) => zz.id === id);
    if (!z) return;
    const [x0, y0, x1, y1] = z.rect;
    this.flyToCell((x0 + x1) / 2, (y0 + y1) / 2, dist || Math.max(10, Math.max(x1 - x0, y1 - y0) * 1.15), dur);
  }
  _flyTo(tgt, pos, dur) {
    this.fly = { t0: performance.now(), dur, fromT: this.controls.target.clone(), fromP: this.camera.position.clone(), toT: tgt, toP: pos };
  }
  _stepFly(now) {
    const f = this.fly; if (!f) return;
    const k = Math.min(1, (now - f.t0) / f.dur), e = ease(k);
    this.controls.target.lerpVectors(f.fromT, f.toT, e);
    this.camera.position.lerpVectors(f.fromP, f.toP, e);
    if (k >= 1) this.fly = null;
  }

  // -------------------------------------------------------------- souris : survol (infobulle 2D) et clic
  _pointer() {
    const el = this.renderer.domElement;
    const ray = new THREE.Raycaster(), ndc = new THREE.Vector2(), hit = new THREE.Vector3();
    const tip = document.getElementById("tooltip");
    const at = (ev) => {
      const r = el.getBoundingClientRect();
      ndc.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
      ray.setFromCamera(ndc, this.camera);
      return r;
    };
    const cellAt = () => {
      if (!this.floorPlane || !ray.ray.intersectPlane(this.floorPlane, hit)) return null;
      const x = Math.floor(hit.x + this.W / 2), y = Math.floor(hit.z + this.H / 2);
      return (x < 0 || y < 0 || x >= this.W || y >= this.H) ? null : [x, y];
    };
    el.addEventListener("pointermove", (ev) => {
      if (ev.buttons) { tip.style.display = "none"; return; }
      const r = at(ev), c = cellAt();
      if (!c || typeof describeCell !== "function") { tip.style.display = "none"; return; }
      tip.innerHTML = describeCell(c[0], c[1]);
      tip.style.display = "block";
      const host = this.host.getBoundingClientRect();
      const tx = ev.clientX - host.left + 14, ty = ev.clientY - host.top + this.host.offsetTop + 14;
      tip.style.left = Math.min(tx, r.width - 270) + "px";
      tip.style.top = Math.min(ty, this.host.offsetTop + r.height - 120) + "px";
    });
    el.addEventListener("pointerleave", () => { tip.style.display = "none"; });
    el.addEventListener("dblclick", (ev) => {      // double-clic : s'approcher de ce point
      at(ev); const c = cellAt(); if (!c) return;
      this.follow = false; syncNav();
      this.flyToCell(c[0], c[1], Math.max(6, this._offset().length() * 0.6), 700);
    });
    let down = null;
    el.addEventListener("pointerdown", (ev) => { down = [ev.clientX, ev.clientY]; });
    el.addEventListener("pointerup", (ev) => {
      if (!down || Math.hypot(ev.clientX - down[0], ev.clientY - down[1]) > 5) return;
      at(ev);
      const hits = ray.intersectObjects(this.victimGroup ? this.victimGroup.children : [], true);
      const vh = hits.find((h) => h.object.userData.victim);
      const s = G().s;
      if (vh && s) {
        const vi = (s.victims || []).find((v) => v.id === vh.object.userData.victim);
        if (vi) { this.flyToCell(vi.x, vi.y, 7); return; }
      }
      const c = cellAt(); if (!c || !s) return;
      const ex = (this.f.exits || []).find((e) => Math.abs(e.x - c[0]) <= 1 && Math.abs(e.y - c[1]) <= 1);
      if (ex && s.phase === "EN_ROUTE" && typeof Panel !== "undefined") { Panel.pickEntry(ex.id); return; }
      const z = typeof MainMap !== "undefined" && MainMap ? MainMap.zoneAt(c[0], c[1]) : null;
      if (z) { this.flyToZone(z.id); if (typeof Loupe !== "undefined") Loupe.open(z.id); }
    });
  }

  // -------------------------------------------------------------- commandes (boutons, clavier)
  _offset() { return this.camera.position.clone().sub(this.controls.target); }
  zoom(f) {
    const off = this._offset();
    const d = THREE.MathUtils.clamp(off.length() * f, this.controls.minDistance, this.controls.maxDistance);
    this._flyTo(this.controls.target.clone(), this.controls.target.clone().add(off.setLength(d)), 320);
  }
  rotate(a) {
    const off = this._offset().applyAxisAngle(UP, a);
    this._flyTo(this.controls.target.clone(), this.controls.target.clone().add(off), 450);
  }
  north() {
    const off = this._offset(), r = Math.hypot(off.x, off.z);
    this._flyTo(this.controls.target.clone(), this.controls.target.clone().add(new THREE.Vector3(0, off.y, r)), 500);
  }
  isTop() { const off = this._offset(); return Math.hypot(off.x, off.z) < off.length() * 0.1; }
  topView() {
    const off = this._offset(), d = off.length(), top = this.isTop();
    const az = Math.atan2(off.x, off.z), polar = top ? 0.9 : 0.02;
    const pos = new THREE.Vector3(Math.sin(polar) * Math.sin(az), Math.cos(polar), Math.sin(polar) * Math.cos(az)).multiplyScalar(d);
    this._flyTo(this.controls.target.clone(), this.controls.target.clone().add(pos), 600);
    this.topWanted = !top;
  }
  pan(right, fwd) {
    const off = this._offset();
    const f = new THREE.Vector3(-off.x, 0, -off.z);
    if (f.lengthSq() < 1e-6) f.set(0, 0, -1);
    f.normalize();
    const r = new THREE.Vector3(-f.z, 0, f.x);
    const step = Math.max(1.5, off.length() * 0.12);
    const d = r.multiplyScalar(right * step).add(f.multiplyScalar(fwd * step));
    this._flyTo(this.controls.target.clone().add(d), this.camera.position.clone().add(d), 260);
  }
  setWalls(low) { this.wallTarget = low ? 1.1 : WALL_H; }
  _applyWalls(h) {
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), v = new THREE.Vector3(), s = new THREE.Vector3();
    this.wallCells.forEach(([x, y], i) => {
      m.compose(v.set(this.wx(x), h / 2, this.wz(y)), q, s.set(1, h, 1)); this.wallMesh.setMatrixAt(i, m);
      m.makeTranslation(this.wx(x), h + 0.002, this.wz(y)); this.capMesh.setMatrixAt(i, m);
    });
    this.wallMesh.instanceMatrix.needsUpdate = this.capMesh.instanceMatrix.needsUpdate = true;
    this.lintelMesh.visible = h > WALL_H - 0.4;
  }
  // garde le point visé dans l'emprise du bâtiment (on ne se perd pas dans le vide)
  _clamp() {
    const tg = this.controls.target, mx = this.W / 2 + 4, mz = this.H / 2 + 4;
    const cx = THREE.MathUtils.clamp(tg.x, -mx, mx), cz = THREE.MathUtils.clamp(tg.z, -mz, mz);
    if (cx !== tg.x || cz !== tg.z || tg.y !== 0) {
      const d = new THREE.Vector3(cx - tg.x, -tg.y, cz - tg.z);
      tg.add(d); this.camera.position.add(d);
    }
  }
  _frameExtras(dt) {
    if (!this.wallMesh) return;
    // murs : animation vers la hauteur demandée
    if (Math.abs(this.wallH - this.wallTarget) > 0.005) {
      this.wallH += (this.wallTarget - this.wallH) * (1 - Math.exp(-dt * 10));
      if (Math.abs(this.wallH - this.wallTarget) < 0.01) this.wallH = this.wallTarget;
      this._applyWalls(this.wallH);
    }
    // suivi du drone : la caméra glisse avec lui en gardant son angle
    if (this.follow && !this.fly && this.droneRoot && this.droneRoot.visible) {
      const tg = this.controls.target, dp = this.droneRoot.position;
      const d = new THREE.Vector3(dp.x - tg.x, 0, dp.z - tg.z).multiplyScalar(1 - Math.exp(-dt * 3));
      tg.add(d); this.camera.position.add(d);
    }
    if (!this.fly) this._clamp();
    // boussole : l'aiguille indique le nord à l'écran
    const off = this._offset();
    const az = Math.atan2(off.x, off.z) * 180 / Math.PI;
    if (this.needle && Math.abs(az - (this._az == null ? 999 : this._az)) > 0.2) {
      this.needle.setAttribute("transform", `rotate(${az.toFixed(1)} 20 20)`); this._az = az;
    }
    const top = this.fly ? this.topWanted : this.isTop();
    if (top !== this._lastTop) { this._lastTop = top; syncNav(); }
  }

  // -------------------------------------------------------------- boucle
  resize() {
    const w = this.host.clientWidth, h = this.host.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = w + "px";
    this.renderer.domElement.style.height = h + "px";
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    if (this.fireMat) {
      const buf = this.renderer.getDrawingBufferSize(new THREE.Vector2());
      this.fireMat.uniforms.uScale.value = 0.85 * (buf.y / 2) / Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
    }
  }
  start() {
    if (this.raf) return;
    this.clock.getDelta();
    const loop = (now) => {
      this.raf = requestAnimationFrame(loop);
      try {
        const raw = this.clock.getDelta();
        const dt = Math.min(0.1, raw);
        // ordinateur lent (pas de carte graphique) : on allège le rendu pour garder la page réactive
        const pf = this._perf || (this._perf = { acc: 0, n: 0, level: 0 });
        if (raw < 0.5) { pf.acc += raw; pf.n++; }   // ignore le retour d'un onglet caché
        if (pf.n >= 90) {
          if (pf.acc / pf.n > 0.034 && pf.level < 2) {
            pf.level++;
            this.renderer.setPixelRatio(pf.level === 1 ? 1 : 0.75);
            this.fireBudget = pf.level === 1 ? 0.6 : 0.35;
            this.keys.fire = null;
            this.resize();
          }
          pf.acc = 0; pf.n = 0;
        }
        const t = this.clock.elapsedTime;
        const s = G().s;
        if (this.world && s) this._sync(s, now, t, dt);
        this._stepFly(now);
        this._frameExtras(dt);
        this.controls.update();
        this.renderer.render(this.scene, this.camera);
      } catch (e) { console.error(e); }
    };
    this.raf = requestAnimationFrame(loop);
  }
  stop() { if (this.raf) cancelAnimationFrame(this.raf); this.raf = null; }
}

// ------------------------------------------------------------------ branchement dans la page
// état des boutons de la vue 3D (aria-pressed)
function syncNav() {
  const v = window.View3D && window.View3D.impl;
  if (!v) return;
  const set = (sel, on) => { const b = document.querySelector(sel); if (b) b.setAttribute("aria-pressed", String(on)); };
  set('[data-nav="walls"]', v.wallTarget !== WALL_H);
  set('[data-nav="follow"]', v.follow);
  set('[data-nav="top"]', v.fly ? !!v.topWanted : v.isTop());
  document.querySelectorAll("[data-ghost]").forEach((b) => b.setAttribute("aria-pressed", String(+b.dataset.ghost === v.ghostMin)));
}
const View3D = window.View3D = {
  active: false,
  impl: null,
  async show(on) {
    const host = document.getElementById("map3d"), map2d = document.getElementById("map");
    if (on && !this.impl) {
      try {
        this.impl = new View3DImpl(host, G().factory);
        await this.impl.build();
      } catch (e) {
        console.error("[3D] indisponible :", e);
        this.impl = null;
        const btn = document.querySelector('[data-view="3d"]');
        if (btn) { btn.disabled = true; btn.title = "Vue 3D indisponible sur cet ordinateur (WebGL)"; }
        return;
      }
    }
    this.active = on;
    host.hidden = !on;
    map2d.style.visibility = on ? "hidden" : "";
    document.getElementById("mapWrap").classList.toggle("is3d", on);
    document.getElementById("tooltip").style.display = "none";
    document.querySelectorAll("[data-view]").forEach((b) => b.setAttribute("aria-pressed", String((b.dataset.view === "3d") === on)));
    if (on) { this.impl.needle = document.getElementById("m3Needle"); this.place(); this.impl.resize(); this.impl.start(); syncNav(); }
    else if (this.impl) this.impl.stop();
  },
  // la vue 3D recouvre exactement le canvas 2D (au-dessus de la barre de la carte)
  place() {
    const host = document.getElementById("map3d"), map2d = document.getElementById("map");
    host.style.top = map2d.offsetTop + "px";
    host.style.height = map2d.offsetHeight + "px";
  },
  overview() { if (this.impl) { this.impl.follow = false; this.impl.topWanted = false; this.impl.overview(false); syncNav(); } },
  nav(a) {
    const v = this.impl; if (!v || !this.active) return;
    if (a === "zin") v.zoom(0.72); else if (a === "zout") v.zoom(1.38);
    else if (a === "rl") v.rotate(Math.PI / 4); else if (a === "rr") v.rotate(-Math.PI / 4);
    else if (a === "north") v.north();
    else if (a === "top") v.topView();
    else if (a === "walls") v.setWalls(v.wallTarget === WALL_H);
    else if (a === "follow") v.follow = !v.follow;
    else if (a === "home") { this.overview(); return; }
    syncNav();
  },
  setGhost(min) { if (this.impl) this.impl.ghostMin = min; syncNav(); },
  flyToZone(id) { if (this.impl) this.impl.flyToZone(id); },
};

(function wire() {
  if (!G() || !G().factory) { setTimeout(wire, 100); return; }
  document.querySelectorAll("[data-view]").forEach((b) => { b.onclick = () => View3D.show(b.dataset.view === "3d"); });
  const ov = document.getElementById("m3Overview");
  if (ov) ov.onclick = () => View3D.overview();
  document.querySelectorAll("[data-nav]").forEach((b) => { b.onclick = () => View3D.nav(b.dataset.nav); });
  document.querySelectorAll("[data-ghost]").forEach((b) => { b.onclick = () => View3D.setGhost(+b.dataset.ghost); });
  new ResizeObserver(() => { if (View3D.active) { View3D.place(); View3D.impl.resize(); } }).observe(document.getElementById("mapWrap"));
  document.addEventListener("keydown", (e) => {
    if (e.target.tagName === "INPUT") return;
    if (e.key === "v" || e.key === "V") { View3D.show(!View3D.active); return; }
    if (!View3D.active || e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key, v = View3D.impl;
    const act = { "+": "zin", "=": "zin", "-": "zout", q: "rl", Q: "rl", e: "rr", E: "rr", n: "north", N: "north",
      t: "top", T: "top", b: "walls", B: "walls", f: "follow", F: "follow", h: "home", H: "home", "0": "home" }[k];
    if (act) { View3D.nav(act); e.preventDefault(); return; }
    const pan = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] }[k];
    if (pan && v) { v.follow = false; v.pan(pan[0], pan[1]); syncNav(); e.preventDefault(); }
  });
  // http://SERVER:5000/#3d ouvre directement la vue 3D (la 2D reste la vue par défaut)
  if (location.hash === "#3d") View3D.show(true);
})();
