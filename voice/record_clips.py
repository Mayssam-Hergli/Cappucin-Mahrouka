"""Record the Derja voice clips with the laptop microphone.

    python voice/record_clips.py                 # record every clip not recorded yet
    python voice/record_clips.py --all           # re-record everything
    python voice/record_clips.py --only hello    # re-record one clip

For each clip: read the sentence, press Enter, speak, press Enter to stop.
It plays the clip back; then Enter = keep, r = redo.
Tips: quiet room, 20-30 cm from the mic, calm and slow voice, like a real agent.
"""
import argparse
import threading
import wave
import winsound

import pyaudio

from clips import CLIPS, CLIP_DIR, path

RATE, CHANNELS, FORMAT, CHUNK = 22050, 1, pyaudio.paInt16, 1024


def record(pa):
    stream = pa.open(format=FORMAT, channels=CHANNELS, rate=RATE, input=True, frames_per_buffer=CHUNK)
    frames, stop = [], threading.Event()

    def loop():
        while not stop.is_set():
            frames.append(stream.read(CHUNK, exception_on_overflow=False))

    t = threading.Thread(target=loop)
    t.start()
    input("   RECORDING... press Enter to stop ")
    stop.set()
    t.join()
    stream.stop_stream()
    stream.close()
    return b"".join(frames)


def save(name, audio, pa):
    with wave.open(str(path(name)), "wb") as w:
        w.setnchannels(CHANNELS)
        w.setsampwidth(pa.get_sample_size(FORMAT))
        w.setframerate(RATE)
        w.writeframes(audio)


def main():
    p = argparse.ArgumentParser(description="Record the Derja voice clips")
    p.add_argument("--all", action="store_true", help="re-record every clip")
    p.add_argument("--only", choices=list(CLIPS), help="re-record a single clip")
    args = p.parse_args()

    CLIP_DIR.mkdir(exist_ok=True)
    if args.only:
        todo = [args.only]
    elif args.all:
        todo = list(CLIPS)
    else:
        todo = [n for n in CLIPS if not path(n).exists()]
    if not todo:
        print("All clips are recorded. Use --all or --only NAME to redo some.")
        return

    pa = pyaudio.PyAudio()
    try:
        for i, name in enumerate(todo, 1):
            while True:
                print(f"\n[{i}/{len(todo)}] {name}\n   SAY: {CLIPS[name]}")
                input("   press Enter to start ")
                save(name, record(pa), pa)
                print("   playing it back...")
                winsound.PlaySound(str(path(name)), winsound.SND_FILENAME)
                if input("   Enter = keep, r = redo: ").strip().lower() != "r":
                    break
    finally:
        pa.terminate()
    print(f"\nDone. Clips are in {CLIP_DIR}")


if __name__ == "__main__":
    main()
