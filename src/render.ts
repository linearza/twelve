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

export interface RenderInput {
  dir: string;
  image: string;
  clips: AudioClip[];
  duration: number;
  titleAt: number;
  title: string;
  tagline: string;
}

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

export async function render(input: RenderInput): Promise<string> {
  if (!ffmpegPath) throw new Error("ffmpeg-static has no binary for this platform");
  const font = FONT_CANDIDATES.find((f) => f && existsSync(f));
  if (!font) throw new Error("No bold font found - set FONT_FILE in .env to a .ttf path");

  const { dir, image, clips, duration, titleAt } = input;
  const titleFile = path.join(dir, "title.txt");
  const taglineFile = path.join(dir, "tagline.txt");
  await writeFile(titleFile, input.title.toUpperCase());
  await writeFile(taglineFile, input.tagline);

  const frames = Math.ceil(duration * 30);
  const fadeIn = `if(lt(t,${titleAt}),0,min(1,(t-${titleAt})/0.6))`;
  const video = [
    // Fill a 16:9 frame, then a slow Ken Burns push-in rendered at 2x to avoid jitter.
    `[0:v]scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,scale=3840:2160`,
    `zoompan=z='1+0.18*on/${frames}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=1280x720:fps=30`,
    `eq=contrast=1.08:saturation=0.85`,
    // Letterbox bars, then darken the frame for the title card.
    `drawbox=x=0:y=0:w=iw:h=72:color=black:t=fill`,
    `drawbox=x=0:y=ih-72:w=iw:h=72:color=black:t=fill`,
    `drawbox=x=0:y=72:w=iw:h=ih-144:color=black@0.65:t=fill:enable='gte(t,${titleAt})'`,
    `drawtext=fontfile=${quote(font)}:textfile=${quote(titleFile)}:fontsize=96:fontcolor=white:x=(w-text_w)/2:y=(h-text_h)/2-30:alpha='${fadeIn}':enable='gte(t,${titleAt})'`,
    `drawtext=fontfile=${quote(font)}:textfile=${quote(taglineFile)}:fontsize=34:fontcolor=0xDDDDDD:x=(w-text_w)/2:y=(h/2)+60:alpha='${fadeIn}':enable='gte(t,${titleAt})'`,
    `fade=t=in:st=0:d=0.8,fade=t=out:st=${(duration - 0.8).toFixed(2)}:d=0.8,format=yuv420p[v]`,
  ].join(",");

  const audio = clips.map((c, i) => {
    const ms = Math.round(c.start * 1000);
    return `[${i + 1}:a]aformat=sample_rates=44100:channel_layouts=stereo,adelay=${ms}|${ms},volume=${c.volume}[a${i}]`;
  });
  const mix =
    clips.map((_, i) => `[a${i}]`).join("") +
    `amix=inputs=${clips.length}:normalize=0:duration=longest,` +
    `atrim=0:${duration.toFixed(2)},afade=t=out:st=${(duration - 1.2).toFixed(2)}:d=1.2,loudnorm=I=-14:TP=-1.5,aresample=48000[a]`;

  const filterScript = path.join(dir, "filter.txt");
  await writeFile(filterScript, [video, ...audio, mix].join(";\n"));

  const out = path.join(dir, "trailer.mp4");
  await run(
    ffmpegPath,
    [
      "-y", "-loglevel", "error",
      "-loop", "1", "-framerate", "30", "-t", duration.toFixed(2), "-i", image,
      ...clips.flatMap((c) => (c.loop ? ["-stream_loop", "-1", "-i", c.file] : ["-i", c.file])),
      "-filter_complex_script", filterScript,
      "-map", "[v]", "-map", "[a]",
      "-c:v", "libx264", "-preset", "medium", "-crf", "21",
      "-c:a", "aac", "-b:a", "192k",
      "-movflags", "+faststart", "-shortest",
      out,
    ],
    { maxBuffer: 16 * 1024 * 1024 },
  );
  return out;
}
