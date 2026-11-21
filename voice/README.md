# voice/: the drone's voice

When the drone finds a victim, `voice.py` tells them, in French, where to go and that the Protection Civile is on its way. The drone speaks only; it does not listen for an answer.

1. Polls `GET /api/voice/next` every second and receives `{"victim": "V1", "say": "..."}` or `{}`.
2. Speaks the text with a **natural neural French voice** (Microsoft Edge voices through `edge-tts`: free, no account, no API key, needs internet).
   - The greeting is prepared at startup and each next sentence is generated while the previous one plays, so the drone starts talking at once, with no gaps.
   - If the internet fails, it falls back to the offline Windows voice (pyttsx3, Hortense), sentence by sentence.

The sentence is written by the server from `sim.guidance(victim)`: the safest exit for that victim, and that help is coming. It lasts up to about 17 s. The simulated drone hovers 20 s next to each victim it finds (`HOVER_MAX_STEPS` in `sim/drone.py`), so it stays with the victim while it speaks.

Because the drone does not ask, every victim's status stays `unknown`, so the evacuation plan flags every victim found as **rescue first**.

## Files

| File | Role |
|---|---|
| `voice.py` | The drone's voice (the script to run) |
| `mock_server.py` | **Test only**: a fake server with our routes, to test without `server/app.py` |

## Run

```bash
pip install edge-tts miniaudio                                     # once (also in requirements.txt)
python voice/voice.py --server http://SERVER_IP:5050                 # neural voice, Denise
python voice/voice.py --server http://SERVER_IP:5050 --voice fr-FR-HenriNeural   # male voice
python voice/voice.py --server http://SERVER_IP:5050 --offline       # offline Windows voice only
python voice/voice.py --test "La sortie la plus sûre est la sortie E1."           # one try, no server
```

Other French voices: `fr-FR-EloiseNeural`, `fr-FR-VivienneMultilingualNeural`, `fr-FR-RemyMultilingualNeural`.
