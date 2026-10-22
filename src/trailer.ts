import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { dialogue, MAX_CONCURRENT, narrate, narratorFor, score, soundEffect } from "./elevenlabs.js";
import { planTrailer, type TrailerPlan } from "./plan.js";
import { STYLES, type Style, type StyleId } from "./styles.js";
import { durationOf, render, shrinkImage, type AudioClip, type Segment } from "./render.js";

type MediaType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";

const NARRATION_START = 1.5; // breathing room before the first line
const LINE_LEAD = 0.25; // after each cut, before the narrator speaks
const LINE_TAIL = 0.5; // after each line, before the next cut
const CARD_SECONDS = 1.4;
const MAX_CARDS = 3;
const TITLE_HOLD = 5;
// The cut stretches the pauses between lines to land on this length.
const TARGET_SECONDS = 45;
const NOMINAL_SECONDS = 40; // the timeline Claude places sound effects on
// Keeps credit use predictable on the free plan (~10k credits/month).
const MAX_LINES = 8;
const MAX_SCENE_LINES = 4;
const MAX_SOUND_EFFECTS = 6;
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
  style: StyleId = "epic",
  onStep: (step: string) => void = () => {},
): Promise<{ plan: TrailerPlan; video: string }> {
  await mkdir(dir, { recursive: true });
  const original = path.join(dir, `original.${mediaType.split("/")[1]}`);
  const imageFile = path.join(dir, "image.jpg");
  await writeFile(original, image);
  await shrinkImage(original, imageFile);

  onStep("Writing the script");
  const plan = await planTrailer(imageFile, "image/jpeg", style);
  plan.narration = plan.narration.slice(0, MAX_LINES);
  plan.sound_effects = plan.sound_effects.slice(0, MAX_SOUND_EFFECTS);
  plan.scene.lines = plan.scene.lines.slice(0, MAX_SCENE_LINES);
  await writeFile(path.join(dir, "plan.json"), JSON.stringify({ style, ...plan }, null, 2));

  onStep("Casting the narrator");
  const narrator = await narratorFor(style, (STYLES[style] as Style).narrator);

  onStep("Recording the narrator, cast, foley and score");
  const save = (name: string) => async (audio: Buffer) => {
    const file = path.join(dir, name);
    await writeFile(file, audio);
    return file;
  };
  // One queue for every request so we never exceed the plan's concurrency limit.
  // The score's length is only a target; a looped bed repeats to fit anyway.
  let scoreLoops = false;
  const files = await pool([
    ...plan.narration.map((line, i) => () => narrate(line, narrator, STYLES[style].voice).then(save(`voice-${i}.mp3`))),
    () => dialogue(plan.scene.lines).then(save("scene.mp3")),
    ...plan.sound_effects.map(
      (fx, i) => () => soundEffect(fx.prompt, Math.min(fx.duration_seconds, MAX_SFX_SECONDS)).then(save(`sfx-${i}.mp3`)),
    ),
    () => score(plan.music_prompt, TARGET_SECONDS * 1000).then(({ audio, loop }) => ((scoreLoops = loop), save("score.mp3")(audio))),
  ]);
  const voiceFiles = files.slice(0, plan.narration.length);
  const sceneFile = files[plan.narration.length];
  const sfxFiles = files.slice(plan.narration.length + 1, -1);
  const scoreFile = files.at(-1)!;

  onStep("Cutting the trailer");
  const video = await cutTrailer({ dir, plan, style, image: imageFile, voiceFiles, sceneFile, sfxFiles, scoreFile, scoreLoops });
  return { plan, video };
}

// Lays the recorded audio out against the shot list and renders the MP4. Kept
// separate so an existing job can be re-cut without spending any credits.
export async function cutTrailer(job: {
  dir: string;
  plan: TrailerPlan;
  style: StyleId;
  image: string;
  voiceFiles: string[];
  sceneFile?: string; // jobs from before scenes existed have none
  sfxFiles: string[];
  scoreFile: string;
  scoreLoops: boolean;
}): Promise<string> {
  const { plan, voiceFiles, sfxFiles } = job;
  // One shot per narration line, with optional text cards in between and the
  // characters' scene after one of the lines, then the title.
  const segments: Segment[] = [];
  const clips: AudioClip[] = [];
  const shots = voiceFiles.map((_, i) => plan.shots[i] ?? { card: "", focus_x: 0.5, focus_y: 0.5, zoom: 1.3, move: "push_in" as const });
  let cardsLeft = MAX_CARDS;
  const cards = shots.map((shot) => (shot.card.trim() && cardsLeft-- > 0 ? shot.card.trim() : ""));
  const lengths = await Promise.all(voiceFiles.map((file) => durationOf(file)));
  const scene = job.sceneFile && plan.scene ? plan.scene : undefined;
  const sceneAfter = scene ? Math.min(Math.max(0, scene.after_line), voiceFiles.length - 1) : -1;
  const sceneLength = scene ? LINE_LEAD + (await durationOf(job.sceneFile!)) + LINE_TAIL : 0;

  // Share whatever is left of the target length out as extra breathing room after each line.
  const natural =
    NARRATION_START + LINE_LEAD * (lengths.length - 1) + lengths.reduce((a, b) => a + b, 0) +
    LINE_TAIL * lengths.length + CARD_SECONDS * cards.filter(Boolean).length + sceneLength + TITLE_HOLD;
  const tail = LINE_TAIL + Math.max(0, TARGET_SECONDS - natural) / lengths.length;

  let t = 0;
  for (const [i, file] of voiceFiles.entries()) {
    const shot = shots[i];
    if (cards[i]) {
      segments.push({ kind: "card", duration: CARD_SECONDS, text: cards[i] });
      t += CARD_SECONDS;
    }
    const lead = i === 0 ? NARRATION_START : LINE_LEAD;
    const length = lead + lengths[i] + tail;
    clips.push({ file, start: t + lead, volume: 1.0, voice: true });
    segments.push({ kind: "shot", duration: length, focusX: shot.focus_x, focusY: shot.focus_y, zoom: shot.zoom, move: shot.move });
    t += length;
    if (scene && i === sceneAfter) {
      clips.push({ file: job.sceneFile!, start: t + LINE_LEAD, volume: 1.0, voice: true });
      segments.push({ kind: "shot", duration: sceneLength, focusX: scene.focus_x, focusY: scene.focus_y, zoom: scene.zoom, move: "push_in" });
      t += sceneLength;
    }
  }
  const titleAt = t;
  const duration = titleAt + TITLE_HOLD;
  segments.push({ kind: "shot", duration: TITLE_HOLD, focusX: 0.5, focusY: 0.5, zoom: 1.15, move: "pull_out" });

  // Claude places effects on a nominal timeline; stretch that to the real length.
  // Impacts snap to the nearest cut so the shake and flash land on the edit.
  const cuts = segments.slice(0, -1).map((_, i) => segments.slice(0, i + 1).reduce((sum, s) => sum + s.duration, 0));
  const impacts: number[] = [];
  const scale = titleAt / NOMINAL_SECONDS;
  plan.sound_effects.forEach((fx, i) => {
    let start = Math.min(fx.at_seconds * scale, duration - 1);
    if (fx.impact) {
      start = cuts.reduce((best, cut) => (Math.abs(cut - start) < Math.abs(best - start) ? cut : best), cuts[0]);
      impacts.push(start);
    }
    clips.push({ file: sfxFiles[i], start, volume: fx.impact ? 0.6 : 0.45 });
  });

  clips.push({ file: job.scoreFile, start: 0, volume: 0.35, loop: job.scoreLoops });

  return render({ dir: job.dir, image: job.image, segments, clips, impacts, titleAt, title: plan.title, tagline: plan.tagline, look: STYLES[job.style].look });
}
