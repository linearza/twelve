import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { promisify } from "node:util";

// ffmpeg-static is CommonJS and exports the binary path directly.
const ffmpegPath: string | null = createRequire(import.meta.url)("ffmpeg-static");
const run = promisify(execFile);

const FONT_CANDIDATES = [
  process.env.FONT_FILE,
  "/System/Library/Fonts/Supplemental/Impact.ttf",
  "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
  "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
  "C:\\Windows\\Fonts\\impact.ttf",
];

export interface AudioClip {
  file: string;
  start: number; // seconds into the trailer
  volume: number;
  loop?: boolean; // repeat until the trailer ends
}

export type Move = "push_in" | "pull_out" | "pan_left" | "pan_right";

// The trailer is cut from a list of segments: shots of the photo and black text cards.
export type Segment =
  | { kind: "shot"; duration: number; focusX: number; focusY: number; zoom: number; move: Move }
  | { kind: "card"; duration: number; text: string };

export interface RenderInput {
  dir: string;
  image: string;
  segments: Segment[];
  clips: AudioClip[];
  impacts: number[]; // seconds where the camera shakes and the frame flashes
  titleAt: number;
  title: string;
  tagline: string;
}

const FPS = 30;

// Decodes the whole file so the length is exact (MP3 headers only give an estimate).
export async function durationOf(file: string): Promise<number> {
  if (!ffmpegPath) throw new Error("ffmpeg-static has no binary for this platform");
  const { stderr } = await run(ffmpegPath, ["-hide_banner", "-i", file, "-f", "null", "-"]);
  const times = [...stderr.matchAll(/time=(\d+):(\d+):([\d.]+)/g)];
  const last = times.at(-1);
  if (!last) throw new Error(`Could not read the duration of ${file}`);
  return Number(last[1]) * 3600 + Number(last[2]) * 60 + Number(last[3]);
}

// Phone photos are often 5-15 MB; Claude caps images at 5 MB and the video is 720p anyway.
export async function shrinkImage(input: string, output: string): Promise<void> {
  if (!ffmpegPath) throw new Error("ffmpeg-static has no binary for this platform");
  await run(ffmpegPath, [
    "-y", "-loglevel", "error", "-i", input,
    "-vf", "scale='min(1920,iw)':'min(1920,ih)':force_original_aspect_ratio=decrease",
    "-frames:v", "1", "-q:v", "3", output,
  ]);
}

// Escapes a path for use inside a single-quoted ffmpeg filter option.
const quote = (p: string) => `'${p.replace(/\\/g, "/").replace(/'/g, "'\\''").replace(/:/g, "\\:")}'`;

// ffmpeg -i with no output exits non-zero but still prints the stream info.
async function imageSize(file: string): Promise<{ width: number; height: number }> {
  const { stderr } = await run(ffmpegPath!, ["-hide_banner", "-i", file]).catch((err) => err);
  const match = /, (\d{2,5})x(\d{2,5})[, ]/.exec(stderr ?? "");
  if (!match) throw new Error(`Could not read the size of ${file}`);
  return { width: Number(match[1]), height: Number(match[2]) };
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const num = (n: number) => `(${n.toFixed(4)})`;

// One zoompan per shot. The photo is fitted into a 16:9 canvas, so map the
// focus point from image coordinates to canvas coordinates first.
function shotFilter(shot: Extract<Segment, { kind: "shot" }>, frames: number, fit: { x: number; y: number; w: number; h: number }) {
  // Near-16:9 photos zoom just far enough to hide the blurred backdrop; tall ones can't.
  const cover = 1 / Math.min(fit.w, fit.h);
  const floor = cover <= 1.4 ? cover : 1;
  const zoom = clamp(shot.zoom, Math.max(1.1, floor), 2.5);
  const wide = Math.max(floor, zoom * 0.8);
  const [z0, z1] = shot.move === "push_in" ? [wide, zoom] : shot.move === "pull_out" ? [zoom, wide] : [zoom, zoom];
  const pan = shot.move === "pan_left" ? -0.08 : shot.move === "pan_right" ? 0.08 : 0;
  const fx = fit.x + clamp(shot.focusX, 0, 1) * fit.w;
  const fy = fit.y + clamp(shot.focusY, 0, 1) * fit.h;

  const p = `min(1,on/${frames})`;
  const ease = `(${p})*(${p})*(3-2*(${p}))`; // smoothstep, so moves settle instead of stopping dead
  const z = `${num(z0)}+${num(z1 - z0)}*${ease}`;
  const x = `clip((${num(fx - pan)}+${num(2 * pan)}*${ease})*iw-iw/zoom/2,0,iw-iw/zoom)`;
  const y = `clip(${num(fy)}*ih-ih/zoom/2,0,ih-ih/zoom)`;
  return `zoompan=z='${z}':x='${x}':y='${y}':d=${frames}:s=1280x720:fps=${FPS}`;
}

export async function render(input: RenderInput): Promise<string> {
  if (!ffmpegPath) throw new Error("ffmpeg-static has no binary for this platform");
  const font = FONT_CANDIDATES.find((f) => f && existsSync(f));
  if (!font) throw new Error("No bold font found - set FONT_FILE in .env to a .ttf path");

  const { dir, image, segments, clips, impacts, titleAt } = input;
  const titleFile = path.join(dir, "title.txt");
  const taglineFile = path.join(dir, "tagline.txt");
  await writeFile(titleFile, input.title.toUpperCase());
  await writeFile(taglineFile, input.tagline);

  // Round on cumulative boundaries so the cuts stay in sync with the audio.
  let elapsed = 0;
  const frames = segments.map((s) => {
    const from = Math.round(elapsed * FPS);
    elapsed += s.duration;
    return Math.round(elapsed * FPS) - from;
  });
  const duration = elapsed;

  const { width, height } = await imageSize(image);
  const aspect = width / height;
  const fit = aspect < 16 / 9
    ? { w: aspect / (16 / 9), h: 1, x: (1 - aspect / (16 / 9)) / 2, y: 0 }
    : { w: 1, h: (16 / 9) / aspect, x: 0, y: (1 - (16 / 9) / aspect) / 2 };

  const shots = segments.flatMap((s, i) => (s.kind === "shot" ? [i] : []));
  const graph: string[] = [
    // The photo fitted over a blurred copy of itself, at 4K so the zooms stay sharp.
    `[0:v]split[bg][fg]`,
    `[bg]scale=960:540:force_original_aspect_ratio=increase,crop=960:540,boxblur=20:2,eq=brightness=-0.12,scale=3840:2160[blur]`,
    `[fg]scale=3840:2160:force_original_aspect_ratio=decrease[photo]`,
    `[blur][photo]overlay=(W-w)/2:(H-h)/2,split=${shots.length}${shots.map((i) => `[p${i}]`).join("")}`,
  ];
  for (const [i, s] of segments.entries()) {
    if (s.kind === "shot") {
      graph.push(`[p${i}]${shotFilter(s, frames[i], fit)},setsar=1,format=yuv420p[s${i}]`);
    } else {
      const cardFile = path.join(dir, `card-${i}.txt`);
      await writeFile(cardFile, s.text.toUpperCase());
      graph.push(
        `color=c=black:s=1280x720:r=${FPS}:d=${(frames[i] / FPS + 0.1).toFixed(3)},trim=end_frame=${frames[i]},` +
          `drawtext=fontfile=${quote(font)}:textfile=${quote(cardFile)}:fontsize=84:fontcolor=white:` +
          `x=(w-text_w)/2:y=(h-text_h)/2:alpha='min(1,t/0.25)',setsar=1,format=yuv420p[s${i}]`,
      );
    }
  }

  // Impacts kick the frame around for a moment and blow it out to white.
  const shake = impacts.map((t0) => `14*between(t,${t0.toFixed(3)},${(t0 + 0.4).toFixed(3)})*(1-(t-${t0.toFixed(3)})/0.4)`).join("+") || "0";
  const flash = impacts.map((t0) => `0.6*gte(t,${t0.toFixed(3)})*exp(-10*(t-${t0.toFixed(3)}))`).join("+") || "0";
  const flicker = `0.015*sin(t*41)*sin(t*7.3)`;
  const fadeIn = `if(lt(t,${titleAt}),0,min(1,(t-${titleAt})/0.6))`;
  graph.push(
    [
      segments.map((_, i) => `[s${i}]`).join("") + `concat=n=${segments.length}:v=1:a=0`,
      `scale=1332:750,crop=1280:720:x='26+(${shake})*sin(t*83)':y='15+(${shake})*cos(t*71)',setsar=1`,
      `eq=contrast=1.08:saturation=0.85:brightness='min(0.8,${flicker}+${flash})':eval=frame`,
      `vignette=PI/5`,
      `noise=alls=10:allf=t+u`,
      // Letterbox bars, then darken the frame for the title card.
      `drawbox=x=0:y=0:w=iw:h=72:color=black:t=fill`,
      `drawbox=x=0:y=ih-72:w=iw:h=72:color=black:t=fill`,
      `drawbox=x=0:y=72:w=iw:h=ih-144:color=black@0.65:t=fill:enable='gte(t,${titleAt})'`,
      `drawtext=fontfile=${quote(font)}:textfile=${quote(titleFile)}:fontsize=96:fontcolor=white:x=(w-text_w)/2:y=(h-text_h)/2-30:alpha='${fadeIn}':enable='gte(t,${titleAt})'`,
      `drawtext=fontfile=${quote(font)}:textfile=${quote(taglineFile)}:fontsize=34:fontcolor=0xDDDDDD:x=(w-text_w)/2:y=(h/2)+60:alpha='${fadeIn}':enable='gte(t,${titleAt})'`,
      `fade=t=in:st=0:d=0.8,fade=t=out:st=${(duration - 0.8).toFixed(2)}:d=0.8,format=yuv420p[v]`,
    ].join(","),
  );

  const audio = clips.map((c, i) => {
    const ms = Math.round(c.start * 1000);
    return `[${i + 1}:a]aformat=sample_rates=44100:channel_layouts=stereo,adelay=${ms}|${ms},volume=${c.volume}[a${i}]`;
  });
  const mix =
    clips.map((_, i) => `[a${i}]`).join("") +
    `amix=inputs=${clips.length}:normalize=0:duration=longest,` +
    `atrim=0:${duration.toFixed(2)},afade=t=out:st=${(duration - 1.2).toFixed(2)}:d=1.2,loudnorm=I=-14:TP=-1.5,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[a]`;

  const filterScript = path.join(dir, "filter.txt");
  await writeFile(filterScript, [...graph, ...audio, mix].join(";\n"));

  const out = path.join(dir, "trailer.mp4");
  await run(
    ffmpegPath,
    [
      "-y", "-loglevel", "error",
      "-i", image,
      ...clips.flatMap((c) => (c.loop ? ["-stream_loop", "-1", "-i", c.file] : ["-i", c.file])),
      "-filter_complex_script", filterScript,
      "-map", "[v]", "-map", "[a]",
      "-c:v", "libx264", "-preset", "medium", "-crf", "21",
      "-c:a", "aac", "-b:a", "192k",
      "-movflags", "+faststart", "-t", duration.toFixed(2),
      out,
    ],
    { maxBuffer: 16 * 1024 * 1024 },
  );
  return out;
}
