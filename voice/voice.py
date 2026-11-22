"""The drone's voice: when the drone finds a victim, it tells them where to go.

Every 1 s:
    GET /api/voice/next  -> {"victim": "V1", "say": "..."}  or  {}
    speak "say" in French

Voice: a natural neural voice (Microsoft Edge online voices via edge-tts: free, no account,
no API key; needs internet). Sentences are spoken one by one while the next ones are being
generated, and the greeting is prepared in advance, so the drone starts talking at once.
If the internet fails, it falls back to the offline Windows voice (pyttsx3, Hortense).

The sentence comes from the server (sim.guidance): the safest exit, and that the
Protection Civile is on its way. The drone does not listen for an answer.

Usage:
    python voice/voice.py --server http://SERVER_IP:5050
    python voice/voice.py --server http://SERVER_IP:5050 --voice fr-FR-HenriNeural   # male voice
    python voice/voice.py --offline                                                   # robotic, no internet
    python voice/voice.py --test "La sortie la plus sûre est la sortie E1."           # speak once, no server
"""
import argparse
import asyncio
import hashlib
import queue
import re
import tempfile
import threading
import time
import wave
from pathlib import Path

import pyttsx3
import requests

try:
    import edge_tts
    import miniaudio
    import winsound
except ImportError:  # neural voice unavailable: offline voice only
    edge_tts = None

DEFAULT_VOICE = "fr-FR-DeniseNeural"
GREETING = "Bonjour, je suis le drone de la Protection Civile."
CACHE = Path(tempfile.gettempdir()) / "hrika_voice_cache"


# ---------- offline voice (fallback) ----------

def french_voice_id():
    for v in pyttsx3.init().getProperty("voices"):
        tags = f"{v.id} {v.name} {v.languages}".lower()
        if "fr-fr" in tags or "french" in tags:
            return v.id
    return None


def speak_offline(text, voice_id):
    # A new engine each time: on Windows, reusing one engine often hangs on the 2nd runAndWait().
    engine = pyttsx3.init()
    if voice_id:
        engine.setProperty("voice", voice_id)
    engine.setProperty("rate", 160)
    engine.say(text)
    engine.runAndWait()
    engine.stop()


# ---------- neural voice ----------

def neural_wav(sentence, voice):
    """Generate (or reuse from the cache) one sentence as a WAV file. Needs internet the first time."""
    key = hashlib.sha1(f"{voice}|{sentence}".encode()).hexdigest()[:16]
    wav = CACHE / f"{key}.wav"
    if wav.exists():
        return wav
    CACHE.mkdir(exist_ok=True)
    mp3 = CACHE / f"{key}.mp3"
    asyncio.run(asyncio.wait_for(edge_tts.Communicate(sentence, voice, rate="+5%").save(str(mp3)), 10))
    snd = miniaudio.decode_file(str(mp3), output_format=miniaudio.SampleFormat.SIGNED16)
    with wave.open(str(wav), "wb") as w:  # winsound (built into Windows) plays WAV only
        w.setnchannels(snd.nchannels)
        w.setsampwidth(2)
        w.setframerate(snd.sample_rate)
        w.writeframes(snd.samples.tobytes())
    mp3.unlink()
    return wav


def split_sentences(text):
    return [s.strip() for s in re.split(r"(?<=[.!?])\s+", text) if s.strip()]


class Speaker:
    def __init__(self, voice, offline):
        self.voice = voice
        self.offline_id = french_voice_id()
        self.neural = edge_tts is not None and not offline
        if edge_tts is None and not offline:
            print("Neural voice unavailable (pip install edge-tts miniaudio): using the offline voice.")
        if self.neural:
            try:
                neural_wav(GREETING, voice)  # ready in advance: the drone starts talking at once
                print(f"Neural voice ready: {voice}")
            except Exception as e:
                print(f"Neural voice unreachable ({type(e).__name__}): using the offline voice for now.")

    def say(self, text):
        print(f"DRONE SAYS: {text}")
        if not self.neural:
            speak_offline(text, self.offline_id)
            return
        sentences = split_sentences(text)
        ready = queue.Queue()

        def generate():  # generates the next sentences while the current one is playing
            for s in sentences:
                try:
                    ready.put((s, neural_wav(s, self.voice)))
                except Exception as e:
                    print(f"  (neural voice failed: {type(e).__name__}, offline voice for this sentence)")
                    ready.put((s, None))

        threading.Thread(target=generate, daemon=True).start()
        for _ in sentences:
            s, wav = ready.get()
            if wav is None:
                speak_offline(s, self.offline_id)
            else:
                winsound.PlaySound(str(wav), winsound.SND_FILENAME)


# ---------- main loop ----------

def run(server, speaker):
    url = server.rstrip("/") + "/api/voice/next"
    print(f"Waiting for messages from {url} (Ctrl+C to stop)")
    offline = False
    while True:
        try:
            job = requests.get(url, timeout=5).json() or {}
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
            speaker.say(job["say"])          # returns when the message has been spoken
            try:   # tell the server the message is over: the drone may move on
                requests.post(server.rstrip("/") + "/api/voice/done", json={"victim": job.get("victim")}, timeout=2)
            except requests.RequestException:
                pass
        else:
            time.sleep(1)


def main():
    p = argparse.ArgumentParser(description="Drone voice: tells victims where to go")
    p.add_argument("--server", default="http://127.0.0.1:5000", help="Flask hub URL")
    p.add_argument("--voice", default=DEFAULT_VOICE,
                   help="neural voice: fr-FR-DeniseNeural (default), fr-FR-HenriNeural, fr-FR-EloiseNeural...")
    p.add_argument("--offline", action="store_true", help="always use the offline Windows voice")
    p.add_argument("--test", metavar="TEXT", help="speak TEXT once and exit (no server)")
    args = p.parse_args()

    speaker = Speaker(args.voice, args.offline)
    if args.test:
        speaker.say(args.test)
        return
    try:
        run(args.server, speaker)
    except KeyboardInterrupt:
        print("\nStopped.")


if __name__ == "__main__":
    main()
