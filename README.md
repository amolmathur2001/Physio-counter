# Physio Counter

A phone web app that counts physiotherapy reps out loud. You set the tempo, hold, target count, sets and rest. It stops at the target, and you can start again with one tap or by saying "again".

- **Counting** runs entirely on the phone (offline-capable PWA, browser speech).
- **Hands-free voice**: common commands (stop, continue, again, next set, skip rest, slower, faster) are matched on the phone instantly. Anything else goes to Claude (`/api/command`).
- **Prescription import**: type the physio's notes or snap a photo of the sheet. Claude turns it into counter settings (`/api/prescription`).

## Run

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
export ANTHROPIC_API_KEY=sk-ant-...      # optional: without it, counting and basic voice commands still work
.venv/bin/uvicorn app.main:app --host 0.0.0.0 --port 8000
```

Open http://localhost:8000 on the computer.

### On your phone

Microphone access and "Add to Home Screen" need **HTTPS** when you aren't on localhost. The easiest way is a tunnel:

```bash
cloudflared tunnel --url http://localhost:8000    # or: ngrok http 8000
```

Open the `https://…` URL it prints on the phone, then use Share → Add to Home Screen.

## Deploy to Render

`render.yaml` describes the service. Push this folder to GitHub, then on render.com choose **New → Blueprint** and pick the repo. Render asks for two secrets:

- `ANTHROPIC_API_KEY`: your Claude API key.
- `APP_ACCESS_CODE`: any passphrase. The phone asks for it the first time you use an AI feature and remembers it. Without it, anyone with the URL could spend your credits.

AI endpoints are also rate-limited to 40 requests per 10 minutes per client.

## Layout

```
app/main.py     FastAPI: serves static/ and the two /api endpoints
app/ai.py       Claude calls (structured outputs → Pydantic models)
static/app.js   counter engine (timed step list), speech in/out, routines, import UI
static/sw.js    offline cache for the app shell
```
