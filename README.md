# Hrika

**A live factory map and a scout drone that go in before the firefighters.**

Built for the Tunisian Aeroday hackathon, *Protection Civile* challenge: use aeronautic technology and AI to improve the prevention, detection and management of fires in factories.

> **The rule:** the AI recommends, the commander decides.

---

## Table of contents

1. [The problem](#the-problem)
2. [Our solution](#our-solution)
3. [The scenario, step by step](#the-scenario-step-by-step)
4. [System architecture](#system-architecture)
5. [Repository layout](#repository-layout)
6. [Getting started](#getting-started)
7. [The dashboard](#the-dashboard)
8. [Shared contract](#shared-contract)
9. [The simulation](#the-simulation)
10. [The AI model](#the-ai-model)
11. [Prototype vs. real product](#prototype-vs-real-product)
12. [Hardware](#hardware)
13. [Safety and limits](#safety-and-limits)
14. [License and credits](#license-and-credits)

---

## The problem

When a factory burns, firefighters arrive without knowing what is inside, who is trapped or where the danger is. Intervention plans are often on paper, out of date or missing. Thick smoke hides everything, and workers die from smoke and toxic gas while firefighters search room by room.

## Our solution

- **Fixed sensors** already installed in the factory detect fire or gas and raise an alarm on the Protection Civile dashboard.
- **A false-alarm check.** The Protection Civile calls the factory, which confirms or cancels the alarm and says where the fire started.
- **A live map.** While the team drives to the site, the factory map and a fire forecast load on the dashboard.
- **A scout drone** flies in first. Its **thermal camera** and an **AI person detector** find trapped people through the smoke and place them on the map.
- **The drone talks to victims** through a speaker: it gives them the safest exit and tells them the Protection Civile is on its way. Every victim found is flagged *rescue first*.
- **Heat safety.** At **60 °C** the drone flies to the nearest exit by itself.
- **Three plans** once the scan is done:
  - **Evacuation**: the safest route out for each victim, with injured or silent victims flagged *rescue first*.
  - **Entry**: the best door for the firefighters to go in and reach the victims safely.
  - **Extinguishing**: where to start, from which side, and with what (water, foam, CO₂ or powder), plus whether to close the gas valve or cut the power first.
- **A command dashboard in 2D or 3D.** One sentence tells the commander what to do now, countdowns show when the fire will reach the gas bottles, the solvents or a victim, and each zone has a hazard sheet (how to attack it safely, nearest hydrant and exit).

**The aeronautics link:** drones, aerial mapping and thermal imaging.

## The scenario, step by step

This is also the demo script. Each step is one moment you see on the dashboard.

```
 1. NORMAL        Sensors report normal values.
 2. ALERT         A sensor detects gas, heat or a flame. The alarm appears with its zone.
 3. CHECKING      The Protection Civile calls the factory.
 4. CONFIRMED     The factory confirms and clicks where the fire started.
    (or FALSE_ALARM, which is logged before going back to NORMAL)
 5. EN_ROUTE      The map loads and the fire forecast runs while the team drives.
 6. DRONE_INSIDE  The drone enters by the chosen door, explores, finds and talks to victims.
                  At 60 °C it leaves by the nearest exit.
 7. PLANS_READY   The evacuation, entry and extinguishing plans are shown.
```

## System architecture

One Flask server is the hub. Every other part talks to it in JSON over HTTP, on a local network (a 2.4 GHz phone hotspot during the demo). The simulation is a pure Python module that the server imports and runs. It has no web code of its own.

```mermaid
flowchart LR
    subgraph Factory site
        ESP[ESP32 sensor node<br/>gas · temperature · flame]
        FP[Factory page<br/>confirm / cancel · fire origin]
    end

    subgraph Drone, simulated on a laptop
        VIS[vision/<br/>webcam → person detection<br/>→ thermal look]
        VOI[voice/<br/>text-to-speech]
    end

    subgraph Server laptop
        SRV[server/<br/>Flask hub + phase machine]
        SIM[sim/<br/>factory · fire · smoke · gas<br/>drone · A* · three plans]
        SRV -- "imports, step() every 0.5 s" --> SIM
    end

    DASH[Dashboard<br/>Protection Civile]

    ESP -- "POST /api/sensor" --> SRV
    FP -- "POST /api/factory/confirm" --> SRV
    VIS -- "POST /api/vision" --> SRV
    VOI -- "GET /api/voice/next" --> SRV
    DASH -- "GET /api/state every 500 ms<br/>POST /api/drone/launch" --> SRV
```

| Part | Folder | Language | Talks to the server via |
|---|---|---|---|
| Sensor node | `iot/` | Arduino C++ (ESP32) | `POST /api/sensor` every second |
| Factory page | `server/` | HTML + JS | `POST /api/factory/confirm` |
| Dashboard | `server/` | HTML, JS, canvas (2D map), Three.js (3D view) | `GET /api/state`, `POST /api/drone/launch` and the dashboard routes |
| Server and phase machine | `server/` | Python, Flask | n/a (it is the hub) |
| Simulation and plans | `sim/` | Python | imported directly by the server |
| Vision | `vision/` | Python, OpenCV, YOLOv8 | `POST /api/vision` |
| Voice | `voice/` | Python, edge-tts neural voice (pyttsx3 offline fallback) | `GET /api/voice/next` |
| AI model | `ai/` | Python, Ultralytics (Colab) | offline: training and evaluation only |

## Repository layout

```
.
├── ai/        Thermal person detector: training notebook, weights, metrics, report
├── vision/    Fake-thermal webcam script (the drone's camera)
├── voice/     Text-to-speech script (the drone's voice)
├── sim/       Factory map, fire / smoke / gas spread, virtual drone, A*, the three plans
├── server/    Flask server, Protection Civile dashboard, factory page, fake sensor
├── iot/       ESP32 sensor node firmware
├── docs/      Reports, empathy map, slides, video
├── context/   Challenge brief, project plan, hardware handover notes
├── requirements.txt
└── README.md
```

Each folder has its own `README.md` with the details of that part.

## Getting started

### Prerequisites

- Python 3.10 or newer
- Arduino IDE (or PlatformIO) with ESP32 board support, if you use the hardware node
- A webcam and a speaker for the vision and voice parts
- Every device on the same network (a 2.4 GHz hotspot, because the ESP32 has no 5 GHz)

### Install

```bash
git clone https://github.com/Mayssam-Hergli/Cappucin-Mahrouka.git
cd Cappucin-Mahrouka
python -m venv .venv
# Windows: .venv\Scripts\activate    macOS / Linux: source .venv/bin/activate
pip install -r requirements.txt
```

### Run the demo

Replace `SERVER_IP` with the IP address of the laptop that runs the server.

```bash
# 1. The hub (opens the dashboard at http://SERVER_IP:5000 and the factory page at /factory)
python server/app.py

# 2. A sensor alarm, either from the real ESP32 (see iot/) or from the fake sensor
#    (press Enter in its terminal to start the fire, Ctrl+C to stop it):
python server/fake_sensor.py --server http://SERVER_IP:5000 --node N1

# 3. The drone's camera and voice, on any laptop on the network:
python vision/fake_thermal.py --server http://SERVER_IP:5000
python voice/voice.py --server http://SERVER_IP:5000
```

No hardware at hand? In the dashboard, press **D** to open the demo panel: simulated alarm, next step, speed ×1 / ×2 / ×4, reset. Stop the server with **Ctrl+C** before starting it again: two servers on the same port answer in turn and the screen seems to lag.

### Run the simulation alone (no server)

```bash
python -m sim.viewer                                          # live animation of the demo scenario
python -m sim.viewer --origin 34 20 --wind 10 270 --entry E2  # fire origin, wind and drone entry door
python -m sim.viewer --save run.png --steps 20 60 100 130     # snapshots side by side
```

This plays the whole scenario: the fire, smoke and gas spread, the drone is launched after a short forecast, explores, finds and speaks to victims, and the three plans are drawn on the map. Add `--answers` to simulate the commander marking who can walk.

## The dashboard

`http://SERVER_IP:5000/` is the Protection Civile command post; `http://SERVER_IP:5000/factory` is the factory's page (on a phone). Everything the pages need (Three.js, icons, fonts) is served from `server/static/vendor/`, so the demo works on a hotspot without Internet.

| Feature | What the commander sees |
|---|---|
| 2D map (default) | Zones, stock, fire, smoke, gas, unexplored areas, drone, victims and the three plans, with ISO-style safety signs |
| 3D view | Button **2D / 3D**, key **V**, or `/#3d` in the address. Burning stock, smoke drifting with the wind, the drone and its camera cone, victims with a light beam, plans as ribbons on the floor. Toolbar: compass, zoom, top view (**T**), low walls to see inside the rooms (**B**); keys **Q / E** rotate, **F** follows the drone. It lowers its quality by itself on a slow PC |
| Fire forecast | Ghost flames where the fire will be in 1, 3 or 5 minutes if nothing is done (selector "Feu prévu dans") |
| Immediate action | One sentence above the map, readable from 3 m, e.g. "Entrer par E3 (Est) — 2 victimes en Z4, dont 1 blessée — risque d'explosion Z4 dans ~4 min" |
| Critical countdowns | Time before the fire reaches the gas bottles, solvents, electrical cabinets, exits or a victim, and before the drone reaches 60 °C. Click a line to go there |
| Zone loupe and hazard sheet | Click a zone: top 3 readings, risks tagged EXPLOSION / TOXIQUE / ARI..., and how to attack it (foam for solvents, cut the power first, gas valve to close, nearest hydrant and exit) |
| Demo panel | Key **D** |

Details for developers: [`server/DASHBOARD.md`](server/DASHBOARD.md).

## Shared contract

Every part depends on this contract. **Do not change it without telling the whole team.**

### Server API (`http://SERVER_IP:5000`)

| Method | Route | Sender | Body / response |
|---|---|---|---|
| `POST` | `/api/sensor` | ESP32 | `{node, zone, gas, temp, flame, level: NORMAL\|WARNING\|ALARM, cause}` |
| `POST` | `/api/factory/confirm` | Factory page | `{real: true, origin: [x, y]}` or `{real: false}` |
| `POST` | `/api/drone/launch` | Dashboard | `{entry: "E2"}` |
| `POST` | `/api/vision` | Vision script | `{person: true, conf: 0.87, jpg: "<base64 320x240 JPEG>"}` |
| `GET` | `/api/voice/next` | Voice script (polls every 1 s) | `{victim: "V1", say: "..."}` or `{}` |
| `POST` | `/api/voice` | Optional: a voice script that listens (the current one only speaks) | `{victim, heard, status: walking\|injured\|no_answer}` |
| `POST` | `/api/victim/status` | Dashboard: the commander sets a victim's state | `{victim, status: walking\|injured\|no_answer}` |
| `GET` | `/api/state` | Dashboard (polls every 500 ms) | the full state, below |

Every `POST` sends a JSON body with the header `Content-Type: application/json`; anything else is refused with `415`.

Routes used by the dashboard and the demo tools (they change nothing above):

| Method | Route | Use |
|---|---|---|
| `GET` | `/api/factory` | The map to draw (grid, zones, exits, equipment...) |
| `POST` | `/api/call_factory` | The commander calls the factory (`ALERT` → `CHECKING`) |
| `POST` | `/api/voice/done` | The voice script finished a message: `{victim}` |
| `POST` | `/api/wind` | Wind slider: `{kmh, deg}` |
| `POST` | `/api/plan/decide` | The commander accepts or rejects a plan: `{plan: evacuation\|entry\|extinguish, decision: accepted\|rejected}` |
| `POST` | `/api/reset` | Back to `NORMAL` |
| `POST` | `/api/demo/<skip\|alarm\|heat\|victim\|speed>` | Demo panel |

**Signed sensor messages.** The body of `POST /api/sensor` does not change; the node adds three headers: `X-Hrika-Time` (Unix time), `X-Hrika-Seq` (message counter) and `X-Hrika-Sig` = hex HMAC-SHA256 of `"<time>.<seq>.<raw body>"` with the node's key. The server refuses a wrong signature, a message older than 30 s, or a replay. Keys live in `server/keys/nodes.json` (never committed); without that file, unsigned messages are accepted (development mode). `python server/security.py new-key N1` creates a key and prints the node's `secrets.h`. `SENSOR_AUTH=off` turns the check off as a last resort on demo day.

Example sensor payload:

```json
{"node": "N1", "zone": "Z2", "gas": 1830, "temp": 31.2, "flame": 0, "level": "ALARM", "cause": "gas"}
```

### Phases

```
NORMAL → ALERT → CHECKING → CONFIRMED (or FALSE_ALARM → NORMAL) → EN_ROUTE → DRONE_INSIDE → PLANS_READY
```

### State (`GET /api/state`)

```jsonc
{
  "phase": "DRONE_INSIDE",
  "t": 135.0,                                   // simulated seconds since the fire started
  "wind": {"kmh": 15, "deg": 90},
  "fire":  [[x, y], ...],
  "burnt": [[x, y], ...],                       // burnt-out cells
  "smoke": [[x, y], ...],
  "gas":   [[x, y], ...],
  "drone": {"x": 12, "y": 8, "temp": 47.5, "state": "EXPLORING"},   // EXPLORING | RETURNING | OUT
  "victims": [{"id": "V1", "x": 30, "y": 4, "found": true, "status": "injured"}],
  "plans": {
    "evacuation": [{"victim": "V1", "path": [[x, y], ...], "exit": "E3", "rescue_first": true}],
    "entry":      {"door": "E2", "path": [[x, y], ...]},
    "extinguish": [{"zone": "Z3", "at": [23, 21], "fire_class": "A", "agent": "water", "attack_from": "E",
                    "first": [], "order": 1,
                    "lookahead": {"minutes": 3, "sides_tested": ["S", "E"],
                                  "fire_near_victims": {"no_action": 5, "with_attack": 0},
                                  "fire_m2": {"no_action": 10, "with_attack": 0}}}]
  },
  "events": [{"t": "12:03:41", "at": 1795289021.4, "text": "ALARME zone Z2 (gas) — capteur N1", "kind": "danger"}]
}
```

The server adds more keys for the dashboard (additions only): `alarm`, `marks` (time of each phase), `zones` (level, top 3 readings, `risks` and `risk_tags`), `sensors`, `alerts`, `explored`, `trail`, `dialogs`, `decisions`, `camera`, `health`, `speed`, and the fire forecast: `forecast` (burning cells in 3 minutes, during `EN_ROUTE`), `forecast_eta` (`{"x,y": simulated seconds before that cell ignites}`), `forecast_t0` (the simulated time `t` when it was computed) and `forecast_at`. The forecast runs on a copy of the simulation and is recomputed every 30 s during `EN_ROUTE` and `DRONE_INSIDE`.

### Simulation interface (`sim/`)

```python
from sim import Sim

sim = Sim("sim/factory.json")
sim.start_fire(x, y)                    # fire origin given by the factory
sim.set_wind(kmh, deg)                  # wind slider on the dashboard
sim.launch_drone("E2")                  # entry door chosen on the dashboard
sim.step()                              # called every 0.5 s by the server; returns the ids of victims found
sim.add_victim_here(conf)               # the webcam saw a person at the drone's position
sim.set_victim_status("V1", "injured")  # walking | injured | no_answer
sim.state()                             # dict = the state above, without "phase" and "events"
```

Helpers for the server and the dashboard. These are additions and change nothing above:

```python
sim.map_info()                          # the map to draw: grid, zones, exits, sensors... (hidden victims left out)
sim.forecast(minutes=5)                 # where the fire will be if nothing is done (call once at EN_ROUTE)
sim.guidance("V1")                      # {exit, distance_m, doors, say}: "say" is the French sentence for the voice
sim.set_drone_temp(36.2)                # optional: a real temperature from a "drone box" sensor
Sim("sim/factory.json", return_temp=35) # optional: a lower return threshold for a live hardware demo
```

See [`sim/README.md`](sim/README.md#how-the-server-uses-it) for how each phase calls the simulation.

### Conventions

| Topic | Convention |
|---|---|
| Coordinates | `x` = column (0–39), `y` = row (0–24), origin at the **top-left**. 1 cell = 1 m. |
| Wind direction | `deg` = the direction the wind **blows toward**: 0 = north (up), 90 = east (right), 180 = south, 270 = west. |
| Time | Each `step()` advances simulated time by a fixed amount (demo-accelerated). `t` is in simulated seconds. |
| Victims | `state()["victims"]` lists every victim. Only those with `found: true` are known to the commander and drawn on the map. A victim's `status` is `unknown` (the drone speaks to victims but does not listen), until the commander sets `walking`, `injured` or `no_answer` on the dashboard. |
| Drone | `state()["drone"]` is `null` until `launch_drone()` is called. |
| Fire origin | `start_fire(x, y)` returns the cell it actually used: a click on a wall moves to the nearest open cell. |
| Victim from the webcam | `add_victim_here(conf)` returns the id of a **newly** found or created victim, so the server can queue the voice message. It returns `null` if the drone is not inside, or if that person is already known (no duplicate on the map, no second voice message). |
| IDs | Zones `Z1…`, sensor nodes `N1…`, exit doors `E1…E3`, victims `V1…`. |
| Attack side | `attack_from` is one of `N`, `S`, `E`, `W`. |
| Actions first | `first` lists what to do before attacking (close a gas valve, cut the power). It can be empty. |
| Order label | `at` is a burning cell near the middle of that zone's fire, where the dashboard draws the order number. |
| Look-ahead | `lookahead` compares doing nothing with the chosen attack, 3 minutes ahead: burning m² near the victims and their paths, and burning m² in total. It is `null` until the first test has run. |
| Fire class | `fire_class` is `A`, `B`, `C` or `electrical`. |

### Factory map (`sim/factory.json`)

A 40 × 25 m fictional factory, written as text rows (1 character = 1 cell = 1 m).

| Char | Meaning | Fire class |
|---|---|---|
| `#` | wall | n/a |
| `.` | floor | n/a |
| `E` | exit door | n/a |
| `D` | inner door | n/a |
| `P` | paper / wood stock | A |
| `F` | fuel / solvent | B |
| `G` | gas bottles | C |
| `X` | electrical cabinet | electrical |

Beside the rows, the file holds `zones` (name and rectangle), `exits` (`id`, side, name), `sensors` (`id`, `zone`, `x`, `y`), `victims` (hidden positions for the scenario), `hydrants`, `gas_valves`, `power_cutoffs`, `equipment` (machines, cabinets, extinguishers... with a label) and `demo` (the demo wind).

## The simulation

The simulation is a deterministic, grid-based physical model: it uses a fixed random seed, so every demo run is the same. It runs a fire forecast while the team drives to the site, and later tests the firefighters' options.

### Fire, smoke and gas

- **Fire** is a cellular automaton. At each step, a burning cell can ignite its neighbours. The probability depends on the material (`F` and `G` high, `P` medium-high, `X` medium, bare floor low), rises downwind, is blocked by walls and slowed by doors. Cells burn out after a few steps.
- **Smoke** spreads faster than fire and fills rooms through the doors.
- **Gas** spreads from a `G` cell that is burning or leaking.

Each `step()` is 2 simulated seconds. Stored goods burn for several minutes, so the fire is still active when the plans are made.

### Virtual drone

- It enters by the chosen exit door and flies at **1 m/s**. It always heads for the unexplored cell that is cheapest to reach, so it avoids heat and never flies through flames.
- Its thermal range is **3 cells**, and walls block the view. Every victim within that range is revealed and placed on the map.
- When it finds a victim, it **hovers for 20 seconds** while it speaks to them (safest exit, help is on its way).
- Its temperature follows the radiant heat and the hot smoke around it. **At 60 °C** it switches to `RETURNING`, follows the safest path to the nearest exit, then becomes `OUT`. It also returns once the whole building is explored.

### Safest path (A*)

```
cost(cell) = 1 + heat penalty + smoke penalty + gas penalty
burning cells are blocked
```

### The three plans

| Plan | How it is computed |
|---|---|
| **Evacuation** | For each victim found, the safest path to an exit (the lowest A* cost, not simply the nearest door). A victim who is `injured`, gives `no_answer`, whose state is still `unknown`, or who has no safe way out gets `rescue_first = true`. Only a victim the commander marks `walking` is guided out alone. |
| **Entry** | The exit door whose paths to all the victims found are the safest in total. The path shown leads to the first victim to reach. Before any victim is found, it leads to the edge of the fire. |
| **Extinguishing** | For each burning zone, the agent depends on the fire class: A → water, B → foam, C (gas) → powder, electrical → CO₂. Close the gas valve first if gas bottles burn or are next to the fire, and cut the power first if an electrical cabinet does. Firefighters attack upwind (wind at their back) and from the side away from any victim close to the fire. Order: first the fires that threaten a victim or an evacuation path, then the solvent and gas stores (explosion risk), then the largest. |

The plans are recomputed at every step, so they follow the fire live.

### Testing the attack options (look-ahead)

The rule above says which sides are allowed. The simulator then **tests them**: on copies of the grid, it runs the fire 3 minutes ahead with no attack, and with one attack team from each allowed side, knocking down 0.25 m² per second from that side. It keeps the side that leaves the least fire near the victims and their evacuation paths, then the least fire overall. The test runs again every 10 seconds, or as soon as a new zone catches fire, a victim is found or their state changes, or the wind changes.

Example (fire on the cardboard pallets next to victim V4): with no action, 5 m² of fire reach V4's surroundings within 3 minutes; with the chosen attack from the east, none do.

## The AI model

A **YOLOv8n** person detector fine-tuned on **8,778 real thermal images**. YOLOv8n is small and fast enough for a drone's onboard computer: 3.1 M parameters, a 6.5 MB file, about 8 images per second on a normal laptop CPU without a graphics card.

Results on 1,317 test images it never saw during training:

| | Our model | Same model before thermal training |
|---|---|---|
| mAP@50 | **93.8 %** | 34.9 % |
| Precision at the drone's threshold (confidence ≥ 0.5) | **94.1 %** | |
| Recall at the drone's threshold | **82.9 %** | |

The training notebook, weights, metrics, confusion matrix, example detections and the full model report ([`ai/REPORT.md`](ai/REPORT.md)) are in [`ai/`](ai/).

In the live demo, the laptop webcam stands in for the thermal camera. A pretrained detector finds the person, and the image is recoloured so that it looks thermal. We say this openly: the model itself is trained and tested on real thermal images.

## Prototype vs. real product

| Part | Prototype (this repo) | Real product |
|---|---|---|
| Fixed sensors | One real ESP32 node (gas + temperature + flame) | A sensor node in every zone of the factory |
| Factory map | A hand-made floor plan of a fictional factory (grid) | A drone survey plus the architect's plans of each client factory |
| Fire, smoke, gas | Python simulation on the grid | The same model, refined with real fire data |
| Scout drone | A virtual drone moving on the map | A small caged drone with a heat shield, thermal camera, speaker and mic |
| Thermal camera | AI trained on real thermal images; live demo with a webcam made to look thermal | A real thermal camera on the drone |
| Talking to victims | Laptop speaker (French text-to-speech) | Speaker on the drone (a mic to hear answers is a next step) |
| Drone heat (60 °C) | Simulated drone temperature | A temperature sensor on the drone |
| Three plans | Rules from firefighting practice, plus our simulator testing the options | The same, validated with Protection Civile officers |
| Dashboard | A web page on a laptop | A tablet app for commanders and a page for factories |

## Hardware

| Item | Role |
|---|---|
| ESP32 | The factory's fixed sensor node: reads the sensors and sends alerts over WiFi |
| Gas sensor (MQ-2) | Detects smoke or gas and triggers the alarm |
| Temperature + humidity sensor (DHT11) | Detects heat that rises fast |
| Flame sensor | Detects a flame |
| Red LED + passive buzzer | Local alarm on the node |
| 16×2 LCD (I2C) | Shows temperature, humidity and the alarm on the node |
| Laptop webcam | Stands in for the drone's thermal camera |
| Laptop speaker | The drone's voice |

The node decides `NORMAL` / `WARNING` / `ALARM` from thresholds **and the rate of rise**, so a warm hand does not cause a false alarm. If the WiFi drops, the local alarm keeps working.

## Safety and limits

- **No real fire or smoke** is used in the demo. We test only under the conditions the organizers allow.
- MQ gas sensors need **20+ minutes of warm-up** before their readings mean anything.
- The drone and its thermal camera are simulated in this prototype. The fire model is simplified and not calibrated on real fire data yet.
- Every plan is a **recommendation**. The commander makes the decision.
- Sensor messages are signed (HMAC-SHA256) and every input is checked by the server, so a device on the hotspot cannot fake an alarm.

## License and credits

- **Code and trained model:** [GNU AGPL-3.0](LICENSE). We use [Ultralytics YOLOv8](https://github.com/ultralytics/ultralytics), which is AGPL-3.0, and models trained with it follow the same licence.
- **Thermal training data:** *PersonDection* by SMART2 ([Roboflow Universe](https://universe.roboflow.com/smart2/persondection-61bc2)), distributed as [`Voxel51/Thermal-Person-Detector`](https://huggingface.co/datasets/Voxel51/Thermal-Person-Detector) on Hugging Face, under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).
