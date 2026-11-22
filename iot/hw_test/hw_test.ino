// Hrika sensor node: hardware self-test.
// Built on the combined bench sketch (alarm = flame or gas above baseline -> red LED + buzzer + LCD),
// with guided checks first. Separate from the real firmware (iot/hrika_node).
//
// Serial Monitor at 115200. On boot: every check once, a summary, then the alarm loop with live
// readings every 2 s. Type a letter + Enter:
//   a = run every check again     S = summary
//   s = I2C scan + LCD            l = red LED check     R = LED held on    O = LED off
//   b = two beeps                 B = two beeps every 2 s   x = stop beeping   P = switch active / passive
//   d = DHT                        f = flame, 10 s readout   F = reset the flame change counter
//   g = gas, 10 s (also resets the gas baseline)            m = mute / unmute the alarm buzzer

#include <Wire.h>
#include <LiquidCrystal_I2C.h>
#include <DHT.h>
#include "driver/rtc_io.h"

// --- pins (see HANDOVER-hardware.md) ---
const int PIN_RED    = 33;   // a13 -> 220R (e13-e16) -> LED d16 -> d17 = GND
const int PIN_BUZZER = 32;
const int PIN_FLAME  = 27;   // flame module DO
const int PIN_GAS    = 34;   // input-only, gas divider middle (2/3 of MQ-2 AO)
const int PIN_DHT    = 4;
const int PIN_SDA    = 21;
const int PIN_SCL    = 22;
// --- end of pins ---

const uint8_t LCD_ADDR      = 0x27;   // found by the scan on this board; the scan stays as a fallback
bool          activeBuzzer  = false;  // passive buzzer (confirmed: plain HIGH only rattles, 2 kHz tone is clean); P switches
const int     GAS_ALARM_DELTA = 300;  // mV of sensor output (AO) above the clean-air baseline = gas alarm
const uint8_t DHT_TYPE      = DHT11;  // the blue module answers as a DHT11 (the other type is tried if no answer)

DHT dht(PIN_DHT, DHT_TYPE);
LiquidCrystal_I2C *lcd = nullptr;
uint8_t lcdAddr = 0;

// results for the summary
bool okI2C = false, okDHT = false, okGas = false, ledPathOk = false;
bool flamePowered = false, flameChanged = false;
int  flameIdle = HIGH;          // level with no flame, learned at boot
int  gasBaseline = 0;           // AO mV in clean air

// background state
bool beepRepeat = false, muted = false, ledHeld = false;
unsigned long lastBeepCycle = 0, flameFlips = 0;
int  flameLast = -1;

void line() { Serial.println(F("------------------------------------------------")); }

void buzz(bool on) {
  if (activeBuzzer) digitalWrite(PIN_BUZZER, on);
  else if (on) tone(PIN_BUZZER, 2000); else noTone(PIN_BUZZER);
}
void beeps(int n) { for (int i = 0; i < n; i++) { buzz(true); delay(100); buzz(false); delay(200); } }

int gasPinMv()  { return analogReadMilliVolts(PIN_GAS); }
int gasAoMv()   { return gasPinMv() * 3 / 2; }          // divider undone: AO = pin x 1.5
bool flameNow() { return digitalRead(PIN_FLAME) != flameIdle; }

// ---------- 1-2. I2C + LCD ----------

void scanI2C() {
  line();
  Serial.println(F("[1] I2C scan on SDA 21 / SCL 22"));
  int found = 0;
  uint8_t first = 0;
  bool sawDefault = false;
  for (uint8_t a = 1; a < 127; a++) {
    Wire.beginTransmission(a);
    if (Wire.endTransmission() == 0) {
      Serial.printf("    device found at 0x%02X\n", a);
      if (!first) first = a;
      if (a == LCD_ADDR) sawDefault = true;
      found++;
    }
  }
  lcdAddr = sawDefault ? LCD_ADDR : (found ? first : 0);
  okI2C = lcdAddr != 0;
  if (!found) {
    Serial.println(F("    NOTHING found. Check: LCD VCC in row 3 (5 V), LCD GND in row 5,"));
    Serial.println(F("    SDA on GPIO 21 and SCL on GPIO 22 (not swapped), female ends seated."));
  } else {
    Serial.printf("    LCD address used: 0x%02X%s\n", lcdAddr, sawDefault ? "" : " (not the hard-coded one: update LCD_ADDR)");
  }
}

void showLcd() {
  line();
  Serial.println(F("[2] LCD"));
  if (!okI2C) { Serial.println(F("    skipped (no LCD on the I2C bus)")); return; }
  if (!lcd) { lcd = new LiquidCrystal_I2C(lcdAddr, 16, 2); lcd->init(); }
  lcd->backlight();
  lcd->clear();
  lcd->setCursor(1, 0);
  lcd->print("Hrika node");
  lcd->setCursor(1, 1);
  lcd->print("self-test...");
  Serial.println(F("    >>> The LCD shows 'Hrika node / self-test...' during the checks, then temperature,"));
  Serial.println(F("        humidity and gas status. Lit but empty: turn the blue screw on the back slowly."));
}

// ---------- 3. red LED ----------

// Electrical check without looking: with the internal pull-up on, the pin sits at the LED's
// forward voltage (~1.6-2.4 V) when the path to GND is complete, ~3.1 V when it is open.
void checkLedPath() {
  analogReadMilliVolts(PIN_RED);
  rtc_gpio_pullup_en((gpio_num_t)PIN_RED);
  rtc_gpio_pulldown_dis((gpio_num_t)PIN_RED);
  delay(20);
  int mv = analogReadMilliVolts(PIN_RED);
  rtc_gpio_pullup_dis((gpio_num_t)PIN_RED);
  pinMode(PIN_RED, OUTPUT);
  digitalWrite(PIN_RED, LOW);
  ledPathOk = mv >= 300 && mv < 2700;
  Serial.printf("    electrical check (GPIO 33 -> 220R -> LED -> row 17): %d mV -> %s\n", mv,
                mv < 300 ? "inconclusive" : mv < 2700 ? "path to GND OK" : "OPEN, no path to GND");
  if (mv >= 2700) {
    Serial.println(F("    Check: long leg in d16, short leg in d17, resistor e13 -> e16, GPIO 33 wire in a13."));
    Serial.println(F("    Test without code: a wire from ESP 3V3 into a13 (in place of the GPIO 33 wire) must light it."));
  }
}

void testLed() {
  line();
  Serial.println(F("[3] Red LED (GPIO 33): on 1 s / off 1 s, three times, then fast blinking for 2 s"));
  for (int i = 0; i < 3; i++) {
    Serial.printf("    ON  (%d/3)\n", i + 1);  digitalWrite(PIN_RED, HIGH); delay(1000);
    Serial.println(F("    off"));             digitalWrite(PIN_RED, LOW);  delay(1000);
  }
  Serial.println(F("    fast blinking"));
  for (int i = 0; i < 10; i++) { digitalWrite(PIN_RED, i % 2 == 0); delay(100); }
  for (int i = 0; i < 10; i++) { digitalWrite(PIN_RED, i % 2 == 0); delay(100); }
  digitalWrite(PIN_RED, LOW);
  checkLedPath();
}

// ---------- 4. buzzer ----------

void testBuzzer() {
  line();
  Serial.printf("[4] Buzzer (GPIO 32, %s): you should hear two beeps\n", activeBuzzer ? "active" : "passive");
  beeps(2);
}

// ---------- 5. DHT22 ----------

void testDht() {
  line();
  Serial.println(F("[5] DHT on GPIO 4, 3 readings 2.5 s apart"));
  int good = 0;
  for (int i = 0; i < 3; i++) {
    delay(2500);
    float t = dht.readTemperature(), h = dht.readHumidity();
    if (isnan(t) || isnan(h)) Serial.println(F("    NaN (no answer)"));
    else { Serial.printf("    %.1f C   %.1f %% humidity\n", t, h); good++; }
  }
  okDHT = good > 0;
  if (okDHT) return;
  uint8_t other = DHT_TYPE == DHT22 ? DHT11 : DHT22;
  DHT alt(PIN_DHT, other);
  alt.begin();
  delay(2500);
  float ta = alt.readTemperature();
  if (!isnan(ta)) Serial.printf("    answers as a %s (%.1f C): change DHT_TYPE\n", other == DHT11 ? "DHT11" : "DHT22", ta);
  dht.begin();
  Serial.println(F("    Check: out wire on GPIO 4, + in row 1, - in row 5, wait 2 s after power-up."));
}

// ---------- 6. flame ----------

void checkFlamePower() {
  pinMode(PIN_FLAME, INPUT_PULLDOWN);
  delay(5);
  flamePowered = digitalRead(PIN_FLAME) == HIGH || flameIdle == LOW;
  pinMode(PIN_FLAME, INPUT);
}

void testFlame() {
  line();
  Serial.println(F("[6] Flame sensor (DO on GPIO 27), 10 s"));
  Serial.printf("    no-flame level learned at boot: %s, so flame = %s\n",
                flameIdle == HIGH ? "HIGH" : "LOW", flameIdle == HIGH ? "LOW" : "HIGH");
  Serial.println(F("    >>> Hold a lighter flame near the sensor now: the value should flip."));
  int prev = digitalRead(PIN_FLAME), flips = 0;
  for (int i = 0; i < 20; i++) {
    int v = digitalRead(PIN_FLAME);
    if (v != prev) flips++;
    prev = v;
    Serial.printf("    DO = %d %s\n", v, v != flameIdle ? "<- FLAME" : "");
    delay(500);
  }
  if (flips) flameChanged = true;
  Serial.printf("    level changed %d time(s)\n", flips);
  if (!flips) Serial.println(F("    Never changed: DO on GPIO 27? Then turn the module's sensitivity screw."));
}

// ---------- 7. gas ----------

void testGas() {
  line();
  Serial.println(F("[7] Gas MQ-2 (GPIO 34 through the divider), 10 s, also sets the clean-air baseline"));
  Serial.println(F("    Needs ~20 min of warm-up to settle; a number that moves is already a good sign."));
  long sum = 0;
  int lo = 99999, hi = 0;
  for (int i = 0; i < 10; i++) {
    int pin = gasPinMv(), ao = pin * 3 / 2;
    sum += ao; lo = min(lo, pin); hi = max(hi, pin);
    Serial.printf("    pin %4d mV  ->  sensor AO %4d mV\n", pin, ao);
    delay(1000);
  }
  gasBaseline = sum / 10;
  // the ESP32 ADC cannot read below ~140 mV: a pin at 0 V reports ~142 mV, flat
  int avgPin = gasBaseline * 2 / 3;
  okGas = avgPin >= 170 && hi < 3100;
  Serial.printf("    baseline %d mV (AO); gas alarm above %d mV\n", gasBaseline, gasBaseline + GAS_ALARM_DELTA);
  if (avgPin < 170) {
    Serial.println(F("    Stuck at the ADC floor (~142 mV = the pin sees 0 V): no signal from the MQ-2."));
    Serial.println(F("    Check: MQ-2 power LED lit and the sensor warm (VCC b3, GND d5), AO in a8,"));
    Serial.println(F("    10k e8 -> e12, GPIO 34 wire in a12, 20k c12 -> c17."));
  }
  if (hi >= 3100) Serial.println(F("    Near the top: is the 20k in place (c12 -> c17)? Unplug and check (risk for the pin)."));
}

// ---------- summary ----------

void summary() {
  line();
  Serial.println(F("SUMMARY"));
  Serial.printf("  I2C / LCD : %s (address 0x%02X)\n", okI2C ? "OK" : "CHECK", lcdAddr);
  Serial.printf("  Red LED   : %s\n", ledPathOk ? "OK (electrical path)" : "CHECK (no path to GND)");
  Serial.printf("  Buzzer    : confirm by ear (%s)\n", activeBuzzer ? "active, plain HIGH" : "passive, 2 kHz tone");
  Serial.printf("  DHT11     : %s\n", okDHT ? "OK" : "CHECK");
  Serial.printf("  Flame     : %s, flame = %s, %s\n", flamePowered ? "powered" : "NOT powered",
                flameIdle == HIGH ? "LOW" : "HIGH", flameChanged || flameFlips ? "change seen (OK)" : "no change seen yet");
  Serial.printf("  Gas MQ-2  : %s (baseline %d mV AO)\n", okGas ? "OK" : "CHECK", gasBaseline);
  line();
  Serial.println(F("Alarm loop running: flame or gas -> red LED + buzzer + LCD. Commands at the top of the file."));
}

void runAll() {
  scanI2C();
  showLcd();
  testLed();
  testBuzzer();
  testDht();
  testFlame();
  testGas();
  summary();
}

void setup() {
  Serial.begin(115200);
  delay(1500);
  pinMode(PIN_RED, OUTPUT);
  digitalWrite(PIN_RED, LOW);
  pinMode(PIN_BUZZER, OUTPUT);
  buzz(false);
  pinMode(PIN_FLAME, INPUT);
  analogSetPinAttenuation(PIN_GAS, ADC_11db);
  Wire.begin(PIN_SDA, PIN_SCL);
  Wire.setClock(100000);
  dht.begin();

  // no flame at power-up: whatever DO reads now means "no flame"
  flameIdle = digitalRead(PIN_FLAME);
  checkFlamePower();

  Serial.println();
  line();
  Serial.println(F("HRIKA HARDWARE SELF-TEST"));
  Serial.println(F("Checks: I2C scan, LCD, red LED, buzzer, DHT11, flame, gas MQ-2"));
  runAll();
  flameLast = digitalRead(PIN_FLAME);
}

void loop() {
  if (Serial.available()) {
    switch (Serial.read()) {
      case 'a': runAll(); break;
      case 'S': summary(); break;
      case 's': scanI2C(); showLcd(); break;
      case 'l': testLed(); break;
      case 'R': ledHeld = true;  digitalWrite(PIN_RED, HIGH); Serial.println(F("LED: held ON")); break;
      case 'O': ledHeld = false; digitalWrite(PIN_RED, LOW);  Serial.println(F("LED: off")); break;
      case 'b': testBuzzer(); break;
      case 'P': buzz(false); activeBuzzer = !activeBuzzer; noTone(PIN_BUZZER); digitalWrite(PIN_BUZZER, LOW);
                Serial.printf("Buzzer mode: %s\n", activeBuzzer ? "ACTIVE (plain HIGH)" : "PASSIVE (2 kHz tone)"); break;
      case 'B': beepRepeat = true;  Serial.println(F("Buzzer: two beeps every 2 s (x to stop)")); break;
      case 'x': beepRepeat = false; buzz(false); Serial.println(F("Buzzer: stopped")); break;
      case 'd': testDht(); break;
      case 'f': testFlame(); break;
      case 'F': flameFlips = 0; Serial.println(F("Flame: change counter reset")); break;
      case 'g': testGas(); break;
      case 'm': muted = !muted; buzz(false); Serial.printf("Alarm buzzer %s\n", muted ? "MUTED" : "on"); break;
    }
  }

  // flame changes are counted all the time, so a flame shown at any moment is caught
  int fl = digitalRead(PIN_FLAME);
  if (flameLast >= 0 && fl != flameLast) { flameFlips++; flameChanged = true; }
  flameLast = fl;

  if (beepRepeat && millis() - lastBeepCycle >= 2000) { lastBeepCycle = millis(); beeps(2); }

  // the combined bench sketch: alarm = flame or gas above baseline
  static unsigned long lastAlarm = 0, lastLive = 0;
  if (millis() - lastAlarm >= 500) {
    lastAlarm = millis();
    int gas = gasAoMv();
    bool flame = flameNow();
    bool gasAlarm = gasBaseline > 0 && gas > gasBaseline + GAS_ALARM_DELTA;
    bool alarm = flame || gasAlarm;
    if (!ledHeld) digitalWrite(PIN_RED, alarm);
    if (!beepRepeat) buzz(alarm && !muted);
    static float t = NAN, h = NAN;
    if (millis() - lastLive >= 2000) {
      lastLive = millis();
      t = dht.readTemperature();
      h = dht.readHumidity();
      Serial.printf("live  T %s C  H %s %%  gas %4d mV AO (base %d)  flame %s (DO %d, changes %lu)  %s\n",
                    isnan(t) ? "NaN" : String(t, 1).c_str(), isnan(h) ? "NaN" : String(h, 0).c_str(),
                    gas, gasBaseline, flame ? "YES" : "no", fl, flameFlips,
                    alarm ? (flame ? "ALARM: FLAME" : "ALARM: GAS") : "normal");
    }
    if (lcd) {
      // line 1: temperature + humidity; line 2: gas status (no voltage), flame takes priority
      char l1[17], l2[17];
      if (isnan(t)) snprintf(l1, sizeof l1, "T --.-C  H --%%  ");
      else          snprintf(l1, sizeof l1, "T %4.1fC  H %2.0f%%  ", t, isnan(h) ? 0.0 : h);
      bool rising = gasBaseline > 0 && gas > gasBaseline + GAS_ALARM_DELTA / 2;
      if (flame)         snprintf(l2, sizeof l2, "FLAME DETECTED! ");
      else if (gasAlarm) snprintf(l2, sizeof l2, "Gas: DETECTED!  ");
      else if (rising)   snprintf(l2, sizeof l2, "Gas: rising     ");
      else               snprintf(l2, sizeof l2, "Gas: normal     ");
      lcd->setCursor(0, 0); lcd->print(l1);
      lcd->setCursor(0, 1); lcd->print(l2);
    }
  }
}
