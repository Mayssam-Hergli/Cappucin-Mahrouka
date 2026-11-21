# sim/: simulation and plans

A pure Python module with no web code. The server imports it and calls `step()` every 0.5 s.

## Files

| File | Role |
|---|---|
| `factory.json` | The fictional 40 × 25 m factory: grid rows, zones, sensors, hidden victims, hydrants |
| `__init__.py` | Exports `Sim` |
| `sim.py` | The `Sim` class, the only public interface |
| `grid.py` | Loads `factory.json`: cell types, zones, neighbours |
| `hazards.py` | Fire (cellular automaton), smoke and gas spread, with wind |
| `pathfinding.py` | A* safest path (heat, smoke and gas penalties; burning cells blocked) |
| `drone.py` | The virtual drone: exploration, 3-cell thermal range, temperature, 60 °C return |
| `plans.py` | Evacuation, entry and extinguishing plans |
| `viewer.py` | A matplotlib viewer to run the simulation without the server |

## Interface

```python
from sim import Sim

sim = Sim("sim/factory.json")
sim.start_fire(x, y)
sim.set_wind(kmh, deg)
sim.launch_drone("E2")
sim.step()
sim.add_victim_here(conf)
sim.set_victim_status("V1", "walking")   # walking | injured | no_answer
sim.state()
```

`state()` returns only JSON-serialisable types (dicts, lists, ints, floats, strings), so the server can pass it straight to `jsonify`.

See the [main README](../README.md#shared-contract) for the state format and the conventions.

## Run alone

```bash
python -m sim.viewer
```
