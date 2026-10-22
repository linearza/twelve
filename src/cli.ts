import "dotenv/config";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { STYLE_IDS, isStyle } from "./styles.js";
import { makeTrailer } from "./trailer.js";

const TYPES = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".gif": "image/gif", ".webp": "image/webp" } as const;

const args = process.argv.slice(2);
const flag = args.indexOf("--style");
const style = flag === -1 ? "epic" : args.splice(flag, 2)[1];
const input = args[0];
const mediaType = input && TYPES[path.extname(input).toLowerCase() as keyof typeof TYPES];
if (!mediaType || !isStyle(style)) {
  console.error(`Usage: npm run trailer -- <image.jpg|png|gif|webp> [--style ${STYLE_IDS.join("|")}]`);
  process.exit(1);
}

const dir = path.resolve("out", `${path.parse(input).name}-${Date.now()}`);
const { plan, video } = await makeTrailer(await readFile(input), mediaType, dir, style, (step) => console.log(`→ ${step}`));
console.log(`\n${plan.title.toUpperCase()} — ${plan.tagline}\n${plan.narration.map((l) => `  "${l}"`).join("\n")}\n\n${video}`);
