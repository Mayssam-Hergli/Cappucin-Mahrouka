// Copy this file to secrets.h in the same folder and fill it in.
// secrets.h is git-ignored: the WiFi password and the node key never reach the repo.
// With secrets.h present, the sketch runs in real-hardware mode (IN_WOKWI = false).

#define HRIKA_WIFI_SSID    "your-hotspot-name"      // 2.4 GHz: the ESP32 has no 5 GHz
#define HRIKA_WIFI_PASS    "your-hotspot-password"
#define HRIKA_SERVER_URL   "http://192.168.x.x:5000/api/sensor"   // IP of the laptop running server/app.py

// Optional: sign every message (HMAC-SHA256). Create the key on the laptop with
//   python server/security.py new-key N1
// and paste the 64 hex characters here. "" = unsigned (the server accepts it while it has no key file).
#define HRIKA_NODE_KEY_HEX ""
