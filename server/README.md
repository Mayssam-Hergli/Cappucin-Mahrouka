# server/: hub, dashboard and factory page

The Flask server that every other part talks to, on port 5000.

## Contents

| Item | Role |
|---|---|
| `app.py` | Flask server: the API, the phase machine, the background thread that calls `sim.step()` every 0.5 s |
| `templates/` / `static/` | The Protection Civile dashboard (`/`) and the factory page (`/factory`) |
| `fake_sensor.py` | Sends sensor readings to `/api/sensor` to test without the ESP32 |

## Run

```bash
python server/app.py
```

- Dashboard: `http://SERVER_IP:5000/`
- Factory page: `http://SERVER_IP:5000/factory`

The API and the state format are described in the [main README](../README.md#shared-contract).
