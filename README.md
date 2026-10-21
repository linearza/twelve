# Twelve

Drop in any photo and get back a dramatic movie trailer as an MP4, with narration, sound effects and a score.

1. **Claude** (Opus) looks at the image and writes the trailer: title, tagline, voiceover lines, timed sound-effect cues and a music brief. It uses the Claude API if `ANTHROPIC_API_KEY` is set, otherwise your local [Claude Code](https://claude.com/claude-code) login (`claude -p`), so no API credits are needed.
2. **ElevenLabs** voices the narration (Text to Speech) and generates each sound effect plus a seamless 10s loop for the score (Sound Effects). On a paid plan, set `ELEVENLABS_MUSIC=1` to compose a real score with the Music API.
3. **ffmpeg** (bundled via `ffmpeg-static`) lays the narration out back to back, places the effects on the timeline, mixes everything to -14 LUFS, and renders a letterboxed Ken Burns video with a title card.

## Setup

```bash
npm install
cp .env.example .env   # then add your ELEVENLABS_API_KEY
```

## Run

```bash
npm start                         # web UI at http://localhost:3000
npm run trailer -- path/to/photo.jpg   # or straight from the terminal
```

Output (the MP4 plus every intermediate clip and `plan.json`) lands in `out/`.

## Free plan budget

Built to fit the ElevenLabs free tier: at most 2 requests in flight (with retry on 429), 4 short sound effects and a looped score. A trailer costs roughly 200-350 of the 10,000 monthly credits.

## Options (`.env`)

| Variable | Default | |
|---|---|---|
| `ELEVENLABS_VOICE_ID` | George | Narrator voice from the Voice Library |
| `FONT_FILE` | Impact / Arial Bold / DejaVu Sans Bold | Bold `.ttf` for the title card |
| `ELEVENLABS_MUSIC` | off | `1` to use the Music API (paid plans) |
| `ELEVENLABS_CONCURRENCY` | `2` | Parallel ElevenLabs requests |
| `PORT` | `3000` | Web UI port |
