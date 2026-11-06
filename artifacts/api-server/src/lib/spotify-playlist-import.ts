import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

const playlistIdPattern = /^[A-Za-z0-9]{22}$/;
const MAX_TRACKS = 200;
const MAX_OUTPUT_BYTES = 5 * 1024 * 1024;
const IMPORT_TIMEOUT_MS = 90_000;

const trackSchema = z.object({
  title: z.string().trim().min(1),
  artist: z.string().trim().min(1),
  album: z.string().nullable(),
  durationMs: z.number().int().nonnegative().nullable(),
  uri: z.string().nullable(),
  url: z.string().url().nullable(),
  thumbnailUrl: z.string().url().nullable(),
});

const playlistSchema = z.object({
  playlistId: z.string().regex(playlistIdPattern),
  name: z.string().trim().min(1),
  owner: z.string().nullable(),
  description: z.string().nullable(),
  source: z.enum(["anon", "embed"]),
  total: z.number().int().nonnegative(),
  tracks: z.array(trackSchema).max(MAX_TRACKS),
});

export type SpotifyPlaylistImportResult = z.infer<typeof playlistSchema>;

export function normalizeSpotifyPlaylistUrl(input: string): { id: string; url: string } | null {
  const value = input.trim();
  const uriMatch = value.match(/^spotify:playlist:([A-Za-z0-9]{22})$/i);
  if (uriMatch) {
    return { id: uriMatch[1]!, url: `https://open.spotify.com/playlist/${uriMatch[1]}` };
  }

  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:" || parsed.hostname.toLowerCase() !== "open.spotify.com") return null;
    const match = parsed.pathname.match(/(?:^|\/)playlist\/([A-Za-z0-9]{22})(?:\/|$)/i);
    if (!match) return null;
    return { id: match[1]!, url: `https://open.spotify.com/playlist/${match[1]}` };
  } catch {
    return null;
  }
}

function findImporterScript(): string {
  const candidates = [
    path.resolve(process.cwd(), "spotify_playlist_importer.py"),
    path.resolve(process.cwd(), "artifacts/api-server/spotify_playlist_importer.py"),
  ];
  const script = candidates.find((candidate) => existsSync(candidate));
  if (!script) throw new Error("The Spotify playlist importer script is not present in this deployment.");
  return script;
}

function runImporter(script: string, playlistUrl: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.env.PYTHON || process.env.PYTHON3 || "python3",
      [script, playlistUrl, "--json", "--max-tracks", String(MAX_TRACKS)],
      { cwd: process.cwd(), env: process.env, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let timedOut = false;
    let outputTooLarge = false;
    let settled = false;
    const finish = (error?: Error, output?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve(output ?? "");
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, IMPORT_TIMEOUT_MS);

    child.stdout.on("data", (chunk: Buffer) => {
      outputBytes += chunk.byteLength;
      if (outputBytes > MAX_OUTPUT_BYTES) {
        outputTooLarge = true;
        child.kill("SIGTERM");
        return;
      }
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 16_000) stderr += chunk.toString("utf8");
    });
    child.once("error", (error) => finish(error));
    child.once("close", (code) => {
      if (timedOut) {
        finish(new Error("Spotify took too long to return this playlist."));
        return;
      }
      if (outputTooLarge) {
        finish(new Error("The playlist response was too large to import."));
        return;
      }
      if (code !== 0) {
        finish(new Error(stderr.trim() || `Playlist importer exited with code ${code ?? "unknown"}.`));
        return;
      }
      finish(undefined, stdout);
    });
  });
}

export async function importSpotifyPlaylist(url: string): Promise<SpotifyPlaylistImportResult> {
  const normalized = normalizeSpotifyPlaylistUrl(url);
  if (!normalized) throw new Error("Enter a public Spotify playlist link or Spotify playlist URI.");

  const output = await runImporter(findImporterScript(), normalized.url);
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new Error("Spotify returned an unreadable playlist response.");
  }
  if (!parsed || typeof parsed !== "object") throw new Error("Spotify returned an invalid playlist response.");

  const raw = parsed as Record<string, unknown>;
  const rawTracks = Array.isArray(raw.tracks) ? raw.tracks : [];
  const tracks = rawTracks.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const item = entry as Record<string, unknown>;
    const title = typeof item.title === "string" ? item.title.trim() : "";
    const artist = typeof item.artist === "string" ? item.artist.trim() : "";
    if (!title || !artist) return [];
    const duration = Number(item.duration_ms);
    const durationMs = Number.isFinite(duration) && duration >= 0 ? Math.floor(duration) : null;
    return [{
      title,
      artist,
      album: typeof item.album === "string" && item.album.trim() ? item.album.trim() : null,
      durationMs,
      uri: typeof item.uri === "string" ? item.uri : null,
      url: typeof item.url === "string" ? item.url : null,
      thumbnailUrl: typeof item.thumbnail_url === "string" ? item.thumbnail_url : null,
    }];
  }).slice(0, MAX_TRACKS);

  if (!tracks.length) throw new Error("This playlist has no importable songs. It may be private or unavailable.");
  const source = raw.source === "anon" ? raw.source : "embed";
  return playlistSchema.parse({
    playlistId: normalized.id,
    name: typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : "Spotify playlist",
    owner: typeof raw.owner === "string" && raw.owner.trim() ? raw.owner.trim() : null,
    description: typeof raw.description === "string" ? raw.description : null,
    source,
    total: tracks.length,
    tracks,
  });
}
