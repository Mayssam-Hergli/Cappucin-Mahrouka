// Hrika sensor node: hardware self-test.
// Checks every part of the bench wiring one by one, prints what should happen,
// and shows CHA3ALNI on the LCD. Separate from the real firmware (iot/hrika_node).
//
// Serial Monitor at 115200. After the full run, type a letter + Enter to repeat a test:
//   a = run everything again   s = I2C scan   l = LEDs   b = buzzer
//   d = DHT22                  f = flame      g = gas

#include <Wire.h>
#include <LiquidCrystal_I2C.h>
#include <DHT.h>
#include "driver/rtc_io.h"

// --- pins (see HANDOVER-hardware.md) ---
const int PIN_LED_GREEN  = 25;
const int PIN_LED_YELLOW = 26;
const int PIN_LED_RED    = 33;
const int PIN_BUZZER     = 32;
const int PIN_GAS        = 34;   // input-only, gas divider middle (2/3 of MQ-2 AO)
const int PIN_DHT        = 4;
const int PIN_FLAME      = 27;   // flame module DO
const int PIN_SDA        = 21;
const int PIN_SCL        = 22;
// --- end of pins ---

const float GAS_DIVIDER = 1.5;   // V_AO = V_pin x (10k + 20k) / 20k
const char *LCD_TEXT    = "CHA3ALNI";

const uint8_t DHT_TYPE  = DHT11;  // blue module = DHT11 (a white one would be DHT22)
DHT dht(PIN_DHT, DHT_TYPE);
LiquidCrystal_I2C *lcd = nullptr;
uint8_t lcdAddr = 0;

// results for the summary
bool okI2C = false, okDHT = false, okGas = false, flameChanged = false;
int flameIdle = -1;

void line() { Serial.println(F("------------------------------------------------")); }

// ---------- I2C + LCD ----------

void scanI2C() {
  line();
  Serial.println(F("[1] I2C scan on SDA 21 / SCL 22"));
  int found = 0;
  uint8_t first = 0;
  lcdAddr = 0;
  for (uint8_t a = 1; a < 127; a++) {
    Wire.beginTransmission(a);
    if (Wire.endTransmission() == 0) {
      Serial.printf("    device found at 0x%02X\n", a);
      if (!first) first = a;
      if (a == 0x27 || a == 0x3F) lcdAddr = a;
      found++;
    }
  }
  if (!lcdAddr && found == 1) lcdAddr = first;
  okI2C = lcdAddr != 0;
  if (found == 0) {
    Serial.println(F("    NOTHING found. Check: LCD VCC in row 3 (5 V), LCD GND in row 5,"));
    Serial.println(F("    SDA on GPIO 21 and SCL on GPIO 22 (not swapped), female ends seated."));
  } else if (okI2C) {
    Serial.printf("    LCD address: 0x%02X\n", lcdAddr);
  } else {
    Serial.println(F("    devices found but none at 0x27/0x3F: not sure which one is the LCD."));
  }
}

void showLcd() {
  line();
  Serial.println(F("[2] LCD"));
  if (!okI2C) { Serial.println(F("    skipped (no LCD on the I2C bus)")); return; }
  if (!lcd) { lcd = new LiquidCrystal_I2C(lcdAddr, 16, 2); lcd->init(); }
  lcd->backlight();
  lcd->clear();
  lcd->setCursor((16 - strlen(LCD_TEXT)) / 2, 0);
  lcd->print(LCD_TEXT);
  lcd->setCursor(3, 1);
  lcd->print("Hrika test");
  Serial.println(F("    >>> Do you see CHA3ALNI on line 1 and 'Hrika test' on line 2?"));
  Serial.println(F("    If the screen is lit but empty, turn the blue screw on the back slowly."));
}

// ---------- LEDs + buzzer ----------

void allLeds(bool on) {
  digitalWrite(PIN_LED_GREEN, on);
  digitalWrite(PIN_LED_YELLOW, on);
  digitalWrite(PIN_LED_RED, on);
}

void testLeds() {
  line();
  Serial.println(F("[3] LEDs, one second each"));
  const int pins[3] = {PIN_LED_GREEN, PIN_LED_YELLOW, PIN_LED_RED};
  const char *names[3] = {"GREEN  (GPIO 25)", "YELLOW (GPIO 26)", "RED    (GPIO 33)"};
  allLeds(false);
  for (int i = 0; i < 3; i++) {
    Serial.printf("    now ON: %s\n", names[i]);
    digitalWrite(pins[i], HIGH);
    delay(1000);
    digitalWrite(pins[i], LOW);
  }
  Serial.println(F("    now ON: all three"));
  allLeds(true);
  delay(1000);
  allLeds(false);
  Serial.println(F("    all off"));
  checkLedPaths();
}

// Electrical check without looking: with the internal pull-up on, a pin whose LED reaches GND
// sits at the LED's forward voltage (~1.6-2.4 V); an open path (no GND, LED reversed) floats up to ~3.1 V.
void checkLedPaths() {
  Serial.println(F("    electrical check of each LED path (pin -> LED -> 220R -> GND):"));
  const int pins[3] = {PIN_LED_GREEN, PIN_LED_YELLOW, PIN_LED_RED};
  const char *names[3] = {"green ", "yellow", "red   "};
  for (int i = 0; i < 3; i++) {
    analogReadMilliVolts(pins[i]);                  // switches the pin to the ADC (pulls off)
    rtc_gpio_pullup_en((gpio_num_t)pins[i]);
    rtc_gpio_pulldown_dis((gpio_num_t)pins[i]);
    delay(20);
    int mv = analogReadMilliVolts(pins[i]);
    rtc_gpio_pullup_dis((gpio_num_t)pins[i]);
    const char *verdict = mv < 300  ? "inconclusive (pull-up did not engage)"
                        : mv < 2700 ? "path to GND OK"
                                    : "OPEN: no path to GND (LED reversed, resistor not in row 9, or row 9 not on GND)";
    Serial.printf("      %s GPIO %d: %4d mV  -> %s\n", names[i], pins[i], mv, verdict);
    pinMode(pins[i], OUTPUT);
    digitalWrite(pins[i], LOW);
  }
}

void testBuzzer() {
  line();
  Serial.println(F("[4] Buzzer"));
  Serial.println(F("    A: two short beeps, pin held HIGH (active buzzer)"));
  for (int i = 0; i < 2; i++) { digitalWrite(PIN_BUZZER, HIGH); delay(100); digitalWrite(PIN_BUZZER, LOW); delay(250); }
  delay(800);
  Serial.println(F("    B: two short beeps, 2 kHz tone (passive buzzer)"));
  for (int i = 0; i < 2; i++) { tone(PIN_BUZZER, 2000, 100); delay(350); }
  noTone(PIN_BUZZER);
  digitalWrite(PIN_BUZZER, LOW);
  Serial.println(F("    >>> Which pair did you hear clearly: A, B, or both?"));
}

// ---------- sensors ----------

void testDht() {
  line();
  Serial.printf("[5] %s, 3 readings 2.5 s apart\n", DHT_TYPE == DHT11 ? "DHT11" : "DHT22");
  int good = 0;
  for (int i = 0; i < 3; i++) {
    delay(2500);
    float t = dht.readTemperature(), h = dht.readHumidity();
    if (isnan(t) || isnan(h)) Serial.println(F("    NaN (no answer)"));
    else { Serial.printf("    %.1f C   %.1f %% humidity\n", t, h); good++; }
  }
  okDHT = good > 0;
  if (okDHT) return;

  // diagnostics: is the module's pull-up holding the data line HIGH? (= powered and wired to GPIO 4)
  pinMode(PIN_DHT, INPUT_PULLDOWN);
  delay(5);
  int idle = digitalRead(PIN_DHT);
  Serial.printf("    data line with the ESP32 pull-down: %s\n", idle ? "HIGH (module powered, wire reaches GPIO 4)"
                                                                    : "LOW (module not powered, or out wire not on GPIO 4)");
  // raw handshake: pull the line LOW 20 ms (DHT11 needs >= 18), release, count answer edges for 6 ms
  pinMode(PIN_DHT, OUTPUT);
  digitalWrite(PIN_DHT, LOW);
  delay(20);
  pinMode(PIN_DHT, INPUT_PULLUP);
  int edges = 0, last = HIGH;
  unsigned long t0 = micros();
  while (micros() - t0 < 6000) { int v = digitalRead(PIN_DHT); if (v != last) { edges++; last = v; } }
  Serial.printf("    raw handshake: %d edges (about 80 = the sensor talks, 0 = silent)\n", edges);
  delay(2000);
  // try the other type in case the colour is misleading
  uint8_t other = DHT_TYPE == DHT11 ? DHT22 : DHT11;
  DHT alt(PIN_DHT, other);
  alt.begin();
  delay(2500);
  float ta = alt.readTemperature(), ha = alt.readHumidity();
  if (!isnan(ta)) Serial.printf("    answers as a %s: %.1f C %.0f %% -> change DHT_TYPE\n", other == DHT11 ? "DHT11" : "DHT22", ta, ha);
  else Serial.printf("    no answer as a %s either\n", other == DHT11 ? "DHT11" : "DHT22");
  dht.begin();
  Serial.println(F("    Check: out wire on GPIO 4, + in row 1 (3.3 V), - in row 5 (GND), pins in the right order."));
}

void testFlame() {
  line();
  Serial.println(F("[6] Flame sensor (DO on GPIO 27), 10 s"));
  Serial.println(F("    >>> Hold a lighter flame near the sensor now (or point a phone torch at it)."));
  flameIdle = digitalRead(PIN_FLAME);
  int prev = flameIdle, flips = 0;
  for (int i = 0; i < 20; i++) {
    int v = digitalRead(PIN_FLAME);
    if (v != prev) flips++;
    prev = v;
    Serial.printf("    DO = %d %s\n", v, v == LOW ? "(LOW: flame on most modules)" : "(HIGH)");
    delay(500);
  }
  flameChanged = flips > 0;
  Serial.printf("    level changed %d time(s)\n", flips);
  // power check: an unpowered module cannot hold DO HIGH against the ESP32 pull-down
  pinMode(PIN_FLAME, INPUT_PULLDOWN);
  delay(5);
  int held = digitalRead(PIN_FLAME);
  pinMode(PIN_FLAME, INPUT);
  Serial.printf("    DO with the ESP32 pull-down: %s\n", held ? "HIGH (module powered: row 1 has 3.3 V)"
                                                         : "LOW (flame module not powered, or DO not on GPIO 27)");
  if (!flameChanged) Serial.println(F("    Never changed: check DO on GPIO 27, then turn the module's sensitivity screw."));
}

int gasMv() { return analogReadMilliVolts(PIN_GAS); }

void testGas() {
  line();
  Serial.println(F("[7] Gas MQ-2 (GPIO 34 through the divider), 10 s"));
  Serial.println(F("    Needs ~20 min of warm-up to settle; a number that moves is already a good sign."));
  int lo = 99999, hi = 0;
  for (int i = 0; i < 10; i++) {
    int mv = gasMv();
    lo = min(lo, mv); hi = max(hi, mv);
    Serial.printf("    pin %4d mV   ->  sensor AO %.2f V\n", mv, mv * GAS_DIVIDER / 1000.0);
    delay(1000);
  }
  okGas = lo > 20 && hi < 3100;
  if (lo <= 20) Serial.println(F("    Stuck near 0: check AO in a8, both resistors, GPIO 34 wire in row 12, GND in row 17."));
  if (hi >= 3100) Serial.println(F("    Near the top of the range: is the 20k in place? Unplug and check (risk for the pin)."));
}

// ---------- summary + loop ----------

void summary() {
  line();
  Serial.println(F("SUMMARY"));
  Serial.printf("  I2C / LCD  : %s\n", okI2C ? "OK (found), confirm CHA3ALNI is visible" : "CHECK");
  Serial.println(F("  LEDs       : confirm by eye (green, yellow, red, all)"));
  Serial.println(F("  Buzzer     : confirm by ear (A = active, B = passive)"));
  Serial.printf("  DHT        : %s\n", okDHT ? "OK" : "CHECK");
  Serial.printf("  Flame      : %s (idle level %d)\n", flameChanged ? "OK, level changed" : "CHECK, never changed", flameIdle);
  Serial.printf("  Gas MQ-2   : %s\n", okGas ? "OK, in range" : "CHECK");
  line();
  Serial.println(F("Live readings every 2 s. Type a, s, l, b, d, f or g + Enter to repeat a test."));
}

void runAll() {
  scanI2C();
  showLcd();
  testLeds();
  testBuzzer();
  testDht();
  testFlame();
  testGas();
  summary();
}

void setup() {
  Serial.begin(115200);
  delay(1500);
  pinMode(PIN_LED_GREEN, OUTPUT);
  pinMode(PIN_LED_YELLOW, OUTPUT);
  pinMode(PIN_LED_RED, OUTPUT);
  pinMode(PIN_BUZZER, OUTPUT);
  digitalWrite(PIN_BUZZER, LOW);
  allLeds(false);
  pinMode(PIN_FLAME, INPUT);
  analogSetPinAttenuation(PIN_GAS, ADC_11db);   // full 0 to ~3.1 V range
  Wire.begin(PIN_SDA, PIN_SCL);
  Wire.setClock(100000);
  dht.begin();

  Serial.println();
  line();
  Serial.println(F("HRIKA HARDWARE SELF-TEST"));
  Serial.println(F("Tests: I2C scan, LCD, 3 LEDs, buzzer, DHT11, flame, gas MQ-2"));
  runAll();
}

void loop() {
  if (Serial.available()) {
    char c = Serial.read();
    switch (c) {
      case 'a': runAll(); break;
      case 's': scanI2C(); showLcd(); break;
      case 'l': testLeds(); break;
      case 'b': testBuzzer(); break;
      case 'd': testDht(); break;
      case 'f': testFlame(); break;
      case 'g': testGas(); break;
    }
  }

  // LEDs blink together in the live loop, so a wiring fix shows at once
  static unsigned long lastBlink = 0;
  static bool ledsOn = false;
  if (millis() - lastBlink >= 1000) { lastBlink = millis(); ledsOn = !ledsOn; allLeds(ledsOn); }

  static unsigned long last = 0;
  if (millis() - last >= 2000) {
    last = millis();
    float t = dht.readTemperature(), h = dht.readHumidity();
    int mv = gasMv(), fl = digitalRead(PIN_FLAME);
    Serial.printf("live  T %s C  H %s %%  gas %4d mV (AO %.2f V)  flame DO %d\n",
                  isnan(t) ? "NaN" : String(t, 1).c_str(), isnan(h) ? "NaN" : String(h, 0).c_str(),
                  mv, mv * GAS_DIVIDER / 1000.0, fl);
    if (lcd) {
      char buf[17];
      snprintf(buf, sizeof buf, "%-5s G%4d F%d  ", isnan(t) ? "--" : String(t, 1).c_str(), mv, fl);
      lcd->setCursor(0, 1);
      lcd->print(buf);
    }
  }
}
