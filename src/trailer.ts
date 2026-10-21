import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { MAX_CONCURRENT, narrate, score, soundEffect } from "./elevenlabs.js";
import { planTrailer, type TrailerPlan } from "./plan.js";
import { durationOf, render, shrinkImage, type AudioClip } from "./render.js";

type MediaType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";

const NARRATION_START = 1.5;
const LINE_GAP = 0.7;
const TITLE_HOLD = 4;
// Keeps credit use predictable on the free plan (~10k credits/month).
const MAX_SOUND_EFFECTS = 4;
const MAX_SFX_SECONDS = 4;

// ElevenLabs limits concurrent requests per plan, so run at most this many at once.
async function pool<T>(tasks: (() => Promise<T>)[], limit = MAX_CONCURRENT): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let next = 0;
  const worker = async () => {
    while (next < tasks.length) {
      const i = next++;
      results[i] = await tasks[i]();
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  return results;
}

export async function makeTrailer(
  image: Buffer,
  mediaType: MediaType,
  dir: string,
  onStep: (step: string) => void = () => {},
): Promise<{ plan: TrailerPlan; video: string }> {
  await mkdir(dir, { recursive: true });
  const original = path.join(dir, `original.${mediaType.split("/")[1]}`);
  const imageFile = path.join(dir, "image.jpg");
  await writeFile(original, image);
  await shrinkImage(original, imageFile);

  onStep("Writing the script");
  const plan = await planTrailer(imageFile, "image/jpeg");
  plan.sound_effects = plan.sound_effects.slice(0, MAX_SOUND_EFFECTS);
  await writeFile(path.join(dir, "plan.json"), JSON.stringify(plan, null, 2));

  onStep("Recording the narrator, foley and score");
  const save = (name: string) => async (audio: Buffer) => {
    const file = path.join(dir, name);
    await writeFile(file, audio);
    return file;
  };
  // One queue for every request so we never exceed the plan's concurrency limit.
  // The score's length is only a target; a looped bed repeats to fit anyway.
  let scoreLoops = false;
  const files = await pool([
    ...plan.narration.map((line, i) => () => narrate(line).then(save(`voice-${i}.mp3`))),
    ...plan.sound_effects.map(
      (fx, i) => () => soundEffect(fx.prompt, Math.min(fx.duration_seconds, MAX_SFX_SECONDS)).then(save(`sfx-${i}.mp3`)),
    ),
    () => score(plan.music_prompt, 20_000).then(({ audio, loop }) => ((scoreLoops = loop), save("score.mp3")(audio))),
  ]);
  const voiceFiles = files.slice(0, plan.narration.length);
  const sfxFiles = files.slice(plan.narration.length, -1);
  const scoreFile = files.at(-1)!;

  // Lay the narration out back to back, then hold on the title card.
  const clips: AudioClip[] = [];
  let t = NARRATION_START;
  for (const file of voiceFiles) {
    clips.push({ file, start: t, volume: 1.0 });
    t += (await durationOf(file)) + LINE_GAP;
  }
  const titleAt = t;
  const duration = titleAt + TITLE_HOLD;

  // Claude places effects on a nominal 20s timeline; stretch that to the real length.
  const scale = titleAt / 20;
  plan.sound_effects.forEach((fx, i) => {
    clips.push({ file: sfxFiles[i], start: Math.min(fx.at_seconds * scale, duration - 1), volume: 0.7 });
  });

  clips.push({ file: scoreFile, start: 0, volume: 0.35, loop: scoreLoops });

  onStep("Cutting the trailer");
  const video = await render({ dir, image: imageFile, clips, duration, titleAt, title: plan.title, tagline: plan.tagline });
  return { plan, video };
}
