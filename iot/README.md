# iot/: ESP32 sensor node

The factory's fixed sensor. It starts the whole scenario.

## Hardware

- ESP32
- Gas sensor MQ-2 / MQ-135 (20+ min warm-up)
- DHT22 / DHT11 temperature sensor
- Flame sensor (optional)
- Buzzer + green / yellow / red LEDs
- OLED 0.96" I2C screen (SSD1306, 128×64): SDA → GPIO 21, SCL → GPIO 22, VCC → 3.3V

Full wiring, connection by connection: [WIRING.md](WIRING.md).

## Behaviour

- Reads gas, temperature (and how fast it rises) and the flame sensor.
- Decides `NORMAL` / `WARNING` / `ALARM` from thresholds and the rate of rise, so a warm hand does not cause a false alarm.
- Drives the LEDs and the buzzer locally. The local alarm keeps working if the WiFi drops.
- Shows its status on the OLED (node, zone, WiFi, level, gas, temperature) plus a message line set by `OLED_MESSAGE` in the settings (placeholder for now). Without the screen, the node keeps working.
- Every second, sends:

```
POST http://SERVER_IP:5000/api/sensor
{"node": "N1", "zone": "Z2", "gas": 1830, "temp": 31.2, "flame": 0, "level": "ALARM", "cause": "gas"}
```

`node` and `zone` must match a sensor declared in `sim/factory.json`: `N1`/`Z2` (default), `N2`/`Z1`, `N3`/`Z3`, `N4`/`Z4`.
When the level is `NORMAL`, `cause` is `"none"`; otherwise it is `"gas"`, `"temp"` or `"flame"`.

`gas` is sent on the server's common scale (the same as `server/fake_sensor.py`): **300 = clean air, 900 = warning, 1500 = alarm**. The node measures its own clean-air baseline at start-up and converts the raw MQ reading, so the dashboard's zone analysis agrees with the node's level, whatever the sensor's raw range.

## Simulate in Wokwi (no hardware needed)

**Live simulation:** https://wokwi.com/projects/481306010649524225

The same firmware runs in the [Wokwi](https://wokwi.com) ESP32 simulator, with a virtual gas sensor, DHT22, flame sensor, LEDs and buzzer. Wokwi's flame sensor has no control during a simulation, so it always reads "no flame"; the flame rule is tested on the real hardware.

| File | Paste into Wokwi tab |
|---|---|
| [`hrika_node/hrika_node.ino`](hrika_node/hrika_node.ino) | `sketch.ino` |
| [`wokwi/diagram.json`](wokwi/diagram.json) | `diagram.json` |
| [`wokwi/libraries.txt`](wokwi/libraries.txt) | `libraries.txt` (`DHT sensor library`, `Adafruit Unified Sensor`, `Adafruit GFX Library`, `Adafruit SSD1306`) |

Press Play, then click a sensor to move its slider:

- Raise the gas ppm, and the node goes `WARNING` then `ALARM (gas)`.
- Raise the temperature fast (+5 °C in 10 s), and you get `ALARM (temp)`, even below 50 °C.
- Raise it slowly (a warm hand), and it stays `NORMAL`.

The simulated ESP32 reaches the internet through Wokwi, so it cannot reach a private `192.168.x.x` address. Expose the server with a tunnel (`cloudflared tunnel --url http://localhost:5000`) and set `SERVER_URL` to `https://<tunnel>.trycloudflare.com/api/sensor`.

## Flash

Open [`hrika_node/hrika_node.ino`](hrika_node/hrika_node.ino) in the Arduino IDE. In the settings block at the top, set `IN_WOKWI = false`, the WiFi credentials and `SERVER_URL = "http://SERVER_IP:5000/api/sensor"`. Then select the ESP32 board and upload.
