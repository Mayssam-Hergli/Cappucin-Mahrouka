"""The drone's voice: speak to a victim, listen to the answer, tell the server.

Every 1 s:
    GET  /api/voice/next  -> {"victim": "V1", "say": "..."}  or  {}
    speak "say" in French (pyttsx3, offline)
    listen 5 s (SpeechRecognition, Google fr-FR: needs internet on the hotspot)
    POST /api/voice       -> {"victim": "V1", "heard": "...", "status": "walking|injured|no_answer"}

If the microphone or the recognizer fails, the answer is typed on the keyboard.

Usage:
    python voice/voice.py --server http://SERVER_IP:5000
    python voice/voice.py --server http://SERVER_IP:5000 --keyboard   # never use the mic
    python voice/voice.py --test "Pouvez-vous marcher ?"               # speak + listen once, no server
"""
import argparse
import re
import time
import unicodedata

import pyttsx3
import requests

try:
    import speech_recognition as sr
except ImportError:  # keyboard mode still works
    sr = None

LISTEN_SECONDS = 5

# Checked in this order. "injured" comes first on purpose: "oui, mais j'ai mal" must be injured.
# Safety rule: when in doubt, the victim is flagged for rescue, never the other way round.
INJURED = [r"\bbless", r"\baid", r"\bmal\b", r"\bnon\b", r"\bpas\b", r"\bsecours"]
WALKING = [r"\boui\b", r"\bje peux\b", r"\bca va\b", r"\bd'? ?accord\b"]


def normalize(text):
    """Lowercase and remove accents: 'Blessé' -> 'blesse', 'ça' -> 'ca'."""
    text = unicodedata.normalize("NFD", text.lower())
    return "".join(c for c in text if unicodedata.category(c) != "Mn")


def classify(heard):
    t = normalize(heard or "")
    if not t.strip():
        return "no_answer"
    if any(re.search(p, t) for p in INJURED):
        return "injured"
    if any(re.search(p, t) for p in WALKING):
        return "walking"
    return "injured"  # we heard something but didn't understand it: send help


# ---------- speaking ----------

def french_voice_id():
    for v in pyttsx3.init().getProperty("voices"):
        tags = f"{v.id} {v.name} {v.languages}".lower()
        if "fr-fr" in tags or "french" in tags:
            return v.id
    print("WARNING: no French voice found, using the default voice.\n"
          "  Windows: Settings > Time & language > Speech > Add voices > French.")
    return None


def speak(text, voice_id):
    print(f"DRONE SAYS: {text}")
    # A new engine each time: on Windows, reusing one engine often hangs on the 2nd runAndWait().
    engine = pyttsx3.init()
    if voice_id:
        engine.setProperty("voice", voice_id)
    engine.setProperty("rate", 160)
    engine.say(text)
    engine.runAndWait()
    engine.stop()


# ---------- listening ----------

class Listener:
    def __init__(self, keyboard_only=False):
        self.mic = None
        if keyboard_only or sr is None:
            print("Keyboard mode: type the victim's answer.")
            return
        try:
            self.rec = sr.Recognizer()
            self.mic = sr.Microphone()
            with self.mic as src:
                print("Calibrating the microphone, stay quiet for 1 s...")
                self.rec.adjust_for_ambient_noise(src, duration=1)
        except Exception as e:
            print(f"Microphone unavailable ({e}). Switching to keyboard.")
            self.mic = None

    def listen(self):
        """Return what the victim said ("" = nothing heard)."""
        if self.mic is None:
            return self.keyboard()
        try:
            with self.mic as src:
                print(f"Listening for {LISTEN_SECONDS} s...")
                audio = self.rec.listen(src, timeout=LISTEN_SECONDS, phrase_time_limit=LISTEN_SECONDS)
            return self.rec.recognize_google(audio, language="fr-FR")
        except (sr.WaitTimeoutError, sr.UnknownValueError):
            return ""  # silence, or sounds that aren't words
        except (sr.RequestError, OSError) as e:
            print(f"Speech recognition failed ({e}). Type the answer instead.")
            return self.keyboard()

    @staticmethod
    def keyboard():
        try:
            return input("Victim's answer (Enter = no answer): ").strip()
        except EOFError:
            return ""


# ---------- main loop ----------

def send_answer(base, victim, heard, status):
    body = {"victim": victim, "heard": heard, "status": status}
    for _ in range(3):  # this answer matters: retry a little
        try:
            requests.post(base + "/api/voice", json=body, timeout=2)
            return
        except requests.RequestException:
            time.sleep(0.5)
    print("Could not send the answer to the server.")


def run(server, listener, voice_id):
    base = server.rstrip("/")
    print(f"Waiting for messages from {base}/api/voice/next (Ctrl+C to stop)")
    offline = False
    while True:
        try:
            job = requests.get(base + "/api/voice/next", timeout=2).json() or {}
            if offline:
                print("Server reachable again.")
            offline = False
        except (requests.RequestException, ValueError) as e:
            if not offline:
                print(f"Server unreachable ({type(e).__name__}), retrying every second...")
            offline = True
            time.sleep(1)
            continue

        if not job.get("say"):
            time.sleep(1)
            continue

        speak(job["say"], voice_id)
        heard = listener.listen()
        status = classify(heard)
        print(f"HEARD: {heard!r} -> {status}")
        send_answer(base, job.get("victim", ""), heard, status)


def main():
    p = argparse.ArgumentParser(description="Drone voice: speak, listen, report")
    p.add_argument("--server", default="http://127.0.0.1:5000", help="Flask hub URL")
    p.add_argument("--keyboard", action="store_true", help="type answers instead of using the mic")
    p.add_argument("--test", metavar="TEXT", help="speak TEXT, listen once, print the result, exit")
    args = p.parse_args()

    voice_id = french_voice_id()
    listener = Listener(keyboard_only=args.keyboard)

    if args.test:
        speak(args.test, voice_id)
        heard = listener.listen()
        print(f"HEARD: {heard!r} -> {classify(heard)}")
        return
    try:
        run(args.server, listener, voice_id)
    except KeyboardInterrupt:
        print("\nStopped.")


if __name__ == "__main__":
    main()
