/**
 * god-tier-music.js — Lenzo / Studio music scraper
 *
 * MUST print exactly one JSON object on stdout (no debug on stdout).
 * Logs only on stderr.
 *
 * Output shape is matched to sanitizeYoutubeMusicScraperOutput / valuesForCategory:
 *   results.songs[].video_url | url | video_id  → becomes watchUrl
 *   results.songs[].streaming.available = true  → streamAvailable
 *   Server then maps watchUrl → /api/studio/youtube-music-scraper/audio/{token}
 *
 * Prefer stable *page* URLs (YouTube watch, SoundCloud track page), NOT ephemeral
 * googlevideo CDN links from yt-dlp -g. The server re-downloads at play time.
 *
 * Runtime: node 18+, yt-dlp on PATH (or YT_DLP_PATH)
 */

const { execFile } = require("node:child_process");

const query = (process.argv[2] || "").trim();
if (!query) {
  process.stdout.write(
    JSON.stringify({ status: false, error: "No query provided" }) + "\n"
  );
  process.exit(0);
}

const start = Date.now();

function log(...args) {
  console.error("[Scraper]", ...args);
}

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function run(cmd, args, timeoutMs = 8000) {
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
        if (error) {
          const err = new Error(
            `${error.message}${stderr ? ` | ${String(stderr).slice(0, 400)}` : ""}`
          );
          return reject(err);
        }
        resolve(String(stdout || "").trim());
      }
    );
  });
}

function ytDlpBin() {
  return process.env.YT_DLP_PATH || "yt-dlp";
}

/**
 * Parse yt-dlp --print lines: id|title|uploader|duration|webpage_url
 */
function parsePrintLine(line) {
  const parts = line.split("|");
  if (parts.length < 5) return null;
  const [id, title, uploader, duration, ...urlParts] = parts;
  const webpage_url = urlParts.join("|").trim();
  if (!webpage_url.startsWith("http")) return null;
  return {
    id: id.trim(),
    title: title.trim() || query,
    uploader: uploader.trim() || "Unknown",
    duration: Number(duration) || null,
    webpage_url,
  };
}

async function searchYouTube(q) {
  const bin = ytDlpBin();
  // Stable watch page URL — server downloadYoutubeMusicAudio uses this at play time
  const out = await run(
    bin,
    [
      `ytsearch1:${q}`,
      "--no-playlist",
      "--no-warnings",
      "--quiet",
      "--print",
      "%(id)s|%(title)s|%(uploader)s|%(duration)s|%(webpage_url)s",
    ],
    8000
  );
  const line = out.split("\n").map((l) => l.trim()).find(Boolean);
  if (!line) throw new Error("YouTube: empty yt-dlp output");
  const parsed = parsePrintLine(line);
  if (!parsed) throw new Error(`YouTube: bad print line: ${line.slice(0, 120)}`);
  return {
    source: "YouTube",
    video_id: parsed.id,
    title: parsed.title,
    artist: parsed.uploader,
    duration_seconds: parsed.duration,
    // fields the TS sanitizer actually reads:
    video_url: parsed.webpage_url,
    url: parsed.webpage_url,
    watchUrl: parsed.webpage_url,
    thumbnail: `https://i.ytimg.com/vi/${parsed.id}/hqdefault.jpg`,
    streaming: {
      available: true,
      stream_status: "ready",
      // optional direct hint — server should still prefer watch page
      stream_url: parsed.webpage_url,
    },
  };
}

async function searchSoundCloud(q) {
  const bin = ytDlpBin();
  const out = await run(
    bin,
    [
      `scsearch1:${q}`,
      "--no-playlist",
      "--no-warnings",
      "--quiet",
      "--print",
      "%(id)s|%(title)s|%(uploader)s|%(duration)s|%(webpage_url)s",
    ],
    8000
  );
  const line = out.split("\n").map((l) => l.trim()).find(Boolean);
  if (!line) throw new Error("SoundCloud: empty yt-dlp output");
  const parsed = parsePrintLine(line);
  if (!parsed) throw new Error(`SoundCloud: bad print line: ${line.slice(0, 120)}`);
  return {
    source: "SoundCloud",
    video_id: parsed.id,
    title: parsed.title,
    artist: parsed.uploader,
    duration_seconds: parsed.duration,
    video_url: parsed.webpage_url,
    url: parsed.webpage_url,
    watchUrl: parsed.webpage_url,
    thumbnail: null,
    streaming: {
      available: true,
      stream_status: "ready",
      stream_url: parsed.webpage_url,
    },
  };
}

function songPayload(hit) {
  return {
    status: true,
    source: hit.source,
    query,
    total_results: 1,
    elapsed_ms: Date.now() - start,
    results: {
      songs: [
        {
          video_id: hit.video_id,
          title: hit.title,
          artist: hit.artist,
          creator: hit.artist,
          duration_seconds: hit.duration_seconds,
          duration: hit.duration_seconds,
          video_url: hit.video_url,
          url: hit.url,
          watchUrl: hit.watchUrl,
          thumbnail: hit.thumbnail,
          streaming: hit.streaming,
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

async function main() {
  // YouTube first (usually fastest + server already has YT download path)
  try {
    log("YouTube ytsearch1…");
    const hit = await searchYouTube(query);
    log("YouTube ok", hit.video_id, hit.title);
    emit(songPayload(hit));
    return;
  } catch (e) {
    log("YouTube failed:", e.message);
  }

  try {
    log("SoundCloud scsearch1…");
    const hit = await searchSoundCloud(query);
    log("SoundCloud ok", hit.title);
    emit(songPayload(hit));
    return;
  } catch (e) {
    log("SoundCloud failed:", e.message);
  }

  // Audiomack public search needs OAuth consumer key — skip unless configured
  emit({
    status: false,
    source: "none",
    query,
    total_results: 0,
    elapsed_ms: Date.now() - start,
    error: "Song not found on YouTube/SoundCloud within time limit",
    results: { songs: [], music_videos: [], artists: [], albums: [], playlists: [] },
  });
}

main().catch((e) => {
  emit({
    status: false,
    error: e.message || String(e),
    query,
    results: { songs: [] },
  });
});
