import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const API = "https://api.elevenlabs.io/v1";

// A deep, steady narrator, used when a style doesn't design its own.
// Override with ELEVENLABS_VOICE_ID to pick your own from the Voice Library.
const DEFAULT_VOICE_ID = "JBFqnCBsd6RMkjVDRZzb";

// Eleven v3 follows audio tags like [whispers] and [laughs] in the text.
const MODEL = "eleven_v3";

// Premade voices Claude can cast characters with. These don't use custom voice slots.
export const CAST = {
  roger: { id: "CwhRBWXzGAHq8TQ4Fs17", about: "laid-back, resonant middle-aged American man" },
  sarah: { id: "EXAVITQu4vr4xnSDxMaL", about: "mature, reassuring young American woman" },
  laura: { id: "FGY2WhTYpPnrIDTdsKH5", about: "quirky, sassy young American woman" },
  charlie: { id: "IKne3meq5aSn9XLyUdCD", about: "deep, hyped young Australian man" },
  callum: { id: "N2lVS1w4EtoT3dr4eOWO", about: "husky trickster, middle-aged man" },
  harry: { id: "SOYHLrjzK2X1ezoPC6cr", about: "fierce, rough young warrior" },
  alice: { id: "Xb7hH8MSUJpSbSDYk0k2", about: "clear, engaging British woman" },
  will: { id: "bIHbv24MWmeRgasZH58o", about: "relaxed, chill young American man" },
  jessica: { id: "cgSgspJ2msm6clMCkdW9", about: "playful, bright, cute young woman" },
  brian: { id: "nPczCjzI2devNBz1zQrb", about: "deep, resonant, comforting man" },
  daniel: { id: "onwK4e9ZLuTAKqWW03F9", about: "steady, formal British broadcaster" },
  lily: { id: "pFZP5JQG7iQjIQuC4Bku", about: "velvety British actress" },
  adam: { id: "pNInz6obpgDQGcFmaJgB", about: "dominant, firm American man" },
  bill: { id: "pqHfZKP75CvOlQylNhV4", about: "wise, crisp old American man" },
} as const;
export type CastId = keyof typeof CAST;

// The free plan allows 2 requests in flight; callers should stay at or under this.
export const MAX_CONCURRENT = Number(process.env.ELEVENLABS_CONCURRENCY) || 2;

async function post(route: string, body: unknown, attempt = 1): Promise<Buffer> {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) throw new Error("ELEVENLABS_API_KEY is not set - add it to .env");

  const res = await fetch(`${API}${route}`, {
    method: "POST",
    headers: { "xi-api-key": key, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (res.status === 429 && attempt < 4) {
    await new Promise((r) => setTimeout(r, 1500 * attempt));
    return post(route, body, attempt + 1);
  }
  if (!res.ok) {
    throw new Error(`ElevenLabs ${route} failed (${res.status}): ${await res.text()}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

export function narrate(
  text: string,
  voice = DEFAULT_VOICE_ID,
  voiceSettings = { stability: 0.35, similarity_boost: 0.8, style: 0.6 },
): Promise<Buffer> {
  return post(`/text-to-speech/${voice}?output_format=mp3_44100_128`, {
    text,
    model_id: MODEL,
    voice_settings: voiceSettings,
  });
}

// A short scene between characters, voiced in one take so they react to each other.
export function dialogue(lines: { text: string; voice: CastId }[]): Promise<Buffer> {
  return post("/text-to-dialogue?output_format=mp3_44100_128", {
    model_id: MODEL,
    inputs: lines.map(({ text, voice }) => ({ text, voice_id: CAST[voice].id })),
  });
}

// Designed narrators are saved to the account (the free plan has 3 custom voice
// slots) and remembered here, so each style only designs its voice once.
const VOICES_FILE = path.join("out", "voices.json");
const designing = new Map<string, Promise<string>>();

export async function narratorFor(style: string, description?: string): Promise<string> {
  if (process.env.ELEVENLABS_VOICE_ID) return process.env.ELEVENLABS_VOICE_ID;
  if (!description) return DEFAULT_VOICE_ID;
  const saved: Record<string, { description: string; voice_id: string }> = JSON.parse(
    await readFile(VOICES_FILE, "utf8").catch(() => "{}"),
  );
  if (saved[style]?.description === description) return saved[style].voice_id;

  if (!designing.has(style)) {
    designing.set(
      style,
      designVoice(`Twelve ${style} narrator`, description)
        .then(async (voiceId) => {
          const latest = JSON.parse(await readFile(VOICES_FILE, "utf8").catch(() => "{}"));
          await mkdir(path.dirname(VOICES_FILE), { recursive: true });
          await writeFile(VOICES_FILE, JSON.stringify({ ...latest, [style]: { description, voice_id: voiceId } }, null, 2));
          return voiceId;
        })
        .catch((err) => {
          console.warn(`Couldn't design the ${style} narrator, using the default voice: ${(err as Error).message}`);
          return DEFAULT_VOICE_ID;
        })
        .finally(() => designing.delete(style)),
    );
  }
  return designing.get(style)!;
}

async function designVoice(name: string, description: string): Promise<string> {
  const design = JSON.parse(
    (
      await post("/text-to-voice/design", { voice_description: description, model_id: "eleven_ttv_v3", auto_generate_text: true })
    ).toString(),
  );
  const created = JSON.parse(
    (
      await post("/text-to-voice", {
        voice_name: name,
        voice_description: description,
        generated_voice_id: design.previews[0].generated_voice_id,
      })
    ).toString(),
  );
  return created.voice_id;
}

export function soundEffect(prompt: string, durationSeconds: number, loop = false): Promise<Buffer> {
  return post("/sound-generation", {
    text: prompt,
    duration_seconds: Math.min(30, Math.max(0.5, durationSeconds)),
    prompt_influence: 0.5,
    loop,
  });
}

// Real music needs a paid plan, so it's opt-in. The default is a short seamless
// sound-effects loop that the renderer repeats under the whole trailer.
export async function score(prompt: string, lengthMs: number): Promise<{ audio: Buffer; loop: boolean }> {
  if (process.env.ELEVENLABS_MUSIC === "1") {
    try {
      const audio = await post("/music", {
        prompt,
        music_length_ms: Math.min(600_000, Math.max(3000, Math.round(lengthMs))),
        force_instrumental: true,
      });
      return { audio, loop: false };
    } catch (err) {
      console.warn(`Music generation failed, falling back to a looped bed: ${(err as Error).message}`);
    }
  }
  return { audio: await soundEffect(`cinematic trailer music loop, ${prompt}`, 10, true), loop: true };
}
