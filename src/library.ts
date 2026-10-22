import { readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { TrailerPlan } from "./plan.js";

export interface Entry {
  id: string;
  createdAt: number;
  favourite: boolean;
  video: string;
  poster?: string;
  plan: TrailerPlan & { style?: string };
}

// Every finished trailer lives in its own folder under out/; the folder name is its id.
export class Library {
  constructor(private readonly root: string) {}

  // Ids come from URLs, so keep them to a single plain folder name inside root.
  private dir(id: string): string | undefined {
    return /^[\w-]+$/.test(id) ? path.join(this.root, id) : undefined;
  }

  async get(id: string): Promise<Entry | undefined> {
    const dir = this.dir(id);
    if (!dir) return undefined;
    try {
      const [plan, video, meta, files] = await Promise.all([
        readFile(path.join(dir, "plan.json"), "utf8").then(JSON.parse),
        stat(path.join(dir, "trailer.mp4")),
        readFile(path.join(dir, "meta.json"), "utf8").then(JSON.parse, () => ({})),
        readdir(dir),
      ]);
      // Older jobs kept the source photo under a different name.
      const poster = ["image.jpg", "image.jpeg", "image.png", "image.webp", "image.gif"].find((f) => files.includes(f)) ??
        files.find((f) => f.startsWith("original."));
      return {
        id,
        createdAt: video.mtimeMs,
        favourite: Boolean(meta.favourite),
        video: `/out/${id}/trailer.mp4`,
        poster: poster ? `/out/${id}/${poster}` : undefined,
        plan,
      };
    } catch {
      return undefined; // unfinished or failed job
    }
  }

  async list(): Promise<Entry[]> {
    const folders = await readdir(this.root, { withFileTypes: true }).catch(() => []);
    const entries = await Promise.all(folders.filter((f) => f.isDirectory()).map((f) => this.get(f.name)));
    return entries.filter((e) => e !== undefined).sort((a, b) => b.createdAt - a.createdAt);
  }

  async setFavourite(id: string, favourite: boolean): Promise<Entry | undefined> {
    if (!(await this.get(id))) return undefined;
    await writeFile(path.join(this.dir(id)!, "meta.json"), JSON.stringify({ favourite }));
    return this.get(id);
  }

  async remove(id: string): Promise<boolean> {
    if (!(await this.get(id))) return false;
    await rm(this.dir(id)!, { recursive: true, force: true });
    return true;
  }
}
