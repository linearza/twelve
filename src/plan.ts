import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { CAST, type CastId } from "./elevenlabs.js";
import { STYLES, type StyleId } from "./styles.js";

type MediaType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";

// What Claude hands back after looking at the image: the script for the trailer.
export const TrailerPlan = z.object({
  title: z.string().describe("Punchy movie title, 1-4 words"),
  tagline: z.string().describe("One short line shown under the title card"),
  genre: z.string().describe("e.g. action, horror, epic fantasy, romcom, nature documentary"),
  narration: z
    .array(z.string())
    .describe(
      "6-8 trailer voiceover lines, each under 14 words, building to a climax: setup, rising stakes, a twist, the payoff. " +
        "Direct the delivery with audio tags in square brackets, e.g. [whispers], [excited], [sighs], [laughs], [dramatic pause], [shouting]: about one tag per line, where it adds something.",
    ),
  scene: z
    .object({
      after_line: z.number().int().describe("Index of the narration line this scene plays after, 0-based"),
      focus_x: z.number().describe("Horizontal centre of who is talking: 0 is the left edge of the image, 1 the right"),
      focus_y: z.number().describe("Vertical centre: 0 is the top, 1 the bottom"),
      zoom: z.number().describe("How tight the shot is: 1.2 is wide, 2.5 an extreme close-up"),
      lines: z
        .array(
          z.object({
            character: z.string().describe("Who speaks, e.g. 'THE PUPPY'"),
            voice: z.enum(Object.keys(CAST) as [CastId, ...CastId[]]),
            text: z.string().describe("Under 10 words; audio tags like [gasps] or [laughs] welcome"),
          }),
        )
        .describe("2-4 lines between two characters"),
    })
    .describe(
      "A short in-world exchange between two characters from the photo (people, pets or objects given a voice), like the dialogue clip in a real trailer. " +
        `Cast each character with a voice that fits: ${Object.entries(CAST).map(([id, { about }]) => `${id} (${about})`).join(", ")}.`,
    ),
  sound_effects: z
    .array(
      z.object({
        prompt: z.string().describe("A single, concrete sound for a sound-effects model, e.g. 'deep cinematic boom with sub bass'"),
        at_seconds: z.number().describe("When it hits, on a 0-40 second timeline"),
        duration_seconds: z.number().describe("Length in seconds, 1-4"),
        impact: z.boolean().describe("True for hits (booms, slams, stingers): these land on a cut with a camera shake and a flash"),
      }),
    )
    .describe("5-6 sound effects spread across the trailer: things visible in the image plus the style's staples. Make 2-3 of them impacts."),
  shots: z
    .array(
      z.object({
        card: z
          .string()
          .describe("Optional 1-3 word black text card shown before this shot, e.g. 'THIS FALL'. Empty string for none; use on at most three shots."),
        focus_x: z.number().describe("Horizontal centre of what the shot frames: 0 is the left edge of the image, 1 the right"),
        focus_y: z.number().describe("Vertical centre: 0 is the top of the image, 1 the bottom"),
        zoom: z.number().describe("How tight the shot is: 1.2 is a wide shot, 2.5 an extreme close-up"),
        move: z.enum(["push_in", "pull_out", "pan_left", "pan_right"]),
      }),
    )
    .describe("Exactly one shot per narration line, in order: what the camera frames while that line plays. Frame the details each line talks about and vary the moves."),
  music_prompt: z.string().describe("Instrumental trailer music description matching the genre, no vocals"),
});
export type TrailerPlan = z.infer<typeof TrailerPlan>;

const SYSTEM = `You write over-the-top, affectionate movie trailers for ordinary photos people share with their coworkers.
Keep it funny and kind - never mock how a person looks. Ground the jokes in specific details you can see.`;

const systemFor = (style: StyleId) => `${SYSTEM}\n\n${STYLES[style].brief}`;

const run = promisify(execFile);

// With an API key, call the Claude API directly. Without one, borrow the local
// Claude Code login so the app runs on your existing subscription.
export function planTrailer(imagePath: string, mediaType: MediaType, style: StyleId = "epic"): Promise<TrailerPlan> {
  return process.env.ANTHROPIC_API_KEY ? planWithApi(imagePath, mediaType, style) : planWithClaudeCode(imagePath, style);
}

async function planWithClaudeCode(imagePath: string, style: StyleId): Promise<TrailerPlan> {
  const { $schema, ...schema } = z.toJSONSchema(TrailerPlan);
  let stdout: string;
  try {
    ({ stdout } = await run(
      "claude",
      [
        "-p", `Write the trailer for the image ${path.basename(imagePath)}. Read it first.`,
        "--output-format", "json",
        "--json-schema", JSON.stringify(schema),
        "--system-prompt", systemFor(style),
        "--tools", "Read",
        "--model", "opus",
        "--no-session-persistence",
      ],
      { cwd: path.dirname(imagePath), maxBuffer: 16 * 1024 * 1024, timeout: 5 * 60 * 1000 },
    ));
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string };
    if (e.code === "ENOENT") throw new Error("No ANTHROPIC_API_KEY and the `claude` CLI isn't installed - set one up.");
    throw new Error(`Claude Code failed: ${e.stderr?.trim() || e.message}`);
  }

  const result = JSON.parse(stdout);
  if (result.is_error || !result.structured_output) {
    throw new Error(`Claude Code returned no trailer plan: ${result.result ?? result.subtype}`);
  }
  return TrailerPlan.parse(result.structured_output);
}

async function planWithApi(imagePath: string, mediaType: MediaType, style: StyleId): Promise<TrailerPlan> {
  const image = await readFile(imagePath);
  const response = await new Anthropic().beta.messages.parse({
    model: "claude-opus-5-5",
    max_tokens: 16000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: "medium", format: zodOutputFormat(TrailerPlan) },
    system: systemFor(style),
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: mediaType, data: image.toString("base64") } },
          { type: "text", text: "Write the trailer for this image." },
        ],
      },
    ],
  });

  if (response.stop_reason === "refusal") {
    throw new Error("Claude declined to write a trailer for this image - try another one.");
  }
  if (!response.parsed_output) {
    throw new Error(`Claude returned no trailer plan (stop_reason: ${response.stop_reason})`);
  }
  return response.parsed_output;
}
