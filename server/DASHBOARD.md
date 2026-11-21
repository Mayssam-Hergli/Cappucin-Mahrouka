# server/ : hub, dashboard et page usine (Teammate 3)

Un seul serveur Flask : tous les modules lui parlent en JSON par le hotspot.

```bash
pip install -r server/requirements.txt
python server/app.py                 # http://SERVER_IP:5000
```

| Page | Pour qui |
|---|---|
| `http://SERVER_IP:5000/` | Dashboard Protection Civile (poste de commandement) |
| `http://SERVER_IP:5000/factory` | Page usine (sur téléphone) : confirmer / annuler l'alarme, toucher le départ du feu |

Tester sans matériel :

```bash
python server/fake_sensor.py --node N1 --zone Z3     # Entrée = déclencher le feu
```

Dans le dashboard, la touche **D** affiche le panneau démo (étape suivante, alarme simulée,
+12 °C drone, personne ici, vitesse ×1/×2/×4, reset). Échap ferme la loupe.

## Fichiers

| Fichier | Rôle |
|---|---|
| `app.py` | API partagée + machine à phases + thread qui appelle `sim.step()` toutes les 0,5 s |
| `zones.py` | Analyse live : carte découverte, mesures du drone, filtrage top 3, niveaux d'alerte, risques |
| `fake_sim.py` | **FakeSim**, même interface que la `Sim` de Teammate 2, pour développer sans l'attendre |
| `geo.py` | Grille, ligne de vue, BFS, A* |
| `fake_sensor.py` | Faux ESP32 |
| `data/factory_demo.json` | Carte de démo provisoire (générée par `data/make_factory.py`) |
| `static/js/live.js` | Récupération de `/api/state` toutes les 500 ms + mémoire côté écran ; `Live.post` met le bouton cliqué « en cours » (roue) puis affiche « Fait » ou « Refusé : raison » |
| `static/js/map.js` | Rendu canvas 60 images/s (brouillard, feu, fumée, drone interpolé, scan, alertes) |
| `static/js/mission.js` | Ordre d'intervention des pompiers, construit à partir des plans : sauvetages, coupures, attaques, avec itinéraires, établissements, lances et dangers sur le chemin (dessiné par `map.js`, listé par `panel.js`) |
| `static/js/loupe.js` | Vue zoomée d'une zone en danger (équipements, valeurs placées, top 3, risques) |
| `static/js/thermal.js` | Caméra thermique (image webcam de Teammate 1 si dispo, sinon simulée) |
| `static/js/panel.js` | Frise des phases, chrono, actions, victimes, plans à valider, journal, santé |

## Brancher les vrais modules

- **Sim (Teammate 2)** : dès que `from sim import Sim` fonctionne (`sim/__init__.py`), le serveur
  l'utilise à la place de la FakeSim. `FAKE_SIM=1` force la FakeSim. Le serveur charge
  `sim/factory.json` s'il existe, sinon la carte de démo.
- **ESP32 (Teammate 4)** : `POST /api/sensor`, inchangé. Le nœud apparaît « réel » sur la carte.
- **Vision et voix (Teammate 1)** : `POST /api/vision`, `GET /api/voice/next`, inchangés. La voix ne fait que parler :
  le message vient de `sim.guidance(id)["say"]` (sortie la plus sûre, distance, portes). `POST /api/voice` reste
  disponible pour une future voix qui écoute ; sinon le commandant précise l'état d'une victime sur le dashboard.

## Ce qui s'ajoute au contrat (sans rien casser)

`factory.json` peut avoir deux clés **en plus**, utilisées seulement par le dashboard :

```json
"exits":     [{"id": "E1", "x": 0, "y": 4, "name": "Sortie Ouest"}],
"equipment": [{"type": "metal|electric|gas|valve|solvent|extinguisher", "x": 17, "y": 5, "label": "Presse"}]
```

Sans `exits`, les sorties sont numérotées dans l'ordre de lecture de la grille. `sim/factory.json` déclare ses
sorties (E1 ouest, E2 sud, E3 est) et son équipement : le serveur, la Sim et le dashboard utilisent les mêmes.

**Convention du vent** (contrat du README, vraie Sim et FakeSim) : `deg` est la direction **vers** laquelle
souffle le vent, 0 = nord, 90 = est. La flèche de l'écran (0 = vers l'est) est convertie dans `panel.js`.

`/api/state` renvoie aussi : `explored`, `trail`, `zones` (niveau, top 3 des mesures, risques),
`sensors`, `alerts`, `forecast`, `dialogs`, `decisions`, `camera`, `health`, `marks`.

Routes du dashboard : `POST /api/call_factory`, `/api/wind`, `/api/victim/status`,
`/api/plan/decide`, `/api/reset`, `/api/demo/<skip|alarm|heat|victim|speed>`.
