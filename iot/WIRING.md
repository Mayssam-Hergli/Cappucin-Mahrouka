# Wiring: ESP32-WROOM-32D sensor node

The ESP32 stays **off the breadboard**. Wires go from its pins to the breadboard and the sensors. The breadboard holds the LEDs, the buzzer, the gas-sensor divider and the power rails. The rails are needed because the ESP32 has a single 3V3 pin.

Pin labels vary between boards (`D25`, `IO25`, `G25` or `25` are the same pin). Read the label next to each pin, not its position. Put the ESP32 on something non-metallic.

## Wires

| Connection | Wire type |
|---|---|
| ESP32 → breadboard | female–male |
| Sensor / OLED → breadboard | female–male |
| Sensor / OLED → ESP32 directly | female–female |

## Breadboard power rails

| ESP32 pin | Breadboard | Becomes |
|---|---|---|
| 3V3 | top red rail | **3.3V** rail |
| GND | top blue rail | GND |
| VIN (5V) | bottom red rail | **5V** rail |
| another GND | bottom blue rail | GND |

The two red rails must never touch (3.3V and 5V). If a rail is split in the middle of the breadboard, bridge it with a short wire.

## Every connection

| # | From | To | Notes |
|---|---|---|---|
| 1 | ESP32 3V3 | top red rail (3.3V) | |
| 2 | ESP32 GND | top blue rail | |
| 3 | ESP32 VIN | bottom red rail (5V) | |
| 4 | ESP32 GND (another pin) | bottom blue rail | |
| 5 | ESP32 GPIO 25 | g30 | green LED: long leg f30, short leg f31 |
| 6 | j31 | bottom blue rail | 220 Ω resistor |
| 7 | ESP32 GPIO 26 | g34 | yellow LED: long leg f34, short leg f35 |
| 8 | j35 | bottom blue rail | 220 Ω resistor |
| 9 | ESP32 GPIO 33 | g38 | red LED: long leg f38, short leg f39 |
| 10 | j39 | bottom blue rail | 220 Ω resistor |
| 11 | ESP32 GPIO 32 | g42 | buzzer + leg in f42 |
| 12 | j45 | bottom blue rail | buzzer − leg in f45 |
| 13 | b50 | b54 | 10 kΩ resistor (gas divider) |
| 14 | c54 | top blue rail | 20 kΩ resistor (or 2 × 10 kΩ in series) |
| 15 | ESP32 GPIO 34 | d54 | gas signal after the divider |
| 16 | MQ-2 VCC | bottom red rail (**5V**) | |
| 17 | MQ-2 GND | bottom blue rail | |
| 18 | MQ-2 AO | a50 | DO not connected |
| 19 | DHT22 + | top red rail (3.3V) | |
| 20 | DHT22 − | top blue rail | |
| 21 | DHT22 out | ESP32 GPIO 4 | female–female. Bare 4-leg sensor: add 10 kΩ between DATA and 3.3V |
| 22 | Flame VCC | top red rail (3.3V) | |
| 23 | Flame GND | top blue rail | |
| 24 | Flame DO | ESP32 GPIO 27 | female–female. AO not connected |
| 25 | OLED VCC | top red rail (3.3V) | check the labels: pin order varies |
| 26 | OLED GND | top blue rail | |
| 27 | OLED SDA | ESP32 GPIO 21 | female–female |
| 28 | OLED SCL | ESP32 GPIO 22 | female–female |

The gas divider brings the MQ-2's 5V signal down to about 3.3V for the ESP32:
AO → 10 kΩ → column 54 (= GPIO 34) → 20 kΩ → GND.

## ESP32 pins used

| ESP32 pin | Goes to |
|---|---|
| 3V3 | top red rail |
| GND | top blue rail |
| VIN | bottom red rail |
| GND | bottom blue rail |
| GPIO 4 | DHT22 out |
| GPIO 21 | OLED SDA |
| GPIO 22 | OLED SCL |
| GPIO 25 | green LED |
| GPIO 26 | yellow LED |
| GPIO 27 | flame DO |
| GPIO 32 | buzzer + |
| GPIO 33 | red LED |
| GPIO 34 | gas divider (column 54) |

## Parts

| Part | Qty |
|---|---|
| Female–male wires | ~17 |
| Female–female wires | 5 |
| Male–male wires | ~2 |
| 220 Ω resistors | 3 |
| 10 kΩ resistors | 1 (2 if there is no 20 kΩ) |
| 20 kΩ resistor | 1 |

## Before plugging in the USB

- [ ] Nothing goes from 3V3 or VIN straight to GND.
- [ ] The two red rails are not connected to each other.
- [ ] The two blue rails are connected (wire 4).
- [ ] The MQ-2 is on 5V; everything else is on 3.3V.
- [ ] Each LED has its long leg toward the GPIO.
- [ ] The OLED's VCC and GND match the labels on the screen.

Then upload the firmware with `IN_WOKWI = false`, the hotspot name and password, and `SERVER_URL = "http://SERVER_IP:5000/api/sensor"`. Let the MQ-2 warm up 20+ minutes, then press **EN** so the node measures clean air.

If anything smells hot or gets very hot, unplug the USB at once and check the list again.
