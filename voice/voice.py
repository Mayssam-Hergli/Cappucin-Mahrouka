"""The drone's voice: speak to a victim, listen to the answer, tell the server.

Every 1 s:
    GET  /api/voice/next  -> {"victim": "V1", "say": "..."}  or  {}
    speak: Tunisian Derja (recorded clips, offline) then French (pyttsx3, offline)
    listen 5 s (Google speech recognition, Tunisian Arabic + French: needs internet)
    POST /api/voice       -> {"victim": "V1", "heard": "...", "status": "walking|injured|no_answer"}
    say a closing sentence that fits the status (stay still / walk to the exit / make noise)

If the microphone or the recognizer fails, the answer is typed on the keyboard.
If some Derja clips are missing, the drone speaks French only.

Usage:
    python voice/voice.py --server http://SERVER_IP:5000             # Derja + French (default)
    python voice/voice.py --server http://SERVER_IP:5000 --lang fr   # French only
    python voice/voice.py --keyboard                                  # never use the mic
    python voice/voice.py --test "Pouvez-vous marcher ?"              # speak + listen once, no server
"""
import argparse
import re
import time
import unicodedata

import pyttsx3
import requests

import clips

try:
    import speech_recognition as sr
except ImportError:  # keyboard mode still works
    sr = None
try:
    import winsound  # plays the .wav clips (Windows, standard library)
except ImportError:
    winsound = None

LISTEN_SECONDS = 5

# Keywords in French, Derja written in Latin letters, and Derja in Arabic script
# (Google writes Tunisian Arabic answers in Arabic script).
# "injured" is checked FIRST: "ey, ama youja3ni" / "oui mais j'ai mal" must be injured.
# Safety rule: when in doubt, the victim is flagged for rescue, never the other way round.
INJURED = [
    r"\bbless", r"\baid", r"\bmal\b", r"\bnon\b", r"\bpas\b", r"\bsecours",          # French
    r"\ble\b", r"\bla2\b", r"najjemch", r"mjarr?a7", r"youja3", r"3aweni", r"3awenni",  # Derja (Latin)
    r"\bنجدة\b", r"\bالنجدة\b", r"\bلا\b", r"نجمش", r"مجروح", r"يوجع", r"عاون",          # Derja (Arabic)
]
WALKING = [
    r"\boui\b", r"\bje peux\b", r"\bca va\b", r"\bd'? ?accord\b",                       # French
    r"\bey\b", r"\beyh\b", r"\bnn?ajjem\b", r"\bbehi\b",                                # Derja (Latin)
    r"\bايه\b", r"\bإيه\b", r"\bاي\b", r"\bنعم\b", r"\bنجم\b", r"\bننجم\b", r"\bباهي\b",   # Derja (Arabic)
]


def normalize(text):
    """Lowercase and remove accents/diacritics: 'Blessé' -> 'blesse', 'ça' -> 'ca'."""
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
    print(f"DRONE SAYS (fr): {text}")
    # A new engine each time: on Windows, reusing one engine often hangs on the 2nd runAndWait().
    engine = pyttsx3.init()
    if voice_id:
        engine.setProperty("voice", voice_id)
    engine.setProperty("rate", 160)
    engine.say(text)
    engine.runAndWait()
    engine.stop()


def play(name):
    print(f"DRONE SAYS (tn): {clips.CLIPS[name]}")
    winsound.PlaySound(str(clips.path(name)), winsound.SND_FILENAME)


def derja_ready():
    if winsound is None:
        print("Derja clips need Windows (winsound): French only.")
        return False
    gone = clips.missing()
    if gone:
        print(f"Derja clips missing {gone}: French only. Record them with: python voice/record_clips.py")
        return False
    return True


def speak_derja(say):
    """The Derja message. The exit number is read from the server's French text (e.g. 'sortie E1')."""
    play("hello")
    play("smoke")
    exit_ = re.search(r"\bE([1-3])\b", say)
    if exit_:
        play("exit_intro")
        play(f"exit_E{exit_.group(1)}")
    play("coming")
    play("ask_walk")


# ---------- listening ----------

class Listener:
    def __init__(self, languages, keyboard_only=False):
        self.languages = languages
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
        except sr.WaitTimeoutError:
            return ""  # silence
        except OSError as e:
            print(f"Microphone failed ({e}). Type the answer instead.")
            return self.keyboard()

        # The same recording is read once per language (Tunisian Arabic, then French),
        # because victims mix both: "ey, ama j'ai mal".
        heard, failed = [], 0
        for lang in self.languages:
            try:
                heard.append(self.rec.recognize_google(audio, language=lang))
            except sr.UnknownValueError:
                pass  # nothing understood in this language
            except sr.RequestError as e:
                print(f"Speech recognition ({lang}) failed: {e}")
                failed += 1
        if failed == len(self.languages):  # no internet: fall back to the keyboard
            print("Type the answer instead.")
            return self.keyboard()
        return " | ".join(heard)

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


def talk_to_victim(say, listener, voice_id, derja):
    """Speak the message, listen, and return (heard, status)."""
    if derja:
        speak_derja(say)
    speak(say, voice_id)
    heard = listener.listen()
    return heard, classify(heard)


def closing(status, voice_id, derja):
    if derja:
        play(f"after_{status}")
    speak(clips.AFTER_FR[status], voice_id)


def run(server, listener, voice_id, derja):
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

        heard, status = talk_to_victim(job["say"], listener, voice_id, derja)
        print(f"HEARD: {heard!r} -> {status}")
        send_answer(base, job.get("victim", ""), heard, status)  # send first: the map updates sooner
        closing(status, voice_id, derja)


def main():
    p = argparse.ArgumentParser(description="Drone voice: speak, listen, report")
    p.add_argument("--server", default="http://127.0.0.1:5000", help="Flask hub URL")
    p.add_argument("--lang", choices=["both", "fr"], default="both",
                   help="both = Derja clips + French (default), fr = French only")
    p.add_argument("--keyboard", action="store_true", help="type answers instead of using the mic")
    p.add_argument("--test", metavar="TEXT", help="speak TEXT, listen once, print the result, exit")
    args = p.parse_args()

    voice_id = french_voice_id()
    derja = args.lang == "both" and derja_ready()
    languages = ["ar-TN", "fr-FR"] if args.lang == "both" else ["fr-FR"]
    listener = Listener(languages, keyboard_only=args.keyboard)

    if args.test:
        heard, status = talk_to_victim(args.test, listener, voice_id, derja)
        print(f"HEARD: {heard!r} -> {status}")
        closing(status, voice_id, derja)
        return
    try:
        run(args.server, listener, voice_id, derja)
    except KeyboardInterrupt:
        print("\nStopped.")


if __name__ == "__main__":
    main()
