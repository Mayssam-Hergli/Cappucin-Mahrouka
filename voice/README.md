# voice/: the drone's voice

`voice.py` speaks to victims in **Tunisian Arabic (Derja) and French**, listens to their answer, and tells the server.

1. Polls `GET /api/voice/next` every second and receives `{"victim": "V1", "say": "..."}` or `{}`.
2. Speaks:
   - **Derja**: real recorded voice clips (offline). The exit number (E1, E2, E3) is read from the server's text.
   - **French**: the server's text, with the offline Windows voice (pyttsx3).
3. Listens for 5 s and transcribes the answer in Tunisian Arabic and in French (Google speech recognition, needs internet), because people mix both.
4. Matches keywords:
   - `oui`, `je peux`, `ey`, `nnajjem`, `behi` (ايه، نجم، باهي) → `walking`
   - `blessé`, `aide`, `mal`, `non`, `le`, `ma najjemch`, `mjarra7`, `youja3ni` (لا، ما نجمش، مجروح، يوجعني، عاوني) → `injured`
   - nothing heard → `no_answer`
   - **Safety rule:** injured is checked first, and anything unclear counts as injured. Better to send help for nothing than to leave someone behind.
5. Sends `POST /api/voice {"victim": "V1", "heard": "...", "status": "walking|injured|no_answer"}`.
6. Says a closing sentence for that status (stay still, help is coming / walk to the exit / knock on the wall).

If the microphone or the internet fails, you type the answer on the keyboard. If the Derja clips are missing, the drone speaks French only.

## Files

| File | Role |
|---|---|
| `voice.py` | The drone's voice (the script to run) |
| `clips.py` | The list of Derja clips and the sentence to say in each |
| `record_clips.py` | Records the Derja clips with the laptop mic |
| `clips/` | The recorded `.wav` clips |
| `mock_server.py` | **Test only**: a fake server with our 3 routes, to test without `server/app.py` |

## Run

```bash
python voice/record_clips.py                                  # once: record the Derja clips
python voice/voice.py --server http://SERVER_IP:5000          # Derja + French
python voice/voice.py --server http://SERVER_IP:5000 --lang fr   # French only
python voice/voice.py --test "Pouvez-vous marcher ?"          # one try, no server
```
