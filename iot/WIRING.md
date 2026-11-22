# Wiring: ESP32-WROOM-32D sensor node (as built and tested)

The ESP32 stays **off the breadboard**, on something non-metallic, powered by USB. Wires go from its pins to a mini breadboard (170 holes, 17 rows × 10 columns, **no power rails**) and to the sensors. Only the **left half (a–e)** is used; some rows act as rails.

Pin labels vary between boards (`D25`, `IO25`, `G25` or `25` are the same pin). Read the label next to each pin, not its position. Avoid GPIO 6–11 (flash chip) and the boot pins 0, 2, 12, 15.

## ESP32 pins

| ESP32 pin | Goes to | Role |
|---|---|---|
| 3V3 (corner next to EN) | a1 → row 1 = **3.3 V** | power |
| 5V (corner next to CMD) | a3 → row 3 = **5 V** | power |
| GND (next to 23) | a5 → row 5 = GND | power |
| GND (between 19 and 21) | a17 → row 17 = GND | power |
| GND (between 12 and 13) | not used | |
| GPIO 33 | a13 | red LED, through its 220 Ω |
| GPIO 32 | buzzer + (direct wire) | passive buzzer |
| GPIO 34 | a12 | gas divider middle (input-only pin) |
| GPIO 4 | DHT11 out (direct wire) | temperature + humidity |
| GPIO 27 | flame DO (direct wire) | LOW = flame |
| GPIO 21 | LCD SDA (direct wire) | I2C |
| GPIO 22 | LCD SCL (direct wire) | I2C |

GPIO 25 and 26 are free.

## Breadboard (rows 1–17, left half a–e; the 5 holes of a half-row are connected)

| Row | What is in it |
|---|---|
| 1 | **3.3 V**: ESP 3V3 (a1), DHT + (c1), flame VCC (d1) |
| 3 | **5 V**: ESP 5V (a3), MQ-2 VCC (b3), LCD VCC (d3) |
| 5 | **GND**: ESP GND (a5), DHT − (b5), flame GND (c5), MQ-2 GND (d5), LCD GND (e5) |
| 8 | MQ-2 AO (a8), 10 kΩ e8 → e12 |
| 12 | GPIO 34 (a12), 10 kΩ end (e12), 20 kΩ start (c12) |
| 13 | GPIO 33 (a13), 220 Ω e13 → e16 |
| 16 | 220 Ω end (e16), red LED long leg (d16) |
| 17 | **GND**: ESP GND (a17), 20 kΩ end (c17), buzzer − (b17), red LED short leg (d17) |

- **Gas divider:** the MQ-2 runs at 5 V, so its AO can reach 5 V. AO → 10 kΩ → row 12 (= GPIO 34) → 20 kΩ → GND brings it to 2/3, at most 3.3 V. The firmware multiplies by 1.5 to get the sensor voltage back. Use the **single 20 kΩ** (c12 → c17): two 10 kΩ in series would collide with the LED's resistor in column e.
- **Red LED:** GPIO 33 (a13) → 220 Ω (e13 → e16) → long leg in d16 → LED → short leg in d17 = GND. HIGH = on.
- **LCD at 5 V on a 3.3 V ESP32:** the backpack's pull-ups go to 5 V. Common and usually fine; if I2C is flaky, lower the clock (`Wire.setClock(50000)`).
- **DHT11 module labels:** many blue modules are labelled `S`, `+`, `−` with **+ in the middle**. Follow the labels: + in row 1, − in row 5, S/out to GPIO 4.

## Parts

| Part | Qty |
|---|---|
| 220 Ω resistor | 1 |
| 10 kΩ resistor | 1 |
| 20 kΩ resistor | 1 |
| Female–male and female–female wires | ~15 |

## Before plugging in the USB

- [ ] Rows 1 (3.3 V) and 3 (5 V) hold only their own wires: nothing from them touches GND.
- [ ] The MQ-2 and the LCD are on 5 V (row 3); the DHT and the flame sensor on 3.3 V (row 1).
- [ ] The 20 kΩ is in place (c12 → c17): without it, GPIO 34 sees the full 5 V signal.
- [ ] The red LED has its long leg in d16 and its short leg in d17.

Then run the bench test [`hw_test/hw_test.ino`](hw_test/hw_test.ino), and flash the firmware with a filled-in `secrets.h` (see [README.md](README.md)). Let the MQ-2 warm up 20+ minutes, then press **EN** so the node measures clean air.

If anything smells hot or gets very hot, unplug the USB at once and check the list again.

## Troubleshooting

| Symptom | Check first |
|---|---|
| LCD dark, no backlight | LCD VCC in row 3 (5 V), GND in row 5, 5V wire to a3 |
| LCD lit, no text | Contrast screw on the back; I2C address (the bench test scans it) |
| Red LED never lights | Long leg d16, short leg d17; resistor e13 → e16; GPIO 33 wire in a13 |
| Buzzer only rattles | It is passive: it needs `tone()`, not a plain HIGH |
| Temperature always NaN | Out wire on GPIO 4; + in row 1, − in row 5; module labels (+ may be in the middle) |
| Flame never changes | DO on GPIO 27; turn the module's sensitivity screw |
| Gas stuck at ~140 mV (the ESP32's lowest reading = 0 V at the pin) | MQ-2 warm and LED lit; AO (not DO) in a8; 10 kΩ e8 → e12; GPIO 34 wire in a12; 20 kΩ c12 → c17 |
| Gas stuck near the top | 20 kΩ missing: unplug and fix (risk for the pin) |
| Board resets or gets hot | Unplug at once; look for 3.3 V or 5 V touching GND |
