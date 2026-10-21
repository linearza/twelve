import "dotenv/config";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { makeTrailer } from "./trailer.js";

const TYPES = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".gif": "image/gif", ".webp": "image/webp" } as const;

const input = process.argv[2];
const mediaType = input && TYPES[path.extname(input).toLowerCase() as keyof typeof TYPES];
if (!mediaType) {
  console.error("Usage: npm run trailer -- <image.jpg|png|gif|webp>");
  process.exit(1);
}

const dir = path.resolve("out", `${path.parse(input).name}-${Date.now()}`);
const { plan, video } = await makeTrailer(await readFile(input), mediaType, dir, (step) => console.log(`→ ${step}`));
console.log(`\n${plan.title.toUpperCase()} — ${plan.tagline}\n${plan.narration.map((l) => `  "${l}"`).join("\n")}\n\n${video}`);
