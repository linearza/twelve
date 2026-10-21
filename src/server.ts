import "dotenv/config";
import { randomUUID } from "node:crypto";
import path from "node:path";
import express from "express";
import multer from "multer";
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

  const id = randomUUID();
  const job: Job = { step: "Starting", status: "running" };
  jobs.set(id, job);

  makeTrailer(file.buffer, file.mimetype as MediaType, path.join(OUT, id), (step) => (job.step = step))
    .then(({ plan }) => Object.assign(job, { status: "done", step: "Done", plan, video: `/out/${id}/trailer.mp4` }))
    .catch((err: Error) => {
      console.error(err);
      Object.assign(job, { status: "error", error: err.message });
    });

  res.status(202).json({ id });
});

app.get("/api/trailers/:id", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) {
    res.status(404).json({ error: "Unknown trailer" });
    return;
  }
  res.json(job);
});

// Multer rejects oversized uploads by throwing; answer in JSON so the page can show it.
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  res.status(err instanceof multer.MulterError ? 400 : 500).json({ error: err.message });
});

const port = Number(process.env.PORT) || 3000;
app.listen(port, () => console.log(`Twelve running at http://localhost:${port}`));
