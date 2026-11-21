# voice/: the drone's voice

`voice.py` speaks to victims and listens to their answer.

1. Polls `GET /api/voice/next` every second and receives `{"victim": "V1", "say": "..."}` or `{}`.
2. Speaks the text offline, in French (pyttsx3).
3. Listens for 5 s (SpeechRecognition) and matches keywords:
   - `oui`, `je peux` → `walking`
   - `blessé`, `aide`, `mal`, `non` → `injured`
   - nothing heard → `no_answer`
4. Sends `POST /api/voice {"victim": "V1", "heard": "...", "status": "walking|injured|no_answer"}`.

If the microphone fails, you can type the answer on the keyboard instead.

## Run

```bash
python voice/voice.py --server http://SERVER_IP:5000
```
