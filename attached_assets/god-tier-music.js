/**
 * god-tier-music.js — Lenzo playback scraper
 * HARD LIMIT: host kills at 30s → must finish < 25s
 * Dockerfile: YT_DLP_PATH=/usr/local/bin/yt-dlp + curl_cffi
 */

const { execFile, execFileSync } = require("node:child_process");
const fs = require("node:fs");

const query = (process.argv[2] || "").trim();
const start = Date.now();
const HARD_MS = 24000; // leave headroom under host 30s

function log(...a) {
  console.error("[Scraper]", ...a);
}

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function remaining() {
  return Math.max(1000, HARD_MS - (Date.now() - start));
}

if (!query) {
  emit({ status: false, error: "No query provided", results: { songs: [] } });
  process.exit(0);
}

function resolveYtDlp() {
  for (const c of [process.env.YT_DLP_PATH, "/usr/local/bin/yt-dlp", "yt-dlp"].filter(Boolean)) {
    try {
      if (c.startsWith("/") && !fs.existsSync(c)) continue;
      const out = execFileSync(c, ["--version"], {
        timeout: 5000,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      return { bin: c, version: String(out).trim().split(/\r?\n/)[0] };
    } catch {
      /* next */
    }
  }
  return { bin: null, version: null };
}

function run(cmd, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      {
        timeout: timeoutMs,
        maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env, PYTHONUNBUFFERED: "1" },
      },
      (error, stdout, stderr) => {
        const errText = String(stderr || "").trim();
        if (error) {
          reject(
            new Error(
              `${error.code || "ERR"}: ${error.message}${errText ? ` | ${errText.slice(0, 300)}` : ""}`
            )
          );
          return;
        }
        resolve({ stdout: String(stdout || "").trim(), stderr: errText });
      }
    );
  });
}

function parsePrint(stdout) {
  for (const raw of String(stdout).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.includes("|")) continue;
    const parts = line.split("|");
    if (parts.length < 5) continue;
    const webpage_url = parts.slice(4).join("|").trim();
    if (!webpage_url.startsWith("http")) continue;
    return {
      id: parts[0].trim(),
      title: parts[1].trim() || query,
      uploader: parts[2].trim() || "Unknown",
      duration: Number(parts[3]) || null,
      webpage_url,
    };
  }
  return null;
}

function songResult(hit, source) {
  return {
    status: true,
    source,
    query,
    total_results: 1,
    elapsed_ms: Date.now() - start,
    results: {
      songs: [
        {
          video_id: hit.id,
          title: hit.title,
          artist: hit.uploader,
          creator: hit.uploader,
          duration_seconds: hit.duration,
          duration: hit.duration,
          video_url: hit.webpage_url,
          url: hit.webpage_url,
          watchUrl: hit.webpage_url,
          thumbnail: hit.id ? `https://i.ytimg.com/vi/${hit.id}/hqdefault.jpg` : null,
          streaming: {
            available: true,
            stream_status: "ready",
            stream_url: hit.webpage_url,
          },
          playback: { is_streaming: true },
        },
      ],
      music_videos: [],
      artists: [],
      albums: [],
      playlists: [],
    },
  };
}

async function oneShotYoutube(bin, q, timeoutMs) {
  // Single attempt only — must beat host 30s kill
  const args = [
    `ytsearch1:${q}`,
    "--no-playlist",
    "--no-warnings",
    "--quiet",
    "--skip-download",
    "--no-check-certificates",
    "--socket-timeout",
    "12",
    "--retries",
    "1",
    "--fragment-retries",
    "1",
    "--extractor-retries",
    "1",
    "--print",
    "%(id)s|%(title)s|%(uploader)s|%(duration)s|%(webpage_url)s",
  ];

  // Try with impersonate first (curl_cffi present in image)
  try {
    log("ytsearch1+impersonate", q, "timeout", timeoutMs);
    const { stdout, stderr } = await run(
      bin,
      [...args.slice(0, -2), "--impersonate", "chrome", ...args.slice(-2)],
      timeoutMs
    );
    if (stderr) log("stderr", stderr.slice(0, 200));
    const hit = parsePrint(stdout);
    if (hit) return hit;
    log("empty with impersonate", stdout.slice(0, 100));
  } catch (e) {
    log("impersonate path fail", e.message.slice(0, 200));
  }

  const left = remaining();
  if (left < 3000) throw new Error("no time left for fallback");

  log("ytsearch1 plain", q, "timeout", left);
  const { stdout, stderr } = await run(bin, args, left);
  if (stderr) log("stderr", stderr.slice(0, 200));
  const hit = parsePrint(stdout);
  if (!hit) throw new Error(`empty: ${stdout.slice(0, 120)}`);
  return hit;
}

async function main() {
  const { bin, version } = resolveYtDlp();
  log("yt-dlp", bin, version, "query", query);

  if (!bin) {
    emit({
      status: false,
      error: "yt-dlp not found (YT_DLP_PATH=/usr/local/bin/yt-dlp)",
      query,
      elapsed_ms: Date.now() - start,
      results: { songs: [] },
    });
    return;
  }

  try {
    const hit = await oneShotYoutube(bin, query, Math.min(20000, remaining()));
    log("OK", hit.id, hit.title, Date.now() - start + "ms");
    emit(songResult(hit, "YouTube"));
  } catch (e) {
    log("FAIL", e.message.slice(0, 300));
    emit({
      status: false,
      source: "none",
      query,
      elapsed_ms: Date.now() - start,
      error: `YouTube resolve failed under 30s budget: ${e.message.slice(0, 200)}`,
      results: { songs: [] },
    });
  }
}

main().catch((e) => {
  emit({
    status: false,
    error: e.message || String(e),
    query,
    elapsed_ms: Date.now() - start,
    results: { songs: [] },
  });
});
