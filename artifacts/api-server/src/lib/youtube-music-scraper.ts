import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type YoutubeMusicScraperRequest = {
  query: string;
  region: string;
  probeStreaming: boolean;
  timeoutMs?: number;
  filter?: "songs" | "albums";
  albumId?: string;
  albumTitle?: string;
  albumArtist?: string;
};

type ScraperTrack = {
  videoId: string | null;
  title: string;
  artist: string;
  durationSeconds: number | null;
};

type ScraperItem = {
  category: "song" | "video" | "artist" | "album" | "playlist";
  id: string | null;
  title: string;
  creator: string | null;
  albumTitle: string | null;
  albumId: string | null;
  releaseYear: string | null;
  totalTracks: number | null;
  tracks: ScraperTrack[];
  durationSeconds: number | null;
  duration: string | null;
  watchUrl: string | null;
  audioUrl: string | null;
  thumbnail: string | null;
  streamAvailable: boolean | null;
  streamStatus: string | null;
  streamQuality: string[];
};

export type YoutubeAudioQuality = "low" | "medium" | "high";
export const YOUTUBE_SIGN_IN_BLOCK_MESSAGE =
  "YouTube is asking this server to verify a sign-in before providing audio. Try again later; no audio was played.";
export function isYoutubeSignInBlock(diagnostics: string): boolean {
  return /sign in to confirm|not a bot/i.test(diagnostics);
}
type CachedAudioVariant = { audioBytes: Buffer; contentType: string };

export type YoutubeMusicScraperResult = {
  status: boolean;
  source: string;
  query: string;
  region: string;
  probeStreaming: boolean;
  totalResults: number;
  elapsedMs: number;
  items: ScraperItem[];
  warnings: string[];
  error: string | null;
};

const SCRIPT_RELATIVE_PATH = "attached_assets/scrape-ytmusik_1793744644906.js";
const SCRIPT_PATH_FROM_MODULE = fileURLToPath(
  new URL("../../../../attached_assets/god-tier-music.js", import.meta.url)
);
const MAX_STDOUT_BYTES = 1_500_000;
const MAX_CACHED_STREAMS = 80;
const MAX_STREAM_TTL_MS = 15 * 60_000;
const MAX_CACHED_AUDIO_BYTES = 40 * 1024 * 1024;
const audioStreamCache = new Map<string, {
  watchUrl: string | null;
  expiresAt: number;
  createdAt: number;
  variants: Partial<Record<YoutubeAudioQuality, CachedAudioVariant>>;
}>();
let cachedAudioBytes = 0;

function audioBytesInEntry(entry: { variants: Partial<Record<YoutubeAudioQuality, CachedAudioVariant>> }): number {
  return Object.values(entry.variants).reduce((total, variant) => total + (variant?.audioBytes.byteLength ?? 0), 0);
}

async function findUploadedScript(): Promise<string> {
  const candidates = [
    SCRIPT_PATH_FROM_MODULE,
    path.resolve(process.cwd(), SCRIPT_RELATIVE_PATH),
    path.resolve(process.cwd(), "..", "..", SCRIPT_RELATIVE_PATH),
  ];
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the other workspace-relative location.
    }
  }
  throw new Error("The uploaded scraper file is missing from attached_assets.");
}

export async function isUploadedYoutubeMusicScraperAvailable(): Promise<boolean> {
  try {
    await findUploadedScript();
    return true;
  } catch {
    return false;
  }
}

export function getYoutubeMusicScraperCacheStats(): {
  entries: number;
  audioBytes: number;
  maxAudioBytes: number;
  nextExpiryAt: number | null;
} {
  const now = Date.now();
  for (const [token, entry] of audioStreamCache) {
    if (entry.expiresAt <= now) deleteAudioStreamEntry(token);
  }
  const expiries = [...audioStreamCache.values()].map((entry) => entry.expiresAt);
  return {
    entries: audioStreamCache.size,
    audioBytes: cachedAudioBytes,
    maxAudioBytes: MAX_CACHED_AUDIO_BYTES,
    nextExpiryAt: expiries.length ? Math.min(...expiries) : null,
  };
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function text(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (Array.isArray(value)) {
    const parts = value.map(text).filter((part): part is string => !!part);
    return parts.length ? parts.join(", ") : null;
  }
  if (value && typeof value === "object") {
    const row = objectRecord(value);
    for (const key of ["name", "title", "text", "simpleText"]) {
      const part = text(row[key]);
      if (part) return part;
    }
  }
  return null;
}

function durationInSeconds(value: unknown): number | null {
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return Math.floor(numeric);
  const formatted = text(value);
  if (!formatted) return null;
  const parts = formatted.split(":").map(Number);
  if (!parts.length || parts.some((part) => !Number.isInteger(part) || part < 0)) return null;
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return null;
}

function safeHttpsUrl(value: unknown): string | null {
  const candidate = text(value);
  if (!candidate) return null;
  try {
    const parsed = new URL(candidate);
    return parsed.protocol === "https:" ? parsed.toString() : null;
  } catch {
    return null;
  }
}

function deleteAudioStreamEntry(token: string): void {
  const entry = audioStreamCache.get(token);
  if (entry) cachedAudioBytes -= audioBytesInEntry(entry);
  audioStreamCache.delete(token);
}

function safeYoutubeWatchUrl(value: unknown): string | null {
  const candidate = safeHttpsUrl(value);
  if (!candidate) return null;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return null;
  }
  if (
    !["music.youtube.com", "www.youtube.com", "youtube.com"].includes(parsed.hostname)
    || parsed.pathname !== "/watch"
  ) {
    return null;
  }
  const videoId = parsed.searchParams.get("v");
  if (!videoId || !/^[\w-]{11}$/.test(videoId)) return null;
  return `https://music.youtube.com/watch?v=${videoId}`;
}

function registerAudioPlayback(watchUrl: string | null, requestedToken: string = randomUUID()): string {
  const now = Date.now();
  const expiresAt = now + MAX_STREAM_TTL_MS;

  if (audioStreamCache.has(requestedToken)) deleteAudioStreamEntry(requestedToken);
  for (const [token, entry] of audioStreamCache) {
    if (entry.expiresAt <= now) deleteAudioStreamEntry(token);
  }
  while (audioStreamCache.size >= MAX_CACHED_STREAMS) {
    const oldest = audioStreamCache.keys().next().value;
    if (!oldest) break;
    deleteAudioStreamEntry(oldest);
  }

  audioStreamCache.set(requestedToken, { watchUrl, expiresAt, createdAt: now, variants: {} });
  return requestedToken;
}

function registerSongPlayback(watchUrl: unknown, requestedToken?: string): string | null {
  const safeWatchUrl = safeYoutubeWatchUrl(watchUrl);
  if (!safeWatchUrl) return null;
  return `/api/studio/youtube-music-scraper/audio/${registerAudioPlayback(safeWatchUrl, requestedToken)}`;
}

export function createYoutubeMusicPlaybackSession(videoId: string, requestedToken?: string): string | null {
  if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) return null;
  if (requestedToken && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestedToken)) {
    return null;
  }
  const registeredUrl = registerSongPlayback(`https://music.youtube.com/watch?v=${videoId}`, requestedToken);
  return registeredUrl?.split("/").at(-1) ?? null;
}

export function createCachedMusicAudioSession(token?: string): string {
  if (token && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(token)) {
    throw new Error("The playback session token is invalid.");
  }
  return registerAudioPlayback(null, token);
}

export function getCachedYoutubeAudioEntry(token: string, quality: YoutubeAudioQuality = "low"): {
  watchUrl: string | null;
  audioBytes?: Buffer;
  contentType?: string;
} | null {
  const entry = audioStreamCache.get(token);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    deleteAudioStreamEntry(token);
    return null;
  }
  const audio = entry.variants[quality];
  return { watchUrl: entry.watchUrl, audioBytes: audio?.audioBytes, contentType: audio?.contentType };
}

export function cacheYoutubeAudioBytes(
  token: string,
  audioBytes: Buffer,
  contentType: string,
  quality: YoutubeAudioQuality = "low",
): boolean {
  const entry = audioStreamCache.get(token);
  if (!entry || entry.expiresAt <= Date.now() || audioBytes.byteLength > MAX_CACHED_AUDIO_BYTES) return false;

  const existingBytes = entry.variants[quality]?.audioBytes.byteLength ?? 0;
  if (cachedAudioBytes - existingBytes + audioBytes.byteLength > MAX_CACHED_AUDIO_BYTES) {
    const oldestCached = [...audioStreamCache.entries()]
      .filter(([cachedToken, cached]) => cachedToken !== token && audioBytesInEntry(cached) > 0)
      .sort((a, b) => a[1].createdAt - b[1].createdAt);
    for (const [, cached] of oldestCached) {
      cachedAudioBytes -= audioBytesInEntry(cached);
      cached.variants = {};
      if (cachedAudioBytes - existingBytes + audioBytes.byteLength <= MAX_CACHED_AUDIO_BYTES) break;
    }
  }
  if (cachedAudioBytes - existingBytes + audioBytes.byteLength > MAX_CACHED_AUDIO_BYTES) return false;

  entry.variants[quality] = { audioBytes, contentType };
  cachedAudioBytes = cachedAudioBytes - existingBytes + audioBytes.byteLength;
  return true;
}

export function removeCachedYoutubeAudioStream(token: string): void {
  deleteAudioStreamEntry(token);
}

export async function findYtDlpExecutable(): Promise<string> {
  const candidates = [
    process.env.YT_DLP_PATH,
    path.resolve(process.cwd(), ".pythonlibs", "bin", "yt-dlp"),
    path.resolve(process.cwd(), "..", "..", ".pythonlibs", "bin", "yt-dlp"),
  ].filter((candidate): candidate is string => !!candidate);
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next configured location.
    }
  }
  throw new Error("The full-song downloader is missing from this Studio environment.");
}

export async function downloadYoutubeMusicAudio(
  watchUrl: string,
  quality: YoutubeAudioQuality = "low",
): Promise<{ bytes: Buffer; contentType: string }> {
  const safeUrl = safeYoutubeWatchUrl(watchUrl);
  if (!safeUrl) throw new Error("The scraper returned an invalid YouTube Music song link.");
  const executable = await findYtDlpExecutable();
  const format = quality === "low" ? "worstaudio[ext=m4a]" : "bestaudio[ext=m4a]";

  return new Promise((resolve, reject) => {
    const maxBytes = 24 * 1024 * 1024;
    const child = spawn(executable, [
      "--format", format,
      "--no-playlist",
      "--no-warnings",
      "--quiet",
      "--no-progress",
      "--socket-timeout", "20",
      "--retries", "2",
      "--fragment-retries", "2",
      "--extractor-retries", "2",
      "--output", "-",
      safeUrl,
    ], {
      cwd: process.cwd(),
      env: { ...process.env, PYTHONUNBUFFERED: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });

    const chunks: Buffer[] = [];
    let size = 0;
    let stderrText = "";
    let settled = false;
    let timedOut = false;
    let overflowed = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, 120_000);
    const finish = (error?: Error, bytes?: Buffer) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else if (bytes) resolve({ bytes, contentType: "audio/mp4" });
      else reject(new Error("The downloader returned no audio."));
    };

    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.byteLength;
      if (size > maxBytes) {
        overflowed = true;
        child.kill("SIGKILL");
        return;
      }
      chunks.push(Buffer.from(chunk));
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderrText.length < 4096) {
        stderrText += chunk.toString("utf8").slice(0, 4096 - stderrText.length);
      }
    });
    child.once("error", (error) => finish(new Error(`Could not start the audio downloader: ${error.message}`)));
    child.once("close", (code) => {
      if (timedOut) {
        finish(new Error("Downloading the full song exceeded the two-minute limit."));
        return;
      }
      if (overflowed) {
        finish(new Error("The song exceeds the 24 MB Studio playback limit."));
        return;
      }
      if (code !== 0) {
        finish(new Error(
          isYoutubeSignInBlock(stderrText)
            ? YOUTUBE_SIGN_IN_BLOCK_MESSAGE
            : `The downloader could not get the full song (exit ${code ?? "unknown"}).`,
        ));
        return;
      }
      const bytes = Buffer.concat(chunks, size);
      if (bytes.byteLength < 12 || bytes.toString("ascii", 4, 8) !== "ftyp") {
        finish(new Error("The downloader did not return a complete AAC/MP4 audio file."));
        return;
      }
      finish(undefined, bytes);
    });
  });
}

function valuesForCategory(
  results: Record<string, unknown>,
  sourceKey: string,
  category: ScraperItem["category"],
  probeStreaming: boolean,
): ScraperItem[] {
  const rows = Array.isArray(results[sourceKey]) ? results[sourceKey] : [];
  return rows.map((value): ScraperItem => {
    const item = objectRecord(value);
    const streaming = objectRecord(item.streaming);
    const playback = objectRecord(item.playback);
    const album = objectRecord(item.album);
    const videoId = text(item.video_id ?? item.videoId);
    const albumId = text(item.album_id ?? item.albumId ?? album.browseId ?? album.id);
    const albumTitle = text(item.album_title ?? item.albumTitle ?? album.title ?? album.name ?? item.album);
    const providerUrl = safeHttpsUrl(item.video_url ?? item.url ?? item.playback_url);
    const watchUrl = category === "song" || category === "video"
      ? providerUrl || (videoId ? `https://music.youtube.com/watch?v=${encodeURIComponent(videoId)}` : null)
      : providerUrl;
    const audioUrl = category === "song" && probeStreaming
      ? registerSongPlayback(watchUrl)
      : null;
    const streamAvailable = category === "song" && probeStreaming
      ? streaming.available === true || playback.is_streaming === true
      : null;
    const audioQualities = category === "song" && probeStreaming
      ? [streaming.audio_format, streaming.audio_codec, streaming.audio_quality]
        .map(text)
        .filter((entry): entry is string => !!entry)
      : [];
    const bitrate = Number(streaming.bitrate);
    if (category === "song" && probeStreaming && Number.isFinite(bitrate) && bitrate > 0) {
      audioQualities.push(`${Math.round(bitrate / 1000)} kbps`);
    }

    const trackRows = Array.isArray(item.track_list) ? item.track_list : [];
    const tracks = trackRows.flatMap((trackValue): ScraperTrack[] => {
      const track = objectRecord(trackValue);
      const trackVideoId = text(track.video_id ?? track.videoId);
      const title = text(track.title ?? track.name);
      if (!trackVideoId || !title) return [];
      return [{
        videoId: trackVideoId,
        title,
        artist: text(track.artist ?? track.author) ?? text(item.artist) ?? "Unknown artist",
        durationSeconds: durationInSeconds(track.duration_seconds ?? track.durationSeconds ?? track.duration),
      }];
    }).slice(0, 100);
    const totalTracksValue = Number(item.total_tracks ?? item.totalTracks);
    return {
      category,
      id: videoId ?? albumId,
      title: text(item.title ?? item.name) ?? "Untitled result",
      creator: text(item.artist ?? item.author ?? item.channel ?? item.creator),
      albumTitle: category === "song" ? albumTitle : null,
      albumId: category === "song" ? albumId : null,
      releaseYear: text(item.release_date ?? item.releaseYear ?? item.year),
      totalTracks: Number.isFinite(totalTracksValue) && totalTracksValue > 0 ? Math.floor(totalTracksValue) : null,
      tracks,
      durationSeconds: durationInSeconds(item.duration_seconds ?? item.durationSeconds ?? item.duration),
      duration: text(item.duration_text ?? item.duration ?? item.duration_formatted),
      watchUrl,
      audioUrl,
      thumbnail: safeHttpsUrl(item.thumbnail ?? item.thumbnail_url ?? item.thumbnailUrl),
      streamAvailable,
      streamStatus: category === "song" && probeStreaming
        ? text(streaming.stream_status) ?? (streamAvailable ? "Provider reports audio available" : "Audio route unverified")
        : null,
      streamQuality: [...new Set(audioQualities)],
    };
  });
}

function warningList(output: Record<string, unknown>): string[] {
  const warnings: string[] = [];
  const metadata = objectRecord(output.search_metadata);
  const note = text(metadata.filter_note);
  if (note) warnings.push(note);

  const fullMetadata = objectRecord(output.metadata);
  const sourceWarnings = fullMetadata.warnings;
  if (Array.isArray(sourceWarnings)) {
    for (const warning of sourceWarnings) {
      const row = objectRecord(warning);
      const message = text(row.error ?? warning);
      if (message) warnings.push(message);
    }
  }
  return [...new Set(warnings)].slice(0, 8);
}

export function sanitizeYoutubeMusicScraperOutput(
  raw: unknown,
  request: YoutubeMusicScraperRequest,
): YoutubeMusicScraperResult {
  const output = objectRecord(raw);
  const results = objectRecord(output.results);
  const items = [
    ...valuesForCategory(results, "songs", "song", request.probeStreaming),
    ...valuesForCategory(results, "music_videos", "video", request.probeStreaming),
    ...valuesForCategory(results, "artists", "artist", request.probeStreaming),
    ...valuesForCategory(results, "albums", "album", request.probeStreaming),
    ...valuesForCategory(results, "playlists", "playlist", request.probeStreaming),
  ].slice(0, 60);
  const outputStatus = typeof output.status === "boolean" ? output.status : items.length > 0;
  const total = Number(output.total_results);
  const elapsed = Number(output.elapsed_ms);

  return {
    status: outputStatus,
    source: text(output.source) ?? "Uploaded YouTube Music scraper",
    query: request.query,
    region: request.region,
    probeStreaming: request.probeStreaming,
    totalResults: Number.isFinite(total) ? Math.max(0, total) : items.length,
    elapsedMs: Number.isFinite(elapsed) ? Math.max(0, elapsed) : 0,
    items,
    warnings: warningList(output),
    error: text(output.error),
  };
}

function parseOutput(stdout: string, request: YoutubeMusicScraperRequest): YoutubeMusicScraperResult {
  try {
    return sanitizeYoutubeMusicScraperOutput(JSON.parse(stdout), request);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error("The uploaded scraper did not return valid JSON.");
    }
    throw error;
  }
}

export async function testUploadedYoutubeMusicScraper(
  request: YoutubeMusicScraperRequest,
): Promise<YoutubeMusicScraperResult> {
  const scriptPath = await findUploadedScript();
  const nodeModulesPaths = [
    path.resolve(process.cwd(), "node_modules"),
    path.resolve(process.cwd(), "artifacts/api-server/node_modules"),
    path.resolve(process.cwd(), "..", "..", "artifacts/api-server/node_modules"),
  ];

  return new Promise((resolve, reject) => {
    const defaultTimeoutMs = request.probeStreaming ? 105_000 : 60_000;
    const timeoutMs = Number.isInteger(request.timeoutMs)
      ? Math.max(1_000, Math.min(request.timeoutMs ?? defaultTimeoutMs, 120_000))
      : defaultTimeoutMs;
    const args = [scriptPath, request.query.trim()];
    if (request.albumId) {
      args.push(
        "--album-id", request.albumId,
        "--album-title", request.albumTitle ?? request.query.trim(),
        "--album-artist", request.albumArtist ?? "",
      );
    } else if (request.filter) {
      args.push("--filter", request.filter);
    } else if (request.probeStreaming) {
      args.push("--filter", "songs");
    }
    args.push(
      "--stream", request.probeStreaming ? "1" : "0",
      "--pages", "1",
      "--gl", request.region.toUpperCase(),
    );
    const child = spawn(process.execPath, [
      ...args,
    ], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NODE_PATH: [...nodeModulesPaths, process.env.NODE_PATH].filter(Boolean).join(path.delimiter),
        YTM_GL: request.region.toUpperCase(),
        YTM_HL: "en",
        YTM_RETRIES: "2",
        YTM_TIMEOUT: "10000",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stdoutSize = 0;
    let timedOut = false;
    let overflowed = false;
    let settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    };

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutSize += chunk.byteLength;
      if (stdoutSize > MAX_STDOUT_BYTES) {
        overflowed = true;
        child.kill("SIGKILL");
        return;
      }
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", () => undefined);
    child.once("error", (error) => fail(new Error(`Could not start the scraper: ${error.message}`)));
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`Scraper test exceeded its ${Math.round(timeoutMs / 1000)}-second time limit.`));
        return;
      }
      if (overflowed) {
        reject(new Error("Scraper output exceeded the 1.5 MB test limit."));
        return;
      }
      if (!stdout.trim()) {
        reject(new Error(`The scraper exited without a result${code == null ? "" : ` (exit ${code})`}.`));
        return;
      }
      try {
        resolve(parseOutput(stdout, request));
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  });
}
