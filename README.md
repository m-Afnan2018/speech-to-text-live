# 🎙️ Speech to Text: Real-time Multilingual Transcription

**🔗 Live demo:** https://stt.dexploit.space

A web app that transcribes speech **live as you talk**, including **code-mixed Hindi + English (Hinglish)**. Every transcription is stored in **PostgreSQL**, and a **history dashboard** supports full CRUD (create, read, update, delete) plus search and pagination.

Built for the Procucev AI tech hiring assignment.

## Features

| Feature | How |
|---|---|
| Real-time speech-to-text | Mic audio → 16 kHz PCM (AudioWorklet) → WebSocket → Node proxy → **Gemini Live API** (`gemini-3.5-transcribe-live`) |
| Multilingual / code-switching | Auto language detection, or explicit `hi-IN + en-IN` hints for Hinglish |
| Interim + final results | Grey italic interim words update while you speak and are replaced by final text at each pause |
| Persistent history | PostgreSQL `transcriptions` table |
| Dashboard CRUD | List, search, paginate, create manually, edit, delete, copy |
| Text-to-Speech | Browser-native Web Speech `speechSynthesis` (on-device; picks a Hindi voice when it detects Devanagari) |
| Secure key handling | The Gemini API key stays on the server; the browser only talks to our WebSocket |

## Architecture

```
Browser (mic) ── AudioWorklet: resample → Int16 PCM, 100 ms chunks
     │  binary frames over  wss://<host>/ws/transcribe?lang=auto|hi-en|en|hi
     ▼
Node.js (Express + ws) ── liveProxy.js ──► Gemini Live BidiGenerateContent (WebSocket)
     │                     ◄── serverContent.interimInputTranscription / inputTranscription
     │  {type:"interim"|"final", text}
     ▼
Browser renders live text → "Save" → REST API → PostgreSQL
```

## Tech stack
- **Backend:** Node.js 20, Express, `ws`, `pg`
- **Database:** PostgreSQL 16
- **STT:** Google Gemini Live API (free tier)
- **Frontend:** Vanilla JS, HTML, CSS (no build step), AudioWorklet
- **Deploy:** Docker Compose behind Nginx with Let's Encrypt TLS

## REST API

| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/transcriptions?q=&limit=&offset=` | List and search (newest first) |
| GET | `/api/transcriptions/:id` | Get one |
| POST | `/api/transcriptions` | Create `{title?, content, language?, duration_ms?}` |
| PUT | `/api/transcriptions/:id` | Update any of `title, content, language` |
| DELETE | `/api/transcriptions/:id` | Delete |
| GET | `/api/health` | DB and API-key status |
| WS | `/ws/transcribe?lang=auto` | Streaming transcription |

## Run locally

```bash
cp .env.example .env          # then add your GEMINI_API_KEY (https://aistudio.google.com/apikey)
docker compose up -d --build  # app on http://localhost:3110
```

Without Docker: start PostgreSQL, set `DATABASE_URL` in `.env`, then run `npm install && npm start`.

> The microphone needs a secure context: use `localhost` or HTTPS.

## Database schema

```sql
CREATE TABLE transcriptions (
  id          SERIAL PRIMARY KEY,
  title       VARCHAR(200) NOT NULL DEFAULT 'Untitled',
  content     TEXT         NOT NULL,
  language    VARCHAR(50)  NOT NULL DEFAULT 'auto',
  duration_ms INTEGER      NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
```

The table is created automatically on startup.

## Possible improvements
- Self-hosted open-source STT (faster-whisper / Vosk) as a pluggable backend for fully offline use
- Open-source TTS (Piper / Coqui XTTS) served by the backend
- User accounts so each user has their own history
- Automatic reconnect across Gemini's 10-minute session limit
