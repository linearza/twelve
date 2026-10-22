import "dotenv/config";
import { randomUUID } from "node:crypto";
import path from "node:path";
import express from "express";
import multer from "multer";
import { Library } from "./library.js";
import { isStyle, STYLES } from "./styles.js";
import { makeTrailer } from "./trailer.js";
import type { TrailerPlan } from "./plan.js";

const ACCEPTED = ["image/jpeg", "image/png", "image/gif", "image/webp"] as const;
type MediaType = (typeof ACCEPTED)[number];

interface Job {
  step: string;
  status: "running" | "done" | "error";
  plan?: TrailerPlan;
  video?: string;
  error?: string;
}

const jobs = new Map<string, Job>();
const OUT = path.resolve("out");
const library = new Library(OUT);
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });
const app = express();

app.use(express.static("public"));
app.use("/out", express.static(OUT));

app.post("/api/trailers", upload.single("image"), (req, res) => {
  const file = req.file;
  if (!file || !ACCEPTED.includes(file.mimetype as MediaType)) {
    res.status(400).json({ error: "Upload a JPEG, PNG, GIF or WebP image under 25 MB." });
    return;
  }

  const style = req.body?.style ?? "epic";
  if (!isStyle(style)) {
    res.status(400).json({ error: `Unknown style "${style}".` });
    return;
  }

  const id = randomUUID();
  const job: Job = { step: "Starting", status: "running" };
  jobs.set(id, job);

  makeTrailer(file.buffer, file.mimetype as MediaType, path.join(OUT, id), style, (step) => (job.step = step))
    .then(({ plan }) => Object.assign(job, { status: "done", step: "Done", plan, video: `/out/${id}/trailer.mp4` }))
    .catch((err: Error) => {
      console.error(err);
      Object.assign(job, { status: "error", error: err.message });
    });

  res.status(202).json({ id });
});

app.get("/api/styles", (_req, res) => {
  res.json(Object.entries(STYLES).map(([id, s]) => ({ id, label: s.label })));
});

app.get("/api/trailers/:id", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) {
    res.status(404).json({ error: "Unknown trailer" });
    return;
  }
  res.json(job);
});

app.get("/api/library", async (_req, res) => {
  res.json(await library.list());
});

app.get("/api/library/:id", async (req, res) => {
  const entry = await library.get(req.params.id);
  if (!entry) {
    res.status(404).json({ error: "Unknown trailer" });
    return;
  }
  res.json(entry);
});

app.patch("/api/library/:id", express.json(), async (req, res) => {
  const entry = await library.setFavourite(req.params.id, Boolean(req.body?.favourite));
  if (!entry) {
    res.status(404).json({ error: "Unknown trailer" });
    return;
  }
  res.json(entry);
});

app.delete("/api/library/:id", async (req, res) => {
  if (jobs.get(req.params.id)?.status === "running") {
    res.status(409).json({ error: "That trailer is still being made." });
    return;
  }
  if (!(await library.remove(req.params.id))) {
    res.status(404).json({ error: "Unknown trailer" });
    return;
  }
  jobs.delete(req.params.id);
  res.status(204).end();
});

// Multer rejects oversized uploads by throwing; answer in JSON so the page can show it.
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  res.status(err instanceof multer.MulterError ? 400 : 500).json({ error: err.message });
});

const port = Number(process.env.PORT) || 4712;
app.listen(port, () => console.log(`Twelve running at http://localhost:${port}`));
