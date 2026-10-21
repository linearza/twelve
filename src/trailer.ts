import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { MAX_CONCURRENT, narrate, score, soundEffect } from "./elevenlabs.js";
import { planTrailer, type TrailerPlan } from "./plan.js";
import { durationOf, render, shrinkImage, type AudioClip, type Segment } from "./render.js";

type MediaType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";

const NARRATION_START = 1.5; // breathing room before the first line
const LINE_LEAD = 0.25; // after each cut, before the narrator speaks
const LINE_TAIL = 0.5; // after each line, before the next cut
const CARD_SECONDS = 1.4;
const MAX_CARDS = 2;
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

  onStep("Cutting the trailer");
  const video = await cutTrailer({ dir, plan, image: imageFile, voiceFiles, sfxFiles, scoreFile, scoreLoops });
  return { plan, video };
}

// Lays the recorded audio out against the shot list and renders the MP4. Kept
// separate so an existing job can be re-cut without spending any credits.
export async function cutTrailer(job: {
  dir: string;
  plan: TrailerPlan;
  image: string;
  voiceFiles: string[];
  sfxFiles: string[];
  scoreFile: string;
  scoreLoops: boolean;
}): Promise<string> {
  const { plan, voiceFiles, sfxFiles } = job;
  // One shot per narration line, with optional text cards in between, then the title.
  const segments: Segment[] = [];
  const clips: AudioClip[] = [];
  let t = 0;
  let cards = 0;
  for (const [i, file] of voiceFiles.entries()) {
    const shot = plan.shots[i] ?? { card: "", focus_x: 0.5, focus_y: 0.5, zoom: 1.3, move: "push_in" as const };
    if (shot.card.trim() && cards++ < MAX_CARDS) {
      segments.push({ kind: "card", duration: CARD_SECONDS, text: shot.card.trim() });
      t += CARD_SECONDS;
    }
    const lead = i === 0 ? NARRATION_START : LINE_LEAD;
    const length = lead + (await durationOf(file)) + LINE_TAIL;
    clips.push({ file, start: t + lead, volume: 1.0 });
    segments.push({ kind: "shot", duration: length, focusX: shot.focus_x, focusY: shot.focus_y, zoom: shot.zoom, move: shot.move });
    t += length;
  }
  const titleAt = t;
  const duration = titleAt + TITLE_HOLD;
  segments.push({ kind: "shot", duration: TITLE_HOLD, focusX: 0.5, focusY: 0.5, zoom: 1.15, move: "pull_out" });

  // Claude places effects on a nominal 20s timeline; stretch that to the real length.
  // Impacts snap to the nearest cut so the shake and flash land on the edit.
  const cuts = segments.slice(0, -1).map((_, i) => segments.slice(0, i + 1).reduce((sum, s) => sum + s.duration, 0));
  const impacts: number[] = [];
  const scale = titleAt / 20;
  plan.sound_effects.forEach((fx, i) => {
    let start = Math.min(fx.at_seconds * scale, duration - 1);
    if (fx.impact) {
      start = cuts.reduce((best, cut) => (Math.abs(cut - start) < Math.abs(best - start) ? cut : best), cuts[0]);
      impacts.push(start);
    }
    clips.push({ file: sfxFiles[i], start, volume: 0.7 });
  });

  clips.push({ file: job.scoreFile, start: 0, volume: 0.35, loop: job.scoreLoops });

  return render({ dir: job.dir, image: job.image, segments, clips, impacts, titleAt, title: plan.title, tagline: plan.tagline });
}
