import express from "express";
import pino from "pino";
import pinoHttp from "pino-http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import musicRouter from "./routes/music.js";

const app = express();
const logger = pino({ level: process.env.LOG_LEVEL ?? "info" });
const port = Number(process.env.PORT ?? 3000);
const webRoot = fileURLToPath(new URL("../../lenzo-music/dist/public/", import.meta.url));

if (!Number.isInteger(port) || port <= 0) {
  throw new Error(`Invalid PORT value: ${process.env.PORT}`);
}

app.use(pinoHttp({ logger }));
app.use(express.json({ limit: "16mb" }));
app.use(express.urlencoded({ extended: true }));

app.get("/api/healthz", (_request, response) => {
  response.status(200).json({ status: "ok" });
});
app.use("/api", musicRouter);
app.use(express.static(webRoot, { maxAge: "1h" }));
app.use((request, response, next) => {
  if (request.path.startsWith("/api/")) {
    response.status(404).json({ error: "API route not found." });
    return;
  }
  if (request.method !== "GET") {
    response.status(404).end();
    return;
  }
  response.sendFile(path.join(webRoot, "index.html"), (error) => {
    if (error) next(error);
  });
});

app.listen(port, "0.0.0.0", () => {
  logger.info({ port }, "Lenzo Music server started");
});
