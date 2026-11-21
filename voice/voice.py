"""The drone's voice: when the drone finds a victim, it tells them where to go.

Every 1 s:
    GET /api/voice/next  -> {"victim": "V1", "say": "..."}  or  {}
    speak "say" in French, offline (pyttsx3, Windows voice Hortense)

The sentence comes from the server (sim.guidance): the safest exit, and that the
Protection Civile is on its way. The drone does not listen for an answer.

Usage:
    python voice/voice.py --server http://SERVER_IP:5000
    python voice/voice.py --test "La sortie la plus sûre est la sortie E1."   # speak once, no server
"""
import argparse
import time

import pyttsx3
import requests


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


def run(server, voice_id):
    url = server.rstrip("/") + "/api/voice/next"
    print(f"Waiting for messages from {url} (Ctrl+C to stop)")
    offline = False
    while True:
        try:
            job = requests.get(url, timeout=2).json() or {}
            if offline:
                print("Server reachable again.")
            offline = False
        except (requests.RequestException, ValueError) as e:
            if not offline:
                print(f"Server unreachable ({type(e).__name__}), retrying every second...")
            offline = True
            time.sleep(1)
            continue

        if job.get("say"):
            print(f"Victim {job.get('victim', '?')}:")
            speak(job["say"], voice_id)
        else:
            time.sleep(1)


def main():
    p = argparse.ArgumentParser(description="Drone voice: tells victims where to go")
    p.add_argument("--server", default="http://127.0.0.1:5000", help="Flask hub URL")
    p.add_argument("--test", metavar="TEXT", help="speak TEXT once and exit (no server)")
    args = p.parse_args()

    voice_id = french_voice_id()
    if args.test:
        speak(args.test, voice_id)
        return
    try:
        run(args.server, voice_id)
    except KeyboardInterrupt:
        print("\nStopped.")


if __name__ == "__main__":
    main()
