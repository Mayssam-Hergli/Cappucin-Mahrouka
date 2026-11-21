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
7. [Shared contract](#shared-contract)
8. [The simulation](#the-simulation)
9. [The AI model](#the-ai-model)
10. [Prototype vs. real product](#prototype-vs-real-product)
11. [Hardware](#hardware)
12. [Safety and limits](#safety-and-limits)

---

## The problem

When a factory burns, firefighters arrive without knowing what is inside, who is trapped or where the danger is. Intervention plans are often on paper, out of date or missing. Thick smoke hides everything, and workers die from smoke and toxic gas while firefighters search room by room.

## Our solution

- **Fixed sensors** already installed in the factory detect fire or gas and raise an alarm on the Protection Civile dashboard.
- **A false-alarm check.** The Protection Civile calls the factory, which confirms or cancels the alarm and says where the fire started.
- **A live map.** While the team drives to the site, the factory map and a fire forecast load on the dashboard.
- **A scout drone** flies in first. Its **thermal camera** and an **AI person detector** find trapped people through the smoke and place them on the map.
- **The drone talks to victims** through a speaker: it gives them the nearest exit, tells them help is coming, and listens for their answer (*can walk* or *injured*).
- **Heat safety.** At **60 °C** the drone flies to the nearest exit by itself.
- **Three plans** once the scan is done:
  - **Evacuation**: the safest route out for each victim, with injured or silent victims flagged *rescue first*.
  - **Entry**: the best door for the firefighters to go in and reach the victims safely.
  - **Extinguishing**: where to start, from which side, and with what (water, foam, CO₂ or powder), plus whether to close the gas valve or cut the power first.

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
        VOI[voice/<br/>text-to-speech + microphone]
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
    VOI -- "GET /api/voice/next<br/>POST /api/voice" --> SRV
    DASH -- "GET /api/state every 500 ms<br/>POST /api/drone/launch" --> SRV
```

| Part | Folder | Language | Talks to the server via |
|---|---|---|---|
| Sensor node | `iot/` | Arduino C++ (ESP32) | `POST /api/sensor` every second |
| Factory page | `server/` | HTML + JS | `POST /api/factory/confirm` |
| Dashboard | `server/` | HTML + canvas + JS | `GET /api/state`, `POST /api/drone/launch` |
| Server and phase machine | `server/` | Python, Flask | n/a (it is the hub) |
| Simulation and plans | `sim/` | Python | imported directly by the server |
| Vision | `vision/` | Python, OpenCV, YOLOv8 | `POST /api/vision` |
| Voice | `voice/` | Python, pyttsx3, SpeechRecognition | `GET /api/voice/next`, `POST /api/voice` |
| AI model | `ai/` | Python, Ultralytics (Colab) | offline: training and evaluation only |

## Repository layout

```
.
├── ai/        Thermal person detector: training notebook, weights, metrics, report
├── vision/    Fake-thermal webcam script (the drone's camera)
├── voice/     Text-to-speech + microphone script (the drone's voice)
├── sim/       Factory map, fire / smoke / gas spread, virtual drone, A*, the three plans
├── server/    Flask server, Protection Civile dashboard, factory page, fake sensor
├── iot/       ESP32 sensor node firmware
├── docs/      Reports, empathy map, slides, video
├── requirements.txt
└── README.md
```

Each folder has its own `README.md` with the details of that part.

## Getting started

### Prerequisites

- Python 3.10 or newer
- Arduino IDE (or PlatformIO) with ESP32 board support, if you use the hardware node
- A webcam, a speaker and a microphone for the vision and voice parts
- Every device on the same network (a 2.4 GHz hotspot, because the ESP32 has no 5 GHz)

### Install

```bash
git clone https://github.com/Mayssam-Hergli/Hrika.git
cd Hrika
python -m venv .venv
# Windows: .venv\Scripts\activate    macOS / Linux: source .venv/bin/activate
pip install -r requirements.txt
```

### Run the demo

Replace `SERVER_IP` with the IP address of the laptop that runs the server.

```bash
# 1. The hub (opens the dashboard at http://SERVER_IP:5000 and the factory page at /factory)
python server/app.py

# 2. A sensor alarm, either from the real ESP32 (see iot/) or from the fake sensor:
python server/fake_sensor.py --server http://SERVER_IP:5000

# 3. The drone's camera and voice, on any laptop on the network:
python vision/fake_thermal.py --server http://SERVER_IP:5000
python voice/voice.py --server http://SERVER_IP:5000
```

### Run the simulation alone (no server)

```bash
python -m sim.viewer                                         # live animation of the demo scenario
python -m sim.viewer --origin 34 20 --wind 10 270            # choose the fire origin and the wind
python -m sim.viewer --save fire.png --steps 0 40 120 250    # snapshots side by side
```

This shows the fire, smoke and gas spreading, the drone exploring, and the three plans.

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
| `POST` | `/api/voice` | Voice script | `{victim, heard, status: walking\|injured\|no_answer}` |
| `GET` | `/api/state` | Dashboard (polls every 500 ms) | the full state, below |

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
    "extinguish": [{"zone": "Z3", "fire_class": "B", "agent": "foam", "attack_from": "W", "order": 1}]
  },
  "events": ["12:03 ALARM zone Z2 (gas)", "..."]
}
```

### Simulation interface (`sim/`)

```python
from sim import Sim

sim = Sim("sim/factory.json")
sim.start_fire(x, y)                    # fire origin given by the factory
sim.set_wind(kmh, deg)                  # wind slider on the dashboard
sim.launch_drone("E2")                  # entry door chosen on the dashboard
sim.step()                              # called every 0.5 s by the server
sim.add_victim_here(conf)               # the webcam saw a person at the drone's position
sim.set_victim_status("V1", "injured")  # walking | injured | no_answer
sim.state()                             # dict = the state above, without "phase" and "events"
```

### Conventions

| Topic | Convention |
|---|---|
| Coordinates | `x` = column (0–39), `y` = row (0–24), origin at the **top-left**. 1 cell = 1 m. |
| Wind direction | `deg` = the direction the wind **blows toward**: 0 = north (up), 90 = east (right), 180 = south, 270 = west. |
| Time | Each `step()` advances simulated time by a fixed amount (demo-accelerated). `t` is in simulated seconds. |
| Victims | `state()["victims"]` lists every victim. Only those with `found: true` are known to the commander and drawn on the map. A victim's `status` is `unknown` until they answer the drone, then `walking`, `injured` or `no_answer`. |
| Drone | `state()["drone"]` is `null` until `launch_drone()` is called. |
| Fire origin | `start_fire(x, y)` returns the cell it actually used: a click on a wall moves to the nearest open cell. |
| Victim from the webcam | `add_victim_here(conf)` returns the victim id it found or created (or `null` if the drone is not inside), so the server can queue the voice message. |
| IDs | Zones `Z1…`, sensor nodes `N1…`, exit doors `E1…E3`, victims `V1…`. |
| Attack side | `attack_from` is one of `N`, `S`, `E`, `W`. |

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

Beside the rows, the file holds `zones` (name and rectangle), `sensors` (`id`, `zone`, `x`, `y`), `victims` (hidden positions for the scenario) and `hydrants`.

## The simulation

The simulation is a deterministic, grid-based physical model: it uses a fixed random seed, so every demo run is the same. It runs a fire forecast while the team drives to the site, and later tests the firefighters' options.

### Fire, smoke and gas

- **Fire** is a cellular automaton. At each step, a burning cell can ignite its neighbours. The probability depends on the material (`F` and `G` high, `P` medium-high, `X` medium, bare floor low), rises downwind, is blocked by walls and slowed by doors. Cells burn out after a few steps.
- **Smoke** spreads faster than fire and fills rooms through the doors.
- **Gas** spreads from a `G` cell that is burning or leaking.

### Virtual drone

- It enters by the chosen exit door and explores: it always goes to the nearest unexplored cell it can reach.
- Its thermal range is **3 cells**. Every victim within that range is revealed and placed on the map.
- Its temperature rises near burning cells and drops elsewhere. **At 60 °C** it switches to `RETURNING`, follows A* to the nearest exit, then becomes `OUT`. It also returns once the whole building is explored.

### Safest path (A*)

```
cost(cell) = 1 + heat penalty + smoke penalty + gas penalty
burning cells are blocked
```

### The three plans

| Plan | How it is computed |
|---|---|
| **Evacuation** | For each victim found, A* to the nearest safe exit. A victim who is `injured` or gives `no_answer` gets `rescue_first = true`. |
| **Entry** | The exit door whose paths to the victims are the safest, meaning the lowest total A* cost. |
| **Extinguishing** | For each burning zone, the agent depends on the fire class: A → water, B → foam, C (gas) → close the gas valve, then powder, electrical → cut the power, then CO₂. Firefighters attack upwind, from the side away from the victims. Order: first protect the victims' paths, then the `F` and `G` stores (explosion risk), then the rest. |

When there is time, each attack option is simulated a few minutes ahead on a copy of the grid, and the option that leaves the least fire near the victims is kept.

## The AI model

A **YOLOv8n** person detector fine-tuned on a public dataset of **real thermal images**. YOLOv8n is small and fast enough for a drone's onboard computer. The training notebook, weights, metrics (precision, recall, mAP@50, confusion matrix, example detections) and the full model report are in [`ai/`](ai/).

In the live demo, the laptop webcam stands in for the thermal camera. A pretrained detector finds the person, and the image is recoloured so that it looks thermal. We say this openly: the model itself is trained and tested on real thermal images.

## Prototype vs. real product

| Part | Prototype (this repo) | Real product |
|---|---|---|
| Fixed sensors | One real ESP32 node (gas + temperature + flame) | A sensor node in every zone of the factory |
| Factory map | A hand-made floor plan of a fictional factory (grid) | A drone survey plus the architect's plans of each client factory |
| Fire, smoke, gas | Python simulation on the grid | The same model, refined with real fire data |
| Scout drone | A virtual drone moving on the map | A small caged drone with a heat shield, thermal camera, speaker and mic |
| Thermal camera | AI trained on real thermal images; live demo with a webcam made to look thermal | A real thermal camera on the drone |
| Talking to victims | Laptop speaker and microphone | Speaker and mic on the drone |
| Drone heat (60 °C) | Simulated drone temperature | A temperature sensor on the drone |
| Three plans | Rules from firefighting practice, plus our simulator testing the options | The same, validated with Protection Civile officers |
| Dashboard | A web page on a laptop | A tablet app for commanders and a page for factories |

## Hardware

| Item | Role |
|---|---|
| ESP32 | The factory's fixed sensor node: reads the sensors and sends alerts over WiFi |
| Gas sensor (MQ-2 / MQ-135) | Detects smoke or gas and triggers the alarm |
| Temperature sensor (DHT22 / DHT11) | Detects heat that rises fast |
| Flame sensor (optional) | Detects a flame |
| Buzzer + green / yellow / red LEDs | Local alarm on the node |
| Laptop webcam | Stands in for the drone's thermal camera |
| Laptop speaker + microphone | The drone's voice |

The node decides `NORMAL` / `WARNING` / `ALARM` from thresholds **and the rate of rise**, so a warm hand does not cause a false alarm. If the WiFi drops, the local alarm keeps working.

## Safety and limits

- **No real fire or smoke** is used in the demo. We test only under the conditions the organizers allow.
- MQ gas sensors need **20+ minutes of warm-up** before their readings mean anything.
- The drone and its thermal camera are simulated in this prototype. The fire model is simplified and not calibrated on real fire data yet.
- Every plan is a **recommendation**. The commander makes the decision.
