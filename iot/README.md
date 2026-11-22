# iot/: ESP32 sensor node

The factory's fixed sensor. It starts the whole scenario.

## Hardware (as built and tested)

| Part | Pin | Notes |
|---|---|---|
| ESP32-WROOM-32D dev board (38 pins) | | Off the breadboard, powered by USB |
| Gas sensor MQ-2 | GPIO 34 | 5 V; AO through a 10 kΩ + 20 kΩ divider (the pin sees 2/3 of AO). 20+ min warm-up |
| Temperature + humidity DHT11 | GPIO 4 | Blue module, 3.3 V |
| Flame sensor | GPIO 27 | DO, **LOW = flame**; 3.3 V |
| LCD 16×2 with I2C backpack | SDA 21, SCL 22 | Address **0x27**, 5 V |
| Red LED + 220 Ω | GPIO 33 | The only LED |
| Passive buzzer | GPIO 32 | Needs `tone()`: a plain HIGH only rattles |

Full wiring, hole by hole: [WIRING.md](WIRING.md). Bench test sketch (checks every part one by one): [`hw_test/hw_test.ino`](hw_test/hw_test.ino).

## Behaviour

- Reads gas, temperature (and how fast it rises), humidity and the flame sensor.
- Decides `NORMAL` / `WARNING` / `ALARM` from thresholds and the rate of rise, so a warm hand does not cause a false alarm.
- A flickering flame makes the sensor's output toggle hundreds of times: the node holds the flame alarm 3 s after the last detection.
- Local alarm, working without WiFi:

| Level | Red LED | Buzzer | LCD line 2 |
|---|---|---|---|
| `NORMAL` | off | silent | `Gas: normal` |
| `WARNING` | slow blink | silent | `Gas: rising` / `Temp: rising` |
| `ALARM` | steady | fast beeps | `FLAME DETECTED!` / `GAS DETECTED!` / `HEAT ALARM!` |

  LCD line 1 shows temperature and humidity (`T 24.1C  H 58%`), with a `W` at the end when WiFi is up. Without the LCD or the DHT, the node keeps working and still sends its alarm.
- Every second, sends:

```
POST http://SERVER_IP:5000/api/sensor
{"node": "N1", "zone": "Z2", "gas": 1830, "temp": 31.2, "flame": 0, "level": "ALARM", "cause": "gas"}
```

`node` must match a sensor declared in `sim/factory.json`: `N1` (default, zone `Z2`), `N2`, `N3`, `N4`. The server takes the zone from that file.
When the level is `NORMAL`, `cause` is `"none"`; otherwise it is `"gas"`, `"temp"` or `"flame"`.

`gas` is sent on the server's common scale (the same as `server/fake_sensor.py`): **300 = clean air, 900 = warning, 1500 = alarm**. The node measures its own clean-air baseline at start-up (in mV of sensor output) and converts the reading, so the dashboard's zone analysis agrees with the node's level. A start-up baseline above 1500 mV is not believed (the node was started in gas or smoke): it is capped, so gas cannot hide itself by being there at boot.

## Settings and secrets

The WiFi password and the node key never go into the sketch or the repo:

1. Copy [`hrika_node/secrets.example.h`](hrika_node/secrets.example.h) to `hrika_node/secrets.h` (git-ignored).
2. Fill in the hotspot name and password (2.4 GHz) and `HRIKA_SERVER_URL = "http://SERVER_IP:5000/api/sensor"`, the IP of the laptop running `server/app.py`.

With `secrets.h` present, the sketch runs in real-hardware mode. Without it (as in Wokwi), it uses the Wokwi settings.

### Signed messages (optional)

The server can refuse forged or replayed sensor messages (see `server/security.py`):

```
python server/security.py new-key N1      # on the laptop: creates the key, prints it
```

Paste the 64 hex characters into `HRIKA_NODE_KEY_HEX` in `secrets.h`, then restart the server. Each message then carries `X-Hrika-Time`, `X-Hrika-Seq` and `X-Hrika-Sig` (HMAC-SHA256 of `time.seq.body`). The node sets its clock from the server's replies, so it needs no internet time. With an empty key, messages are unsigned and the server accepts them as long as it has no key file.

## Flash

Arduino IDE (or `arduino-cli`), board **ESP32 Dev Module**, libraries **LiquidCrystal I2C** (Frank de Brabander; an "architecture" warning on ESP32 is harmless), **DHT sensor library** and **Adafruit Unified Sensor**.

```
arduino-cli compile --fqbn esp32:esp32:esp32 iot/hrika_node
arduino-cli upload  --fqbn esp32:esp32:esp32 -p COMx iot/hrika_node
```

Let the MQ-2 warm up 20+ minutes, then press **EN** so the node measures clean air.

## Simulate in Wokwi (no hardware needed)

**Live simulation:** https://wokwi.com/projects/481306010649524225

The same firmware runs in the [Wokwi](https://wokwi.com) ESP32 simulator, with a virtual gas sensor, DHT22 (Wokwi has no DHT11; the sketch switches type by itself), flame sensor, red LED, buzzer and I2C LCD. Wokwi's flame sensor has no control during a simulation, so it always reads "no flame"; the flame rule is tested on the real hardware.

| File | Paste into Wokwi tab |
|---|---|
| [`hrika_node/hrika_node.ino`](hrika_node/hrika_node.ino) | `sketch.ino` |
| [`wokwi/diagram.json`](wokwi/diagram.json) | `diagram.json` |
| [`wokwi/libraries.txt`](wokwi/libraries.txt) | `libraries.txt` (`DHT sensor library`, `Adafruit Unified Sensor`, `LiquidCrystal I2C`) |

Do not add a `secrets.h` in Wokwi: without it the sketch uses `Wokwi-GUEST`.

### Wokwi wiring

| Part | Pin → ESP32 |
|---|---|
| Gas sensor | VCC → 3V3, GND → GND, AOUT → 34 |
| DHT22 | VCC → 3V3, GND → GND, SDA → 4 |
| Flame sensor | VCC → 3V3, GND → GND, DOUT → 27 |
| Red LED | A → 33, C → GND |
| Buzzer | 2 → 32, 1 → GND |
| LCD 1602 (I2C) | VCC → 5V, GND → GND, SDA → 21, SCL → 22 |

The GPIO pins are the same as on the real board. Only these details differ, and the sketch adapts to them by itself:

| | Wokwi | Real hardware ([WIRING.md](WIRING.md)) |
|---|---|---|
| Breadboard | none, parts wired straight to the ESP32 | rows used as 3.3 V, 5 V and GND rails |
| Gas sensor power | 3V3 | 5 V |
| Gas divider (10 kΩ + 20 kΩ) | not needed (factor 1.0) | needed (factor 1.5) |
| Temperature sensor | DHT22 | DHT11 |
| LED resistor (220 Ω) | not needed | needed |
| Flame sensor | cannot be triggered | works |

Press Play, then click a sensor to move its slider:

- Raise the gas ppm, and the node goes `WARNING` then `ALARM (gas)`.
- Raise the temperature fast (+5 °C in 10 s), and you get `ALARM (temp)`, even below 50 °C.
- Raise it slowly (a warm hand), and it stays `NORMAL`.

The simulated ESP32 reaches the internet through Wokwi, so it cannot reach a private `192.168.x.x` address. Expose **only** the sensor route if you can, keep the tunnel short-lived, and preferably sign the messages: `cloudflared tunnel --url http://localhost:5000`, then set `SERVER_URL` in the sketch's Wokwi block to `https://<tunnel>.trycloudflare.com/api/sensor`. For the real demo, use the local network, not a tunnel.
