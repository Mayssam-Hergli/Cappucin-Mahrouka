# voice/: the drone's voice

When the drone finds a victim, `voice.py` tells them, in French, where to go and that the Protection Civile is on its way. The drone speaks only; it does not listen for an answer.

1. Polls `GET /api/voice/next` every second and receives `{"victim": "V1", "say": "..."}` or `{}`.
2. Speaks the text offline with the Windows French voice (pyttsx3).

The sentence is written by the server from `sim.guidance(victim)`: the safest exit for that victim, and that help is coming.

Because the drone does not ask, every victim's status stays `unknown`, so the evacuation plan flags every victim found as **rescue first**.

## Files

| File | Role |
|---|---|
| `voice.py` | The drone's voice (the script to run) |
| `mock_server.py` | **Test only**: a fake server with our routes, to test without `server/app.py` |

## Run

```bash
python voice/voice.py --server http://SERVER_IP:5000
python voice/voice.py --test "La sortie la plus sûre est la sortie E1."   # one try, no server
```
