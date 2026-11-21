# sim/: simulation and plans

A pure Python module with no web code and no dependency outside the standard library (matplotlib is only for the viewer). The server imports it and calls `step()` every 0.5 s.

## Files

| File | Role |
|---|---|
| `factory.json` | The fictional 40 × 25 m factory: grid rows, zones, exits, sensors, hidden victims, hydrants, gas valve, power cutoff |
| `__init__.py` | Exports `Sim` |
| `sim.py` | The `Sim` class, the only public interface |
| `grid.py` | Loads `factory.json`: cell types, zones, movement rules |
| `hazards.py` | Fire (cellular automaton), smoke and gas spread with wind, radiant heat |
| `pathfinding.py` | A* safest path (heat, smoke and gas penalties; burning cells blocked) |
| `drone.py` | The virtual drone: exploration, 3-cell thermal range, talking hover, temperature, 60 °C return |
| `plans.py` | Evacuation, entry and extinguishing plans |
| `viewer.py` | A matplotlib viewer to run the whole scenario without the server |
| `figures.py` | Writes the slide images to `docs/simulation/` (`python -m sim.figures`) |

## Interface

```python
from sim import Sim

sim = Sim("sim/factory.json")
sim.start_fire(x, y)                     # returns the cell actually used
sim.set_wind(kmh, deg)
sim.launch_drone("E2")
sim.step()                               # returns the ids of victims found during this step
sim.add_victim_here(conf)                # returns the victim id found or created
sim.set_victim_status("V1", "walking")   # walking | injured | no_answer
sim.state()

# helpers
sim.map_info()                           # static map for the dashboard, without the hidden victims
sim.forecast(minutes=5)                  # {minutes, fire, burnt, smoke, gas}
sim.guidance("V1")                       # {victim, exit, distance_m, doors, say}
sim.set_drone_temp(temp)                 # optional real reading for the drone
```

Every 10 s (or when the situation changes) `step()` also tests the attack options 3 minutes ahead, which makes that step take up to about 250 ms instead of about 30. If the server's laptop struggles, set `sim.lookahead = False`: the plans then use the rule alone.

`state()` and the helpers return only JSON-ready types (dicts, lists, numbers, strings), so the server can pass them straight to `jsonify`. Every method is thread-safe.

See the [main README](../README.md#shared-contract) for the state format and the conventions.

## How the server uses it

### Importing from `server/app.py`

`python server/app.py` puts `server/` on the import path, not the repo root, so add the root first:

```python
import os, sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from sim import Sim

sim = Sim("sim/factory.json")   # works whatever folder the server is started from
```

### Phase by phase

| Phase | What the server calls |
|---|---|
| Start-up | `sim = Sim(...)`, then `sim.map_info()` once to serve the map to the dashboard and the factory page |
| `ALERT` | Nothing yet. The sensor's `zone` (`Z1`…`Z4`) and `node` (`N1`…`N4`) match `factory.json`. |
| `CONFIRMED` | `sim.start_fire(x, y)` with the origin clicked on the factory page; `sim.set_wind(kmh, deg)` from the slider |
| `EN_ROUTE` | `sim.forecast(5)` once to show where the fire is heading. Start the background thread that calls `sim.step()` every 0.5 s, so the fire grows while the team drives. |
| `DRONE_INSIDE` | `sim.launch_drone(entry)`. Each victim id returned by `sim.step()` or `sim.add_victim_here()` is newly found: queue `sim.guidance(id)["say"]` for `/api/voice/next`. On `/api/voice`, call `sim.set_victim_status(id, status)`. |
| `PLANS_READY` | When `state()["drone"]["state"] == "OUT"`, which covers both the drone overheating and the building being fully explored |

### Drawing tips for the dashboard

- Draw only the victims with `found: true`. The others are hidden until the drone sees them.
- `drone` is `null` until the drone is launched.
- `plans.entry.door` is already set before the drone goes in: it is the door with the safest path to the edge of the fire.
- Draw each extinguishing order number at its `at` cell.

## Run alone

```bash
python -m sim.viewer                                          # live animation of the demo scenario
python -m sim.viewer --origin 34 20 --wind 10 270 --entry E2  # fire origin, wind and drone entry door
python -m sim.viewer --save run.png --steps 20 60 100 130     # snapshots side by side
```
