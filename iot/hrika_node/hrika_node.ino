// Hrika - factory sensor node (ESP32)
// Reads gas, temperature/humidity and flame, decides NORMAL / WARNING / ALARM,
// drives the red LED, the buzzer and the 16x2 LCD locally, and POSTs the reading
// to the server every second (optionally signed with HMAC-SHA256).
// Works the same in the Wokwi simulator and on the real ESP32.
// Wokwi simulation: https://wokwi.com/projects/481306010649524225

#include <WiFi.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>
#include <Wire.h>
#include <LiquidCrystal_I2C.h>   // "LiquidCrystal I2C" (Frank de Brabander)
#include "DHT.h"                  // Adafruit "DHT sensor library" (+ "Adafruit Unified Sensor")
#include "mbedtls/md.h"           // HMAC-SHA256, built into the ESP32 core

// ===================== SETTINGS =====================
// Real board: copy secrets.example.h to secrets.h (git-ignored, never committed) and fill it in.
// Without secrets.h the sketch uses the Wokwi settings below (Wokwi has no secrets.h).
#if __has_include("secrets.h")
#include "secrets.h"
#define HAVE_SECRETS 1
#else
#define HAVE_SECRETS 0
#endif

const bool IN_WOKWI = !HAVE_SECRETS;
#if HAVE_SECRETS
const char* WIFI_SSID    = HRIKA_WIFI_SSID;
const char* WIFI_PASS    = HRIKA_WIFI_PASS;
const char* SERVER_URL   = HRIKA_SERVER_URL;     // "http://<laptop IP>:5000/api/sensor"
const char* NODE_KEY_HEX = HRIKA_NODE_KEY_HEX;   // "" = unsigned messages
#else
const char* WIFI_SSID    = "Wokwi-GUEST";
const char* WIFI_PASS    = "";
// Wokwi reaches the internet only: expose the server with cloudflared and put its URL here.
const char* SERVER_URL   = "https://REPLACE-WITH-YOUR-TUNNEL.trycloudflare.com/api/sensor";
const char* NODE_KEY_HEX = "";
#endif
const char* NODE_ID = "N1";   // must match sim/factory.json
const char* ZONE_ID = "Z2";   // informative: the server takes the zone from sim/factory.json

// --- pins (see context/HANDOVER-hardware.md) ---
const int PIN_RED    = 33;   // red LED through 220 ohms (the only LED)
const int PIN_BUZZER = 32;   // passive buzzer: needs tone()
const int PIN_GAS    = 34;   // MQ-2 AO through the 10k/20k divider (ADC1, works with WiFi on)
const int PIN_DHT    = 4;
const int PIN_FLAME  = 27;   // flame module DO
const int PIN_SDA    = 21;   // LCD
const int PIN_SCL    = 22;   // LCD
// --- end of pins ---

// Parts, as tested on the bench
const uint8_t LCD_ADDR         = 0x27;                   // the scan is the fallback
const uint8_t DHT_TYPE         = IN_WOKWI ? DHT22 : DHT11; // blue module = DHT11; Wokwi only has a DHT22
const float   GAS_DIVIDER      = IN_WOKWI ? 1.0 : 1.5;   // real: pin sees 2/3 of AO; Wokwi: no divider
const bool    FLAME_ACTIVE_LOW = true;                   // confirmed: DO goes LOW on flame
const unsigned long FLAME_HOLD_MS = 3000;                // a flickering flame toggles DO: hold the alarm

// Thresholds (tune after watching the Serial Monitor). Gas in mV of sensor output (AO).
const int   GAS_WARNING_DELTA = IN_WOKWI ? 80 : 150;     // above the clean-air baseline measured at start-up
const int   GAS_ALARM_DELTA   = IN_WOKWI ? 200 : 300;
const int   GAS_BASELINE_MAX  = IN_WOKWI ? 3000 : 1500;  // a higher "clean air" is not believed (booted in gas)
const float TEMP_WARNING      = 40.0;  // degrees C
const float TEMP_ALARM        = 50.0;
const float RISE_ALARM        = 5.0;   // degrees C ...
const int   RISE_WINDOW_S     = 10;    // ... within this many seconds = fire-like rise
// ===================================================================

DHT dht(PIN_DHT, DHT_TYPE);
LiquidCrystal_I2C* lcd = nullptr;
int   gasBaseline = 0;
float lastTemp = 20.0, lastHum = NAN;
float tempHistory[RISE_WINDOW_S + 1];
int   histCount = 0, histIndex = 0;

const char* level = "NORMAL";
const char* cause = "none";
unsigned long lastReading = 0, lastBeep = 0, lastFlameAt = 0, lastWifiTry = 0;
bool beepOn = false, flameSeen = false;

// signing state
uint8_t  nodeKey[32];
size_t   nodeKeyLen = 0;
double   clockOffset = 0;      // server time - node uptime, learned from each reply
uint32_t msgSeq = 0;

// ------------------------------------------------------------------ helpers

int gasMv() { return (int)(analogReadMilliVolts(PIN_GAS) * GAS_DIVIDER); }

bool flameRaw() {
  int v = digitalRead(PIN_FLAME);
  return FLAME_ACTIVE_LOW ? v == LOW : v == HIGH;
}

bool isAlarm()   { return strcmp(level, "ALARM") == 0; }
bool isWarning() { return strcmp(level, "WARNING") == 0; }

void startLcd() {
  Wire.begin(PIN_SDA, PIN_SCL);
  uint8_t addr = 0;
  Wire.beginTransmission(LCD_ADDR);
  if (Wire.endTransmission() == 0) addr = LCD_ADDR;
  for (uint8_t a = 0x20; !addr && a < 0x40; a++) {        // PCF8574 backpacks live in 0x20-0x3F
    Wire.beginTransmission(a);
    if (Wire.endTransmission() == 0) addr = a;
  }
  if (!addr) { Serial.println("LCD not found - the node keeps working without it"); return; }
  lcd = new LiquidCrystal_I2C(addr, 16, 2);
  lcd->init();
  lcd->backlight();
  Serial.printf("LCD at 0x%02X\n", addr);
}

void lcdLines(const char* l1, const char* l2) {
  if (!lcd) return;
  char a[17], b[17];
  snprintf(a, sizeof a, "%-16s", l1);
  snprintf(b, sizeof b, "%-16s", l2);
  lcd->setCursor(0, 0); lcd->print(a);
  lcd->setCursor(0, 1); lcd->print(b);
}

// Line 1: temperature + humidity (+ W when WiFi is up). Line 2: status, no voltage.
void showLcd() {
  char l1[17], l2[17];
  char w = WiFi.status() == WL_CONNECTED ? 'W' : ' ';
  if (isnan(lastHum)) snprintf(l1, sizeof l1, "T %4.1fC  H --%% %c", lastTemp, w);
  else                snprintf(l1, sizeof l1, "T %4.1fC  H %2.0f%% %c", lastTemp, lastHum, w);
  if (isAlarm()) {
    if (strcmp(cause, "flame") == 0)    snprintf(l2, sizeof l2, "FLAME DETECTED!");
    else if (strcmp(cause, "gas") == 0) snprintf(l2, sizeof l2, "GAS DETECTED!");
    else                                snprintf(l2, sizeof l2, "HEAT ALARM!");
  } else if (isWarning()) {
    snprintf(l2, sizeof l2, strcmp(cause, "gas") == 0 ? "Gas: rising" : "Temp: rising");
  } else {
    snprintf(l2, sizeof l2, "Gas: normal");
  }
  lcdLines(l1, l2);
}

void connectWifi() {
  Serial.printf("Connecting to WiFi '%s'", WIFI_SSID);
  if (IN_WOKWI) WiFi.begin(WIFI_SSID, WIFI_PASS, 6);  // Wokwi-GUEST is on channel 6
  else          WiFi.begin(WIFI_SSID, WIFI_PASS);
  unsigned long start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < 8000) {
    delay(250);
    Serial.print(".");
  }
  if (WiFi.status() == WL_CONNECTED) Serial.printf("\nWiFi OK, IP = %s\n", WiFi.localIP().toString().c_str());
  else Serial.println("\nWiFi not connected yet - local alarm still works, will keep retrying");
}

// Temperature rise over the last RISE_WINDOW_S seconds
float temperatureRise(float t) {
  tempHistory[histIndex] = t;
  histIndex = (histIndex + 1) % (RISE_WINDOW_S + 1);
  if (histCount < RISE_WINDOW_S + 1) histCount++;
  if (histCount < RISE_WINDOW_S + 1) return 0;
  float oldest = tempHistory[histIndex];  // next slot to overwrite = oldest value
  return t - oldest;
}

void decideLevel(int gas, float temp, float rise, bool flame) {
  if (flame)                                        { level = "ALARM";   cause = "flame"; }
  else if (gas > gasBaseline + GAS_ALARM_DELTA)     { level = "ALARM";   cause = "gas"; }
  else if (temp > TEMP_ALARM || rise >= RISE_ALARM) { level = "ALARM";   cause = "temp"; }
  else if (gas > gasBaseline + GAS_WARNING_DELTA)   { level = "WARNING"; cause = "gas"; }
  else if (temp > TEMP_WARNING)                     { level = "WARNING"; cause = "temp"; }
  else                                              { level = "NORMAL";  cause = "none"; }
}

// The server reads "gas" on a common scale: 300 = clean air, 900 = warning, 1500 = alarm
// (same as server/fake_sensor.py). Raw MQ values depend on the sensor and its baseline,
// so convert: baseline -> 300, baseline + WARNING_DELTA -> 900, baseline + ALARM_DELTA -> 1500.
int gasForServer(int mv) {
  int delta = mv - gasBaseline;
  if (delta <= 0) return max(0, 300 + delta);
  if (delta <= GAS_WARNING_DELTA) return 300 + delta * 600L / GAS_WARNING_DELTA;
  return 900 + (delta - GAS_WARNING_DELTA) * 600L / (GAS_ALARM_DELTA - GAS_WARNING_DELTA);
}

// ------------------------------------------------------------------ signing (see server/security.py)

void loadKey() {
  size_t n = strlen(NODE_KEY_HEX);
  for (size_t i = 0; i + 1 < n && nodeKeyLen < sizeof nodeKey; i += 2) {
    char h[3] = {NODE_KEY_HEX[i], NODE_KEY_HEX[i + 1], 0};
    nodeKey[nodeKeyLen++] = (uint8_t)strtoul(h, nullptr, 16);
  }
  Serial.println(nodeKeyLen ? "Messages signed (HMAC-SHA256)" : "Messages NOT signed (no NODE_KEY_HEX)");
}

// X-Hrika-Sig = hex(HMAC-SHA256(key, "<time>.<seq>.<body>"))
void hmacHex(const String& msg, char out[65]) {
  uint8_t mac[32];
  mbedtls_md_hmac(mbedtls_md_info_from_type(MBEDTLS_MD_SHA256), nodeKey, nodeKeyLen,
                  (const unsigned char*)msg.c_str(), msg.length(), mac);
  for (int i = 0; i < 32; i++) sprintf(out + 2 * i, "%02x", mac[i]);
}

// every reply carries "t" = server time: the node sets its clock from it (no NTP needed)
void syncClock(const String& reply) {
  int i = reply.indexOf("\"t\":");
  if (i < 0) return;
  double t = strtod(reply.c_str() + i + 4, nullptr);
  if (t > 1e9) clockOffset = t - millis() / 1000.0;
}

int postOnce(const char* body) {
  HTTPClient http;
  WiFiClient plain;
  WiFiClientSecure secure;
  bool ok;
  if (strncmp(SERVER_URL, "https", 5) == 0) {
    secure.setInsecure();  // tunnel only (Wokwi); on the real LAN the URL is plain http
    ok = http.begin(secure, SERVER_URL);
  } else {
    ok = http.begin(plain, SERVER_URL);
  }
  if (!ok) { Serial.println("  bad SERVER_URL"); return -1; }
  http.setConnectTimeout(2000);
  http.setTimeout(2000);
  http.addHeader("Content-Type", "application/json");
  if (nodeKeyLen) {
    uint32_t ts = (uint32_t)(millis() / 1000.0 + clockOffset);
    msgSeq++;
    char sig[65];
    hmacHex(String(ts) + "." + String(msgSeq) + "." + body, sig);
    http.addHeader("X-Hrika-Time", String(ts));
    http.addHeader("X-Hrika-Seq", String(msgSeq));
    http.addHeader("X-Hrika-Sig", sig);
  }
  int code = http.POST((uint8_t*)body, strlen(body));
  if (code > 0) syncClock(http.getString());
  http.end();
  return code;
}

void sendReading(int gasMvNow, float temp, bool flame) {
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("  WiFi down -> not sent (local alarm still active)");
    return;
  }
  char body[200];
  snprintf(body, sizeof(body),
           "{\"node\":\"%s\",\"zone\":\"%s\",\"gas\":%d,\"temp\":%.1f,\"flame\":%d,\"level\":\"%s\",\"cause\":\"%s\"}",
           NODE_ID, ZONE_ID, gasForServer(gasMvNow), temp, flame ? 1 : 0, level, cause);
  int code = postOnce(body);
  if (code == 401 && nodeKeyLen) code = postOnce(body);   // first message after boot: clock now set, retry once
  Serial.printf("  sent %s -> HTTP %d\n", body, code);
}

// ------------------------------------------------------------------ setup / loop

void setup() {
  Serial.begin(115200);
  pinMode(PIN_FLAME, INPUT);
  pinMode(PIN_RED, OUTPUT);
  pinMode(PIN_BUZZER, OUTPUT);
  analogSetPinAttenuation(PIN_GAS, ADC_11db);
  startLcd();
  lcdLines("Hrika node", "Starting...");
  dht.begin();
  loadKey();

  // Gas baseline = average of the clean air at start-up.
  // On the real sensor: let it warm up 20+ min, then press EN (reset) so the baseline is good.
  digitalWrite(PIN_RED, HIGH);
  lcdLines("Hrika node", "Gas calibration");
  long sum = 0;
  for (int i = 0; i < 10; i++) { sum += gasMv(); delay(200); }
  gasBaseline = sum / 10;
  if (gasBaseline > GAS_BASELINE_MAX) {     // started in gas or smoke: do not learn it as "clean air"
    Serial.printf("\n!! Gas baseline %d mV is too high, using %d mV\n", gasBaseline, GAS_BASELINE_MAX);
    gasBaseline = GAS_BASELINE_MAX;
  }
  Serial.printf("\nGas baseline = %d mV (sensor output)\n", gasBaseline);
  digitalWrite(PIN_RED, LOW);

  lcdLines("Hrika node", "WiFi...");
  connectWifi();
}

void loop() {
  unsigned long now = millis();

  // Flame: sampled every pass and held FLAME_HOLD_MS, because a flame makes DO flicker
  if (flameRaw()) { lastFlameAt = now; flameSeen = true; }
  bool flame = flameSeen && now - lastFlameAt < FLAME_HOLD_MS;

  // Red LED: off = normal, slow blink = warning, steady = alarm (works without WiFi)
  digitalWrite(PIN_RED, isAlarm() ? HIGH : isWarning() ? (now / 500) % 2 : LOW);

  // Buzzer (passive): beeps fast in ALARM, silent otherwise
  if (isAlarm()) {
    if (now - lastBeep > 250) {
      lastBeep = now;
      beepOn = !beepOn;
      if (beepOn) tone(PIN_BUZZER, 2000); else noTone(PIN_BUZZER);
    }
  } else if (beepOn) {
    noTone(PIN_BUZZER);
    beepOn = false;
  }

  if (now - lastReading < 1000) return;
  lastReading = now;

  int gas = gasMv();
  float t = dht.readTemperature(), h = dht.readHumidity();
  if (!isnan(t)) lastTemp = t;  // keep the last good value if one read fails
  else Serial.println("  !! temperature read failed (check the DHT wire on pin 4)");
  if (!isnan(h)) lastHum = h;
  float rise = temperatureRise(lastTemp);

  decideLevel(gas, lastTemp, rise, flame);
  showLcd();

  Serial.printf("gas=%d mV (base %d)  temp=%.1fC  hum=%.0f%%  rise=%.1fC/%ds  flame=%d  => %s (%s)\n",
                gas, gasBaseline, lastTemp, lastHum, rise, RISE_WINDOW_S, flame, level, cause);

  if (WiFi.status() != WL_CONNECTED && now - lastWifiTry > 10000) { lastWifiTry = now; WiFi.reconnect(); }
  sendReading(gas, lastTemp, flame);
}
