// Hrika - factory sensor node (ESP32)
// Reads gas, temperature and flame, decides NORMAL / WARNING / ALARM,
// drives LEDs + buzzer locally, and POSTs the reading to the server every second.
// Works the same in the Wokwi simulator and on a real ESP32.
// Wokwi simulation: https://wokwi.com/projects/481306010649524225

#include <WiFi.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>
#include "DHT.h"   // Adafruit "DHT sensor library" (+ "Adafruit Unified Sensor")

// ===================== SETTINGS (change these) =====================
const bool  IN_WOKWI   = true;            // false on the real ESP32
const char* WIFI_SSID  = "Wokwi-GUEST";   // real hotspot name on the real ESP32
const char* WIFI_PASS  = "";              // real hotspot password
// Where to send readings. Examples:
//   test:        "https://webhook.site/<your-id>"
//   via tunnel:  "https://<something>.trycloudflare.com/api/sensor"
//   real ESP32:  "http://192.168.43.12:5000/api/sensor"   (SERVER_IP)
const char* SERVER_URL = "https://webhook.site/REPLACE-ME";
const char* NODE_ID    = "N1";            // must match sim/factory.json
const char* ZONE_ID    = "Z2";            // must match sim/factory.json

// Pins
const int PIN_GAS        = 34;  // analog (ADC1, works with WiFi on)
const int PIN_FLAME      = 27;  // digital
const int PIN_DHT        = 4;
const int PIN_LED_GREEN  = 25;
const int PIN_LED_YELLOW = 26;
const int PIN_LED_RED    = 33;
const int PIN_BUZZER     = 32;
const bool FLAME_ACTIVE_LOW = true;  // most flame modules read LOW when they see a flame

// Thresholds (tune after watching the Serial Monitor)
// (Wokwi's gas sensor maxes out between +300 and +800 above baseline, so keep ALARM well below that)
const int   GAS_WARNING_DELTA = 100;   // above the baseline measured at start-up
const int   GAS_ALARM_DELTA   = 250;
const float TEMP_WARNING      = 40.0;  // degrees C
const float TEMP_ALARM        = 50.0;
const float RISE_ALARM        = 5.0;   // degrees C ...
const int   RISE_WINDOW_S     = 10;    // ... within this many seconds = fire-like rise
// ===================================================================

DHT dht(PIN_DHT, DHT22);
int   gasBaseline = 0;
float lastTemp = 20.0;
float tempHistory[RISE_WINDOW_S + 1];
int   histCount = 0, histIndex = 0;

const char* level = "NORMAL";
const char* cause = "none";
unsigned long lastReading = 0, lastBeep = 0;
bool beepOn = false;

void setLeds(bool g, bool y, bool r) {
  digitalWrite(PIN_LED_GREEN, g);
  digitalWrite(PIN_LED_YELLOW, y);
  digitalWrite(PIN_LED_RED, r);
}

void connectWifi() {
  Serial.printf("Connecting to WiFi '%s'", WIFI_SSID);
  if (IN_WOKWI) WiFi.begin(WIFI_SSID, WIFI_PASS, 6);  // Wokwi-GUEST is on channel 6
  else          WiFi.begin(WIFI_SSID, WIFI_PASS);
  unsigned long start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < 10000) {
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

void decideLevel(int gas, float temp, float rise, int flame) {
  if (flame)                                { level = "ALARM";   cause = "flame"; }
  else if (gas > gasBaseline + GAS_ALARM_DELTA) { level = "ALARM";   cause = "gas"; }
  else if (temp > TEMP_ALARM || rise >= RISE_ALARM) { level = "ALARM"; cause = "temp"; }
  else if (gas > gasBaseline + GAS_WARNING_DELTA) { level = "WARNING"; cause = "gas"; }
  else if (temp > TEMP_WARNING)             { level = "WARNING"; cause = "temp"; }
  else                                      { level = "NORMAL";  cause = "none"; }
}

// The server reads "gas" on a common scale: 300 = clean air, 900 = warning, 1500 = alarm
// (same as server/fake_sensor.py). Raw MQ values depend on the sensor and its baseline,
// so convert: baseline -> 300, baseline + WARNING_DELTA -> 900, baseline + ALARM_DELTA -> 1500.
int gasForServer(int raw) {
  int delta = raw - gasBaseline;
  if (delta <= 0) return max(0, 300 + delta);
  if (delta <= GAS_WARNING_DELTA) return 300 + delta * 600L / GAS_WARNING_DELTA;
  return 900 + (delta - GAS_WARNING_DELTA) * 600L / (GAS_ALARM_DELTA - GAS_WARNING_DELTA);
}

void sendReading(int rawGas, float temp, int flame) {
  int gas = gasForServer(rawGas);
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("  WiFi down -> not sent (local alarm still active)");
    return;
  }
  char body[200];
  snprintf(body, sizeof(body),
           "{\"node\":\"%s\",\"zone\":\"%s\",\"gas\":%d,\"temp\":%.1f,\"flame\":%d,\"level\":\"%s\",\"cause\":\"%s\"}",
           NODE_ID, ZONE_ID, gas, temp, flame, level, cause);

  HTTPClient http;
  WiFiClient plain;
  WiFiClientSecure secure;
  bool ok;
  if (strncmp(SERVER_URL, "https", 5) == 0) {
    secure.setInsecure();  // skip certificate check (fine for a demo)
    ok = http.begin(secure, SERVER_URL);
  } else {
    ok = http.begin(plain, SERVER_URL);
  }
  if (!ok) { Serial.println("  bad SERVER_URL"); return; }
  http.setConnectTimeout(2000);
  http.setTimeout(2000);
  http.addHeader("Content-Type", "application/json");
  int code = http.POST(body);
  Serial.printf("  sent %s -> HTTP %d\n", body, code);
  http.end();
}

void setup() {
  Serial.begin(115200);
  pinMode(PIN_FLAME, INPUT);
  pinMode(PIN_LED_GREEN, OUTPUT);
  pinMode(PIN_LED_YELLOW, OUTPUT);
  pinMode(PIN_LED_RED, OUTPUT);
  pinMode(PIN_BUZZER, OUTPUT);
  dht.begin();

  // Gas baseline = average of the clean air at start-up.
  // On the real sensor: let it warm up 20+ min, then press EN (reset) so the baseline is good.
  setLeds(true, true, true);
  long sum = 0;
  for (int i = 0; i < 10; i++) { sum += analogRead(PIN_GAS); delay(200); }
  gasBaseline = sum / 10;
  Serial.printf("\nGas baseline = %d\n", gasBaseline);
  setLeds(true, false, false);

  connectWifi();
}

void loop() {
  unsigned long now = millis();

  // Buzzer: beeps fast in ALARM, silent otherwise (works without WiFi)
  if (strcmp(level, "ALARM") == 0) {
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

  int gas = analogRead(PIN_GAS);
  float t = dht.readTemperature();
  if (!isnan(t)) lastTemp = t;  // keep the last good value if one read fails
  else Serial.println("  !! temperature read failed (check the DHT22 wire on pin 4)");
  int flameRaw = digitalRead(PIN_FLAME);
  int flame = FLAME_ACTIVE_LOW ? (flameRaw == LOW) : (flameRaw == HIGH);
  float rise = temperatureRise(lastTemp);

  decideLevel(gas, lastTemp, rise, flame);

  if (strcmp(level, "ALARM") == 0)        setLeds(false, false, true);
  else if (strcmp(level, "WARNING") == 0) setLeds(false, true, false);
  else                                    setLeds(true, false, false);

  Serial.printf("gas=%d (base %d)  temp=%.1fC  rise=%.1fC/%ds  flame=%d  => %s (%s)\n",
                gas, gasBaseline, lastTemp, rise, RISE_WINDOW_S, flame, level, cause);

  if (WiFi.status() != WL_CONNECTED) WiFi.reconnect();
  sendReading(gas, lastTemp, flame);
}
