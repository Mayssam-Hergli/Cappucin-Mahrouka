# iot/: ESP32 sensor node

The factory's fixed sensor. It starts the whole scenario.

## Hardware

- ESP32
- Gas sensor MQ-2 / MQ-135 (20+ min warm-up)
- DHT22 / DHT11 temperature sensor
- Flame sensor (optional)
- Buzzer + green / yellow / red LEDs

## Behaviour

- Reads gas, temperature (and how fast it rises) and the flame sensor.
- Decides `NORMAL` / `WARNING` / `ALARM` from thresholds and the rate of rise, so a warm hand does not cause a false alarm.
- Drives the LEDs and the buzzer locally. The local alarm keeps working if the WiFi drops.
- Every second, sends:

```
POST http://SERVER_IP:5000/api/sensor
{"node": "N1", "zone": "Z2", "gas": 1830, "temp": 31.2, "flame": 0, "level": "ALARM", "cause": "gas"}
```

`node` and `zone` must match a sensor declared in `sim/factory.json`.

## Flash

Open the firmware in the Arduino IDE, set the WiFi credentials and `SERVER_IP`, select the ESP32 board and upload.
