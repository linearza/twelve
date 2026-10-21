import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";

type MediaType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";

// What Claude hands back after looking at the image: the script for the trailer.
export const TrailerPlan = z.object({
  title: z.string().describe("Punchy movie title, 1-4 words"),
  tagline: z.string().describe("One short line shown under the title card"),
  genre: z.string().describe("e.g. action, horror, epic fantasy, romcom, nature documentary"),
  narration: z
    .array(z.string())
    .describe("3-4 trailer voiceover lines, each under 14 words. The first usually starts 'In a world...'"),
  sound_effects: z
    .array(
      z.object({
        prompt: z.string().describe("A single, concrete sound for a sound-effects model, e.g. 'deep cinematic boom with sub bass'"),
        at_seconds: z.number().describe("When it hits, on a 0-20 second timeline"),
        duration_seconds: z.number().describe("Length in seconds, 1-4"),
      }),
    )
    .describe("3-4 sound effects: things visible in the image plus trailer staples (whooshes, booms, risers)"),
  music_prompt: z.string().describe("Instrumental trailer music description matching the genre, no vocals"),
});
export type TrailerPlan = z.infer<typeof TrailerPlan>;

const SYSTEM = `You write over-the-top, affectionate movie trailers for ordinary photos people share with their coworkers.
Treat the mundane as epic: a messy desk is a war zone, a team lunch is a heist crew assembling.
Keep it funny and kind - never mock how a person looks. Ground the jokes in specific details you can see.`;

const run = promisify(execFile);

// With an API key, call the Claude API directly. Without one, borrow the local
// Claude Code login so the app runs on your existing subscription.
export function planTrailer(imagePath: string, mediaType: MediaType): Promise<TrailerPlan> {
  return process.env.ANTHROPIC_API_KEY ? planWithApi(imagePath, mediaType) : planWithClaudeCode(imagePath);
}

async function planWithClaudeCode(imagePath: string): Promise<TrailerPlan> {
  const { $schema, ...schema } = z.toJSONSchema(TrailerPlan);
  let stdout: string;
  try {
    ({ stdout } = await run(
      "claude",
      [
        "-p", `Write the trailer for the image ${path.basename(imagePath)}. Read it first.`,
        "--output-format", "json",
        "--json-schema", JSON.stringify(schema),
        "--system-prompt", SYSTEM,
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

async function planWithApi(imagePath: string, mediaType: MediaType): Promise<TrailerPlan> {
  const image = await readFile(imagePath);
  const response = await new Anthropic().beta.messages.parse({
    model: "claude-opus-5-5",
    max_tokens: 16000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: "medium", format: zodOutputFormat(TrailerPlan) },
    system: SYSTEM,
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
