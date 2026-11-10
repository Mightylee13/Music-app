/**
 * god-tier-music.js — Lenzo playback scraper
 * Matched to Dockerfile: node:22-bookworm-slim + yt-dlp + curl_cffi
 * ENV: YT_DLP_PATH=/usr/local/bin/yt-dlp
 *
 * stdout: one JSON only | stderr: logs
 */

const { execFile, execFileSync } = require("node:child_process");
const fs = require("node:fs");

const query = (process.argv[2] || "").trim();
const start = Date.now();

function log(...a) {
  console.error("[Scraper]", ...a);
}

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

if (!query) {
  emit({ status: false, error: "No query provided", results: { songs: [] } });
  process.exit(0);
}

function resolveYtDlp() {
  const candidates = [
    process.env.YT_DLP_PATH,
    "/usr/local/bin/yt-dlp",
    "yt-dlp",
  ].filter(Boolean);

  const tried = [];
  for (const c of candidates) {
    tried.push(c);
    try {
      if (c.startsWith("/") && !fs.existsSync(c)) continue;
      const out = execFileSync(c, ["--version"], {
        timeout: 10000,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      return { bin: c, version: String(out).trim().split(/\r?\n/)[0], tried };
    } catch {
      /* next */
    }
  }
  return { bin: null, version: null, tried };
}

function run(cmd, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      {
        timeout: timeoutMs,
        maxBuffer: 8 * 1024 * 1024,
        env: { ...process.env, PYTHONUNBUFFERED: "1" },
      },
      (error, stdout, stderr) => {
        const errText = String(stderr || "").trim();
        if (error) {
          reject(
            new Error(
              `${error.code || "ERR"}: ${error.message}${errText ? ` | ${errText.slice(0, 500)}` : ""}`
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

/** Common yt-dlp flags for datacenter IPs (Render) */
function baseArgs() {
  return [
    "--no-playlist",
    "--no-warnings",
    "--quiet",
    "--skip-download",
    "--no-check-certificates",
    "--socket-timeout",
    "20",
    "--retries",
    "2",
    // curl_cffi is installed in the image — use it
    "--impersonate",
    "chrome",
  ];
}

async function searchYoutube(bin, q) {
  const attempts = [
    `ytsearch1:${q}`,
    `ytsearch1:${q} audio`,
    `ytsearch3:${q}`,
  ];

  let lastErr = null;
  for (const target of attempts) {
    try {
      log("try", target);
      const { stdout, stderr } = await run(
        bin,
        [
          target,
          ...baseArgs(),
          "--print",
          "%(id)s|%(title)s|%(uploader)s|%(duration)s|%(webpage_url)s",
        ],
        20000
      );
      if (stderr) log("stderr", stderr.slice(0, 300));
      const hit = parsePrint(stdout);
      if (hit) return hit;
      lastErr = new Error(`empty output for ${target}: ${stdout.slice(0, 120)}`);
    } catch (e) {
      lastErr = e;
      log("fail", target, e.message.slice(0, 250));
      // If impersonate unsupported, retry once without it
      if (/impersonate|curl_cffi/i.test(e.message)) {
        try {
          log("retry without impersonate", target);
          const { stdout } = await run(
            bin,
            [
              target,
              "--no-playlist",
              "--no-warnings",
              "--quiet",
              "--skip-download",
              "--socket-timeout",
              "20",
              "--print",
              "%(id)s|%(title)s|%(uploader)s|%(duration)s|%(webpage_url)s",
            ],
            20000
          );
          const hit = parsePrint(stdout);
          if (hit) return hit;
        } catch (e2) {
          lastErr = e2;
          log("retry fail", e2.message.slice(0, 250));
        }
      }
    }
  }
  throw lastErr || new Error("YouTube search failed");
}

async function searchSoundcloud(bin, q) {
  log("scsearch1", q);
  const { stdout, stderr } = await run(
    bin,
    [
      `scsearch1:${q}`,
      ...baseArgs(),
      "--print",
      "%(id)s|%(title)s|%(uploader)s|%(duration)s|%(webpage_url)s",
    ],
    18000
  );
  if (stderr) log("sc stderr", stderr.slice(0, 300));
  const hit = parsePrint(stdout);
  if (!hit) throw new Error(`SoundCloud empty: ${stdout.slice(0, 120)}`);
  return hit;
}

async function main() {
  const { bin, version, tried } = resolveYtDlp();
  log("resolve", { bin, version, tried, YT_DLP_PATH: process.env.YT_DLP_PATH });

  if (!bin) {
    emit({
      status: false,
      source: "none",
      query,
      elapsed_ms: Date.now() - start,
      error: `yt-dlp not found. Set YT_DLP_PATH. Tried: ${tried.join(", ")}`,
      results: { songs: [] },
    });
    return;
  }

  try {
    const hit = await searchYoutube(bin, query);
    log("YouTube OK", hit.id, hit.title);
    emit(songResult(hit, "YouTube"));
    return;
  } catch (e) {
    log("YouTube exhausted", e.message.slice(0, 400));
  }

  try {
    const hit = await searchSoundcloud(bin, query);
    log("SoundCloud OK", hit.title);
    emit(songResult(hit, "SoundCloud"));
    return;
  } catch (e) {
    log("SoundCloud fail", e.message.slice(0, 400));
  }

  emit({
    status: false,
    source: "none",
    query,
    elapsed_ms: Date.now() - start,
    error: `yt-dlp ${version} ran but returned no playable result (likely blocked or timeout). Query: ${query}`,
    results: { songs: [] },
  });
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
