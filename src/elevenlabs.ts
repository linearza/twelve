const API = "https://api.elevenlabs.io/v1";

// A deep, steady narrator. Override with ELEVENLABS_VOICE_ID to pick your own from the Voice Library.
const DEFAULT_VOICE_ID = "JBFqnCBsd6RMkjVDRZzb";

// The free plan allows 2 requests in flight; callers should stay at or under this.
export const MAX_CONCURRENT = Number(process.env.ELEVENLABS_CONCURRENCY) || 2;

async function post(path: string, body: unknown, attempt = 1): Promise<Buffer> {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) throw new Error("ELEVENLABS_API_KEY is not set - add it to .env");

  const res = await fetch(`${API}${path}`, {
    method: "POST",
    headers: { "xi-api-key": key, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (res.status === 429 && attempt < 4) {
    await new Promise((r) => setTimeout(r, 1500 * attempt));
    return post(path, body, attempt + 1);
  }
  if (!res.ok) {
    throw new Error(`ElevenLabs ${path} failed (${res.status}): ${await res.text()}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

export function narrate(text: string): Promise<Buffer> {
  const voice = process.env.ELEVENLABS_VOICE_ID || DEFAULT_VOICE_ID;
  return post(`/text-to-speech/${voice}?output_format=mp3_44100_128`, {
    text,
    model_id: "eleven_multilingual_v2",
    voice_settings: { stability: 0.35, similarity_boost: 0.8, style: 0.6 },
  });
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
