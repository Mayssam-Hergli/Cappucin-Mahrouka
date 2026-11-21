# Handover: Hrika sensor node hardware, wiring and bench test

> **To Claude:** read this whole file first. The user has wired the Hrika sensor node (ESP32 + sensors + LEDs + buzzer + I2C LCD) by hand, following the wiring below. Your job, in two stages:
> 1. **Now:** write a **hardware self-test sketch**, compile and upload it to the ESP32, and walk the user through checking every part. The LCD must show **`CHA3ALNI`**.
> 2. **Later:** when the team gives you the actual demo script, flash it on the same hardware with the same pins (section 7).
>
> Explain your plan in a few lines before writing code.

---

## 1. Working rules (from the user, keep them)

- **Never commit or push.** Make the changes; the user commits and pushes.
- **No Claude attribution anywhere:** no `Co-Authored-By` lines, no "Generated with Claude" in files, commits, READMEs or comments.
- **Do not change the wiring plan** in this file. If something looks wrong on the hardware side, tell the user what to check; don't invent new pins.
- **Do not use these ESP32 pins:** CLK, D0–D3, CMD (GPIO 6–11, the flash chip), and avoid the boot strapping pins 0, 2, 12, 15.
- You cannot see the board. For anything visual (LEDs, LCD, buzzer sound), the sketch prints what should happen and **asks the user to confirm** in the Serial Monitor or in chat.
- Keep the test sketch **separate** from the real firmware `iot/hrika_node/hrika_node.ino`. Do not modify the firmware unless the user asks (see section 7).

---

## 2. The hardware

| Part | Notes |
|---|---|
| ESP32 dev board, **ESP-WROOM-32D**, 38 pins (DevKitC layout) | Tested on its own with Arduino IDE: it works. Sits **outside** the breadboard, on a non-metal surface. Powered by USB (micro-USB). Has a **5V** pin (next to CMD) and **3 GND pins**. |
| Mini breadboard, 170 holes, **no power rails** | 17 rows × 10 columns. Some rows are used as rails (see section 3). |
| **LCD 16×2 with I2C backpack** (PCF8574) | 4 pins: GND, VCC, SDA, SCL. **Not** an OLED. Powered at **5 V**. I2C address usually **0x27** or **0x3F**: scan first. Contrast set by the blue potentiometer on the back. |
| Gas sensor **MQ-2** module | Powered at **5 V**. Uses AO only, through a voltage divider (10 kΩ + 20 kΩ). DO not connected. Needs ~20 min warm-up for stable readings. |
| **DHT22** module (3 pins: +, out, −) | 3.3 V. |
| **Flame sensor** module | 3.3 V. Uses DO only (most modules: **LOW = flame detected**; check). |
| 3 LEDs: green, yellow, red | Each with a 220 Ω resistor to GND. |
| Buzzer | Wired directly to the GPIO (no transistor). Probably active: check by driving it HIGH; if it only clicks, it's passive → use `tone()` / LEDC. |

---

## 3. Wiring (as built)

### ESP32 pin map

| ESP32 pin | Goes to | Direction |
|---|---|---|
| 3V3 (corner next to EN) | breadboard **a1** → row 1 left = **3.3 V rail** | power |
| 5V (corner next to CMD) | breadboard **a3** → row 3 left = **5 V rail** | power |
| GND (next to 23) | breadboard **a5** → row 5 left = GND | power |
| GND (between 12 and 13) | breadboard **f9** → row 9 right = GND | power |
| GND (between 19 and 21) | breadboard **a17** → row 17 left = GND. Alternative that is also fine: a male–male jumper **g9 → a17** (left from an earlier plan) | power |
| **GPIO 25** | green LED + (f1) | output |
| **GPIO 26** | yellow LED + (f4) | output |
| **GPIO 33** | red LED + (f14) | output |
| **GPIO 32** | buzzer + (direct wire) | output |
| **GPIO 34** | gas divider middle (a12) | analog input (input-only pin, no pull-up) |
| **GPIO 4** | DHT22 out (direct wire) | DHT data |
| **GPIO 27** | flame DO (direct wire) | digital input |
| **GPIO 21** | LCD SDA (direct wire) | I2C SDA |
| **GPIO 22** | LCD SCL (direct wire) | I2C SCL |

### Breadboard (rows 1–17 top to bottom; left half a–e, right half f–j; the 5 holes of one half-row are connected)

| Row | Left half (a–e) | Right half (f–j) |
|---|---|---|
| 1 | 3.3 V: ESP 3V3 (a1), DHT + (c1), flame VCC (d1) | GPIO 25 (f1), green LED long leg (g1) |
| 2 | — | green LED short leg (g2), 220 Ω j2 → j9 |
| 3 | 5 V: ESP 5V (a3), MQ VCC (b3), LCD VCC (d3) | — |
| 4 | — | GPIO 26 (f4), yellow LED long leg (g4) |
| 5 | GND: ESP GND (a5), DHT − (b5), flame GND (c5), MQ GND (d5), LCD GND (e5) | yellow LED short leg (g5), 220 Ω i5 → i9 |
| 8 | MQ AO (a8), 10 kΩ e8 → e12 | — |
| 9 | — | GND: ESP GND (f9), ends of the three 220 Ω (j9, i9, h9); g9 may hold the optional jumper to a17 |
| 12 | GPIO 34 (a12), 10 kΩ end (e12), 20 kΩ start (c12) | — |
| 13 | — | red LED short leg (g13), 220 Ω h13 → h9 |
| 14 | — | GPIO 33 (f14), red LED long leg (g14) |
| 15 | only if 2 × 10 kΩ replace the 20 kΩ: c12 → c15, e15 → e17 | — |
| 17 | GND: ESP GND or jumper from g9 (a17), 20 kΩ end (c17), buzzer − (b17) | — |

### What follows from the wiring

- **Gas reading:** GPIO 34 sees `V_AO × 20 / (10 + 20)` = 2/3 of the sensor output. 5 V at AO → 3.33 V at the pin. To get the sensor voltage back: `V_AO = V_pin × 1.5`. Use `analogReadMilliVolts(34)` on ESP32 (calibrated) rather than raw `analogRead`.
- **LEDs:** HIGH = on (anode on the GPIO, cathode → 220 Ω → GND).
- **LCD at 5 V on a 3.3 V ESP32:** the backpack's pull-ups go to 5 V. It's a common setup and usually fine; the user accepted it for the night. If I2C is flaky, suggest lowering the clock (`Wire.setClock(50000)`) before anything else.
- **Buzzer straight on a GPIO:** fine for a small buzzer; keep beeps short in the test.

---

## 4. The task: a hardware self-test sketch

Create **`iot/hw_test/hw_test.ino`** (Arduino IDE needs the folder and file to share a name). It should:

1. **Serial at 115200**, print a short banner and what will be tested.
2. **I2C scan** on SDA 21 / SCL 22 (`Wire.begin(21, 22)`). Print every address found. Pick the LCD address automatically (0x27 or 0x3F, or the only device found). If nothing is found, print what to check (VCC/GND on the LCD, SDA/SCL swapped, wires seated) and continue with the other tests.
3. **LCD:** init, backlight on, clear, show **`CHA3ALNI`** centred on line 1 (and e.g. `Hrika test` on line 2). Ask the user: "Do you see CHA3ALNI? If the screen is lit but empty, turn the blue screw on the back slowly."
4. **LEDs:** green, yellow, red one at a time (1 s each), printing which one should be on; then all three together; then off.
5. **Buzzer:** two short beeps (100 ms). Print "you should hear two beeps".
6. **DHT22:** read temperature and humidity a few times (≥ 2 s apart, DHT22 limit). Print values; a `NaN` means a wiring or library problem.
7. **Flame sensor:** print the DO level every 500 ms for ~10 s and ask the user to hold a lighter flame near it (or cover/uncover it): the value should flip. Most modules are LOW on flame; there's also a sensitivity screw on the module.
8. **Gas MQ-2:** print GPIO 34 in mV and the reconstructed AO voltage (× 1.5) every second for ~10 s. Remind the user it needs ~20 min of warm-up to settle; any number that moves is already a sign it's alive.
9. **Summary** at the end: one line per part (`OK` / `CHECK` based on what could be measured: I2C found, DHT read not NaN, gas reading not stuck at 0 or 4095 mV range limits), then loop: LCD keeps `CHA3ALNI`, live readings on Serial every 2 s.

Keep it a single readable file, pin numbers as named constants at the top, matching section 3.

### Libraries

- **LiquidCrystal I2C** (Frank de Brabander). On ESP32 it may print an "architecture" warning: it still works. Alternative if it fails to compile: **LiquidCrystal_PCF8574** or **hd44780** (`hd44780_I2Cexp`, auto-detects the address).
- **DHT sensor library** (Adafruit) + **Adafruit Unified Sensor**.
- `Wire` (built in).

---

## 5. Compiling and uploading

The user is on **Windows**. Prefer `arduino-cli` if it's installed; otherwise give the user the Arduino IDE steps.

```bash
arduino-cli core update-index
arduino-cli core install esp32:esp32
arduino-cli lib install "LiquidCrystal I2C" "DHT sensor library" "Adafruit Unified Sensor"
arduino-cli board list                          # find the COM port of the ESP32
arduino-cli compile --fqbn esp32:esp32:esp32 iot/hw_test
arduino-cli upload  --fqbn esp32:esp32:esp32 -p COMx iot/hw_test
arduino-cli monitor -p COMx -c baudrate=115200
```

- Board: **ESP32 Dev Module** (`esp32:esp32:esp32`).
- If upload hangs at `Connecting....`: hold the **BOOT** button on the board until the upload starts.
- No COM port at all: the USB cable may be charge-only, or the CP210x / CH340 driver is missing (check the chip on the board near the USB port).
- Close the Serial Monitor before uploading (it holds the port).

---

## 6. Troubleshooting map

| Symptom | Check first |
|---|---|
| LCD dark, no backlight | LCD VCC in row 3 (5 V) and GND in row 5; 5V wire to a3; USB plugged? |
| LCD lit, no text | Contrast screw; wrong I2C address (use the scan result) |
| I2C scan finds nothing | SDA/SCL swapped (21 = SDA, 22 = SCL); LCD GND; loose female ends |
| An LED never lights | LED reversed (long leg must be in the GPIO row: 1, 4, 14); resistor not reaching row 9; GND wire to f9 |
| DHT22 always NaN | out wire on GPIO 4; + in row 1, − in row 5; wait 2 s after power-up |
| Flame never changes | DO on GPIO 27; adjust the module's sensitivity screw |
| Gas stuck at 0 mV | AO in a8, both resistors, GPIO 34 wire in row 12, GND reaching row 17 |
| Gas stuck near max | 20 kΩ missing → the pin sees the full 5 V signal: unplug and fix (risk for the pin) |
| Board resets / gets hot | Unplug USB at once. Look for 3.3 V or 5 V touching GND (rows 1 and 3 must hold only their own wires). |

---

## 7. Next: the actual demo script

The team will hand you the demo script (the real firmware for the pitch) later. When it arrives:

1. **Pins:** it must use exactly the pin map of section 3. Put every pin in one clearly marked block at the top of each sketch (`// --- pins (see HANDOVER-hardware.md) ---`) so the test sketch and the demo script stay identical on this point. If the demo script uses other pins, point it out and adapt the script, never the wiring.
2. **Display:** the old firmware `iot/hrika_node/hrika_node.ino` was written for a 0.96" SSD1306 **OLED**. The hardware has a **16×2 I2C LCD**: use the LCD library and the I2C address that worked in the test.
3. **Never block on a missing part:** if the LCD or the DHT22 fails to start, the node must carry on and still send its alarm (no `for(;;)` after a failed `begin()`).
4. **Settings for the real run:** `IN_WOKWI = false`, the hotspot SSID and password, `SERVER_URL = "http://<server IP>:5000/api/sensor"` (the laptop running the server, same Wi-Fi). Ask the user for these; don't guess them.
5. **Check end to end:** compile, upload, open the Serial Monitor, confirm the node connects to Wi-Fi and that the server receives the readings, then trigger the flame sensor and confirm the alarm reaches the dashboard.

Ask the user before modifying `iot/hrika_node/hrika_node.ino` or any file outside `iot/`.
