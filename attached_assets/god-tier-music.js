/**
 * god-tier-music.js — Lenzo playback scraper (Render-hardened)
 *
 * Called on POST /api/music/playback with the song query.
 * Must print ONE JSON object on stdout. Logs → stderr only.
 *
 * Host expects (via sanitizeYoutubeMusicScraperOutput):
 *   results.songs[].video_url | url | video_id
 *   streaming.available === true  OR  playback.is_streaming === true
 */

const { execFile } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const query = (process.argv[2] || "").trim();
const start = Date.now();

if (!query) {
  process.stdout.write(
    JSON.stringify({ status: false, error: "No query provided", results: { songs: [] } }) + "\n"
  );
  process.exit(0);
}

function log(...a) {
  console.error("[Scraper]", ...a);
}

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function findYtDlp() {
  const candidates = [
    process.env.YT_DLP_PATH,
    "yt-dlp",
    path.resolve(process.cwd(), ".pythonlibs/bin/yt-dlp"),
    path.resolve(process.cwd(), "node_modules/.bin/yt-dlp"),
    "/usr/local/bin/yt-dlp",
    "/usr/bin/yt-dlp",
  ].filter(Boolean);

  for (const c of candidates) {
    try {
      if (c === "yt-dlp") return c;
      if (fs.existsSync(c)) return c;
    } catch {
      /* skip */
    }
  }
  return "yt-dlp";
}

function run(cmd, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      {
        timeout: timeoutMs,
        maxBuffer: 8 * 1024 * 1024,
        env: {
          ...process.env,
          PYTHONUNBUFFERED: "1",
        },
      },
      (error, stdout, stderr) => {
        const errText = String(stderr || "").trim();
        if (error) {
          const e = new Error(
            `${error.code || "ERR"}: ${error.message}${errText ? ` | ${errText.slice(0, 500)}` : ""}`
          );
          e.stderr = errText;
          return reject(e);
        }
        resolve({ stdout: String(stdout || "").trim(), stderr: errText });
      }
    );
  });
}

function parsePrint(stdout) {
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || !line.includes("|")) continue;
    const parts = line.split("|");
    if (parts.length < 5) continue;
    const id = parts[0].trim();
    const title = parts[1].trim();
    const uploader = parts[2].trim();
    const duration = Number(parts[3]);
    const webpage_url = parts.slice(4).join("|").trim();
    if (!webpage_url.startsWith("http")) continue;
    return {
      id,
      title: title || query,
      uploader: uploader || "Unknown",
      duration: Number.isFinite(duration) ? duration : null,
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
          thumbnail: hit.id
            ? `https://i.ytimg.com/vi/${hit.id}/hqdefault.jpg`
            : null,
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

async function ytSearch(bin, q, timeoutMs) {
  const attempts = [
    {
      label: "ytsearch1",
      args: [
        `ytsearch1:${q}`,
        "--no-playlist",
        "--no-warnings",
        "--quiet",
        "--skip-download",
        "--no-check-certificates",
        "--socket-timeout",
        "15",
        "--print",
        "%(id)s|%(title)s|%(uploader)s|%(duration)s|%(webpage_url)s",
      ],
    },
    {
      label: "ytsearch3",
      args: [
        `ytsearch3:${q}`,
        "--no-playlist",
        "--no-warnings",
        "--quiet",
        "--skip-download",
        "--no-check-certificates",
        "--socket-timeout",
        "15",
        "--print",
        "%(id)s|%(title)s|%(uploader)s|%(duration)s|%(webpage_url)s",
      ],
    },
  ];

  let lastErr = null;
  for (const attempt of attempts) {
    try {
      log(attempt.label, q);
      const { stdout, stderr } = await run(bin, attempt.args, timeoutMs);
      if (stderr) log(attempt.label, "stderr:", stderr.slice(0, 300));
      const hit = parsePrint(stdout);
      if (hit) return hit;
      lastErr = new Error(`${attempt.label}: no rows in: ${stdout.slice(0, 200)}`);
      log(lastErr.message);
    } catch (e) {
      lastErr = e;
      log(attempt.label, "failed:", e.message.slice(0, 300));
    }
  }
  throw lastErr || new Error("YouTube search failed");
}

async function scSearch(bin, q, timeoutMs) {
  log("scsearch1", q);
  const { stdout, stderr } = await run(
    bin,
    [
      `scsearch1:${q}`,
      "--no-playlist",
      "--no-warnings",
      "--quiet",
      "--skip-download",
      "--socket-timeout",
      "15",
      "--print",
      "%(id)s|%(title)s|%(uploader)s|%(duration)s|%(webpage_url)s",
    ],
    timeoutMs
  );
  if (stderr) log("sc stderr:", stderr.slice(0, 300));
  const hit = parsePrint(stdout);
  if (!hit) throw new Error(`SoundCloud: no rows: ${stdout.slice(0, 200)}`);
  return hit;
}

async function main() {
  const bin = findYtDlp();
  log("yt-dlp bin:", bin, "query:", query);

  // Playback host waited ~12.5s — use up to ~18s total
  try {
    const hit = await ytSearch(bin, query, 12000);
    log("YouTube OK", hit.id, hit.title);
    emit(songResult(hit, "YouTube"));
    return;
  } catch (e) {
    log("YouTube exhausted:", e.message.slice(0, 400));
  }

  try {
    const hit = await scSearch(bin, query, 10000);
    log("SoundCloud OK", hit.title);
    emit(songResult(hit, "SoundCloud"));
    return;
  } catch (e) {
    log("SoundCloud failed:", e.message.slice(0, 400));
  }

  emit({
    status: false,
    source: "none",
    query,
    total_results: 0,
    elapsed_ms: Date.now() - start,
    error:
      "Song not found on YouTube/SoundCloud. On Render this usually means yt-dlp is missing, blocked, or too slow. SSH/shell: yt-dlp --version && yt-dlp 'ytsearch1:Asake' --print id",
    results: { songs: [], music_videos: [], artists: [], albums: [], playlists: [] },
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
