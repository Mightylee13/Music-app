import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Readable } from "node:stream";
import {
  findYtDlpExecutable,
  getCachedYoutubeAudioEntry,
  isYoutubeSignInBlock,
  YOUTUBE_SIGN_IN_BLOCK_MESSAGE,
  type YoutubeAudioQuality,
} from "./youtube-music-scraper.js";

const MAX_HLS_SESSIONS = 8;
const MAX_ACTIVE_HLS_SESSIONS = 4;
const MAX_SOURCE_AUDIO_BYTES = 24 * 1024 * 1024;
const HLS_SESSION_TTL_MS = 15 * 60_000;
const FIRST_SEGMENT_TIMEOUT_MS = 45_000;
export const YOUTUBE_MUSIC_HLS_SEGMENT_SECONDS = 1;
const PROCESS_STOP_GRACE_MS = 2_000;
const DIRECTORY_REMOVE_RETRIES = 5;

type HlsSession = {
  token: string;
  quality: YoutubeAudioQuality;
  directory: string;
  playlistPath: string;
  downloader: ChildProcess | null;
  sourceStream: Readable | null;
  transcoder: ChildProcess;
  createdAt: number;
  lastAccess: number;
  sourceBytes: number;
  complete: boolean;
  cancelled: boolean;
  error: string | null;
  timeout: NodeJS.Timeout;
};

const sessions = new Map<string, HlsSession>();
const startingSessions = new Map<string, Promise<HlsSession>>();

function sessionKey(token: string, quality: YoutubeAudioQuality): string {
  return `${token}:${quality}`;
}

function stopProcess(process: ChildProcess): void {
  if (process.exitCode === null && process.signalCode === null && !process.killed) {
    process.kill("SIGTERM");
  }
}

async function stopAndWaitForProcess(process: ChildProcess): Promise<void> {
  if (process.exitCode !== null || process.signalCode !== null || process.pid === undefined) return;

  const closed = new Promise<void>((resolve) => {
    process.once("close", () => resolve());
  });
  stopProcess(process);

  const forceKillTimer = setTimeout(() => {
    if (process.exitCode === null && process.signalCode === null) {
      try {
        process.kill("SIGKILL");
      } catch {
        // The process may have exited between the status check and kill.
      }
    }
  }, PROCESS_STOP_GRACE_MS);
  forceKillTimer.unref();

  try {
    await closed;
  } finally {
    clearTimeout(forceKillTimer);
  }
}

async function removeHlsDirectory(directory: string): Promise<void> {
  for (let attempt = 0; attempt < DIRECTORY_REMOVE_RETRIES; attempt += 1) {
    try {
      await rm(directory, {
        recursive: true,
        force: true,
        maxRetries: 2,
        retryDelay: 100,
      });
      return;
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error
        ? (error as NodeJS.ErrnoException).code
        : undefined;
      const retryable = code === "ENOTEMPTY" || code === "EBUSY" || code === "EPERM";
      if (!retryable || attempt === DIRECTORY_REMOVE_RETRIES - 1) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
    }
  }
}

export async function cleanupYoutubeMusicHlsResources(
  directory: string,
  processes: ChildProcess[],
): Promise<void> {
  await Promise.all(processes.map(stopAndWaitForProcess));
  await removeHlsDirectory(directory);
}

function removeSession(session: HlsSession): void {
  if (session.cancelled) return;
  session.cancelled = true;
  clearTimeout(session.timeout);
  const key = sessionKey(session.token, session.quality);
  if (sessions.get(key) === session) sessions.delete(key);
  session.sourceStream?.unpipe(session.transcoder.stdin ?? undefined);
  session.sourceStream?.destroy();
  session.downloader?.stdout?.unpipe(session.transcoder.stdin ?? undefined);
  void cleanupYoutubeMusicHlsResources(
    session.directory,
    session.downloader ? [session.downloader, session.transcoder] : [session.transcoder],
  ).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "Unknown cleanup error";
    process.emitWarning(`Could not remove a temporary audio-stream directory: ${message}`);
  });
}

function failSession(session: HlsSession, message: string): void {
  if (session.cancelled || session.error) return;
  session.error = message;
  session.sourceStream?.unpipe(session.transcoder.stdin ?? undefined);
  session.sourceStream?.destroy();
  session.downloader?.stdout?.unpipe(session.transcoder.stdin ?? undefined);
  if (session.downloader) stopProcess(session.downloader);
  stopProcess(session.transcoder);
}

async function createSession(
  token: string,
  quality: YoutubeAudioQuality,
  watchUrl: string | null,
  cachedAudio?: Buffer,
  sourceStream?: Readable,
): Promise<HlsSession> {
  if (!cachedAudio && !sourceStream && !watchUrl) {
    throw new Error("This audio session has no playable source. Select the song again.");
  }
  const ytdlp = cachedAudio || sourceStream ? null : await findYtDlpExecutable();
  const directory = await mkdtemp(path.join(tmpdir(), "lenzo-music-hls-"));
  const playlistPath = path.join(directory, "playlist.m3u8");
  const bitrate = quality === "low" ? "32k" : quality === "medium" ? "64k" : "128k";
  const channels = quality === "high" ? "2" : "1";
  let downloaderDiagnostics = "";
  const downloader = ytdlp && watchUrl && !sourceStream
    ? spawn(ytdlp, [
      "--format", quality === "low" ? "worstaudio[ext=m4a]" : "bestaudio[ext=m4a]",
      "--no-playlist",
      "--no-warnings",
      "--quiet",
      "--no-progress",
      "--socket-timeout", "20",
      "--retries", "2",
      "--fragment-retries", "2",
      "--extractor-retries", "2",
      "--output", "-",
      watchUrl,
    ], { stdio: ["ignore", "pipe", "pipe"] })
    : null;
  const transcoder = spawn(process.env.FFMPEG_PATH || "ffmpeg", [
    "-hide_banner",
    "-loglevel", "error",
    "-i", "pipe:0",
    "-map", "0:a:0",
    "-vn",
    "-sn",
    "-dn",
    "-c:a", "aac",
    "-b:a", bitrate,
    "-ac", channels,
    ...(quality === "low" ? ["-ar", "22050"] : quality === "medium" ? ["-ar", "32000"] : []),
    "-f", "hls",
    "-hls_time", String(YOUTUBE_MUSIC_HLS_SEGMENT_SECONDS),
    "-hls_playlist_type", "event",
    "-hls_segment_type", "fmp4",
    "-hls_fmp4_init_filename", "init.mp4",
    "-hls_flags", "independent_segments+append_list+temp_file",
    "-hls_list_size", "0",
    "-hls_segment_filename", path.join(directory, "segment_%05d.m4s"),
    playlistPath,
  ], { stdio: ["pipe", "ignore", "ignore"] });

  const now = Date.now();
  const session: HlsSession = {
    token,
    quality,
    directory,
    playlistPath,
    downloader,
    sourceStream: sourceStream ?? null,
    transcoder,
    createdAt: now,
    lastAccess: now,
    sourceBytes: 0,
    complete: false,
    cancelled: false,
    error: null,
    timeout: setTimeout(() => failSession(session, "The audio stream took too long to prepare."), 180_000),
  };
  session.timeout.unref();
  sessions.set(sessionKey(token, quality), session);

  const downloadOutput = downloader?.stdout;
  const transcodeInput = transcoder.stdin;
  if (!transcodeInput) {
    failSession(session, "The audio stream could not be connected.");
    throw new Error(session.error ?? "The audio stream could not be connected.");
  }

  transcodeInput.on("error", () => {
    // ffmpeg can close stdin after an input/transcoding error; its close event records the failure.
  });
  transcoder.on("error", () => failSession(session, "The audio segmenter could not start."));
  transcoder.on("close", (code) => {
    clearTimeout(session.timeout);
    if (session.cancelled) return;
    if (code === 0 && !session.error) session.complete = true;
    else if (!session.error) failSession(session, "The audio segmenter could not finish this song.");
  });
  if (cachedAudio) {
    session.sourceBytes = cachedAudio.byteLength;
    if (session.sourceBytes > MAX_SOURCE_AUDIO_BYTES) {
      failSession(session, "This song exceeds the 24 MB audio limit.");
    } else {
      transcodeInput.end(cachedAudio);
    }
  } else if (sourceStream) {
    sourceStream.on("data", (chunk: Buffer) => {
      session.sourceBytes += chunk.byteLength;
      if (session.sourceBytes > MAX_SOURCE_AUDIO_BYTES) {
        failSession(session, "This song exceeds the 24 MB audio limit.");
      }
    });
    sourceStream.on("error", () => failSession(session, "The audio source stopped unexpectedly."));
    sourceStream.pipe(transcodeInput);
  } else if (downloader && downloadOutput) {
    downloadOutput.on("data", (chunk: Buffer) => {
      session.sourceBytes += chunk.byteLength;
      if (session.sourceBytes > MAX_SOURCE_AUDIO_BYTES) {
        failSession(session, "This song exceeds the 24 MB audio limit.");
      }
    });
    downloadOutput.on("error", () => failSession(session, "The audio download stopped unexpectedly."));
    downloader.stderr?.on("data", (chunk: Buffer) => {
      if (downloaderDiagnostics.length < 4096) {
        downloaderDiagnostics += chunk.toString("utf8").slice(0, 4096 - downloaderDiagnostics.length);
      }
    });
    downloader.on("error", () => failSession(session, "The audio downloader could not start."));
    downloader.on("close", (code) => {
      if (code !== 0 && !session.cancelled && !session.error) {
        failSession(
          session,
          isYoutubeSignInBlock(downloaderDiagnostics)
            ? YOUTUBE_SIGN_IN_BLOCK_MESSAGE
            : "The downloader could not prepare this song for streaming.",
        );
      }
    });
    downloadOutput.pipe(transcodeInput);
  } else {
    failSession(session, "The audio stream could not be connected.");
  }
  return session;
}

async function waitForFirstSegment(session: HlsSession): Promise<void> {
  const deadline = Date.now() + FIRST_SEGMENT_TIMEOUT_MS;
  const initPath = path.join(session.directory, "init.mp4");
  const firstSegmentPath = path.join(session.directory, "segment_00000.m4s");
  while (Date.now() < deadline) {
    if (session.error) throw new Error(session.error);
    try {
      const [init, segment, playlist] = await Promise.all([
        stat(initPath),
        stat(firstSegmentPath),
        readFile(session.playlistPath, "utf8"),
      ]);
      if (init.size > 0 && segment.size > 0 && playlist.includes("segment_00000.m4s")) return;
    } catch {
      // Wait for ffmpeg to atomically publish the first complete segment and playlist.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("The first audio segment did not become ready in time.");
}

function pruneSessions(): void {
  const now = Date.now();
  for (const session of sessions.values()) {
    if (now - session.lastAccess > HLS_SESSION_TTL_MS) removeSession(session);
  }
  while (sessions.size >= MAX_HLS_SESSIONS) {
    const oldestCompleted = [...sessions.values()]
      .filter((session) => session.complete || session.error)
      .sort((left, right) => left.createdAt - right.createdAt)[0];
    if (!oldestCompleted) break;
    removeSession(oldestCompleted);
  }
}

export async function openYoutubeMusicHlsSession(
  token: string,
  quality: YoutubeAudioQuality,
): Promise<HlsSession> {
  return openYoutubeMusicHlsSessionInternal(token, quality);
}

export async function openYoutubeMusicHlsSessionFromStream(
  token: string,
  quality: YoutubeAudioQuality,
  sourceStream: Readable,
): Promise<HlsSession> {
  return openYoutubeMusicHlsSessionInternal(token, quality, sourceStream);
}

async function openYoutubeMusicHlsSessionInternal(
  token: string,
  quality: YoutubeAudioQuality,
  sourceStream?: Readable,
): Promise<HlsSession> {
  const cached = getCachedYoutubeAudioEntry(token, quality);
  if (!cached) throw new Error("This audio link expired. Run the scraper test again.");

  const key = sessionKey(token, quality);
  let session = sessions.get(key);
  if (session?.error) {
    removeSession(session);
    session = undefined;
  }
  if (!session) {
    pruneSessions();
    const activeCount = [...sessions.values()].filter((current) => !current.complete && !current.error).length;
    if (activeCount >= MAX_ACTIVE_HLS_SESSIONS) {
      throw new Error("Too many songs are preparing to stream. Wait for one to finish, then try again.");
    }
    let starting = startingSessions.get(key);
    if (!starting) {
      starting = createSession(token, quality, cached.watchUrl, cached.audioBytes, sourceStream)
        .finally(() => startingSessions.delete(key));
      startingSessions.set(key, starting);
    }
    session = await starting;
  }

  session.lastAccess = Date.now();
  await waitForFirstSegment(session);
  return session;
}

export async function readYoutubeMusicHlsPlaylist(
  token: string,
  quality: YoutubeAudioQuality,
): Promise<string> {
  const session = await openYoutubeMusicHlsSession(token, quality);
  session.lastAccess = Date.now();
  if (session.error) throw new Error(session.error);
  return readFile(session.playlistPath, "utf8");
}

export async function waitForYoutubeMusicHlsSessionComplete(
  token: string,
  quality: YoutubeAudioQuality,
  timeoutMs = 120_000,
): Promise<void> {
  const session = await openYoutubeMusicHlsSessionInternal(token, quality);
  const deadline = Date.now() + timeoutMs;
  while (!session.complete) {
    if (session.error) throw new Error(session.error);
    if (session.cancelled) throw new Error("The audio session was stopped before conversion finished.");
    if (Date.now() >= deadline) throw new Error("The complete song took too long to prepare for playback.");
    session.lastAccess = Date.now();
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (session.error) throw new Error(session.error);
  session.lastAccess = Date.now();
}

export function getYoutubeMusicHlsAssetPath(
  token: string,
  quality: YoutubeAudioQuality,
  asset: string,
): string | null {
  if (asset !== "init.mp4" && !/^segment_\d{5}\.m4s$/.test(asset)) return null;
  const session = sessions.get(sessionKey(token, quality));
  if (!session || session.error || session.lastAccess + HLS_SESSION_TTL_MS <= Date.now()) return null;
  session.lastAccess = Date.now();
  return path.join(session.directory, asset);
}

export function stopYoutubeMusicHlsSession(token: string, quality: YoutubeAudioQuality): void {
  const session = sessions.get(sessionKey(token, quality));
  if (session) removeSession(session);
}

export async function getYoutubeMusicHlsCacheStats(): Promise<{
  entries: number;
  active: number;
  completed: number;
  failed: number;
  diskBytes: number;
  nextExpiryAt: number | null;
}> {
  const now = Date.now();
  const liveSessions = [...sessions.values()].filter(
    (session) => session.lastAccess + HLS_SESSION_TTL_MS > now && !session.cancelled,
  );
  let diskBytes = 0;
  for (const session of liveSessions) {
    const names = await readdir(session.directory).catch(() => []);
    const fileSizes = await Promise.all(names.map(async (name) => {
      try {
        const file = await stat(path.join(session.directory, name));
        return file.isFile() ? file.size : 0;
      } catch {
        return 0;
      }
    }));
    diskBytes += fileSizes.reduce((total, size) => total + size, 0);
  }
  const expiries = liveSessions.map((session) => session.lastAccess + HLS_SESSION_TTL_MS);
  return {
    entries: liveSessions.length,
    active: liveSessions.filter((session) => !session.complete && !session.error).length,
    completed: liveSessions.filter((session) => session.complete).length,
    failed: liveSessions.filter((session) => !!session.error).length,
    diskBytes,
    nextExpiryAt: expiries.length ? Math.min(...expiries) : null,
  };
}

const sessionCleanupTimer = setInterval(() => {
  for (const session of sessions.values()) {
    if (Date.now() - session.lastAccess > HLS_SESSION_TTL_MS) removeSession(session);
  }
}, 60_000);
sessionCleanupTimer.unref();
