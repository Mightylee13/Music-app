import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Router, type IRouter, type Request, type RequestHandler, type Response as ExpressResponse } from "express";
import {
  ClearMusicAdminDiagnosticsResponse,
  GetMusicAdminOverviewResponse,
  GetMusicAdminSessionResponse,
  GetMusicPlaybackAudioQueryParams,
  GetMusicAlbumQueryParams,
  GetMusicAlbumResponse,
  GetMusicGenresResponse,
  GetMusicSuggestionsQueryParams,
  GetMusicSuggestionsResponse,
  ImportSpotifyPlaylistBody,
  GetMusicLyricsQueryParams,
  GetMusicLyricsResponse,
  LoginMusicAdminBody,
  LoginMusicAdminResponse,
  LogoutMusicAdminResponse,
  PrepareMusicPlaybackBody,
  PrepareMusicPlaybackResponse,
  SearchMusicBody,
  SearchMusicResponse,
  StartNativeMusicPlaybackQueryParams,
  StopMusicPlaybackQueryParams,
  StreamMusicHlsAssetQueryParams,
  StreamMusicHlsPlaylistQueryParams,
} from "@workspace/api-zod";
import {
  cacheYoutubeAudioBytes,
  createYoutubeMusicPlaybackSession,
  downloadYoutubeMusicAudio,
  getCachedYoutubeAudioEntry,
  getYoutubeMusicScraperCacheStats,
  findYtDlpExecutable,
  isUploadedYoutubeMusicScraperAvailable,
  removeCachedYoutubeAudioStream,
  testUploadedYoutubeMusicScraper,
  type YoutubeAudioQuality,
  type YoutubeMusicScraperRequest,
  type YoutubeMusicScraperResult,
} from "../lib/youtube-music-scraper.js";
import {
  getYoutubeMusicHlsAssetPath,
  getYoutubeMusicHlsCacheStats,
  openYoutubeMusicHlsSession,
  readYoutubeMusicHlsPlaylist,
  stopYoutubeMusicHlsSession,
} from "../lib/youtube-music-hls.js";
import { lookupLrclibLyrics } from "../lib/lrclib-lyrics.js";
import { lookupUnisonLyrics } from "../lib/unison-lyrics.js";
import { matchesMusicArtist, matchesMusicTitle } from "../lib/music-identity.js";
import { matchesMusicSuggestionQuery } from "../lib/music-suggestion-matching.js";
import { importSpotifyPlaylist, normalizeSpotifyPlaylistUrl } from "../lib/spotify-playlist-import.js";
import { youtubeVideoIdFromSourceUrl } from "../lib/music-source-url.js";
import {
  clearMusicAdminLoginAttempts,
  consumeMusicAdminLoginAttempt,
  endMusicAdminSession,
  isMusicAdminAuthenticated,
  isMusicAdminConfigured,
  isSameOriginMusicAdminRequest,
  startMusicAdminSession,
  verifyMusicAdminPassword,
} from "../lib/music-admin-auth.js";
import {
  clearMusicAdminDiagnostics,
  collectMusicBackendDiagnostics,
  getMusicAdminDiagnostics,
} from "../lib/music-admin-diagnostics.js";

const router: IRouter = Router();
router.use(collectMusicBackendDiagnostics);
const MAX_SCRAPER_REQUESTS_PER_MINUTE = 35;
const MAX_SUGGESTION_REQUESTS_PER_MINUTE = 40;
const MAX_SPOTIFY_PLAYLIST_IMPORTS_PER_MINUTE = 5;
const MAX_LYRICS_REQUESTS_PER_MINUTE = 20;
const MAX_PLAYBACK_REQUESTS_PER_MINUTE = 30;
const scraperRequestTimes = new Map<string, number[]>();
const suggestionRequestTimes = new Map<string, number[]>();
const spotifyPlaylistImportRequestTimes = new Map<string, number[]>();
const lyricsRequestTimes = new Map<string, number[]>();
const playbackRequestTimes = new Map<string, number[]>();
type MusicSuggestionItem = {
  kind: "song" | "album";
  id: string;
  title: string;
  artist: string;
  albumId: string | null;
  thumbnailUrl: string | null;
  sourceUrl: string | null;
  durationSeconds: number | null;
};
type MusicSearchTrack = {
  title: string;
  artist: string | null;
  album: string | null;
  duration: string | null;
  coverUrl: string | null;
  sourceUrl: string | null;
};
const musicSuggestionCache = new Map<string, { expiresAt: number; suggestions: MusicSuggestionItem[] }>();
type DownloadedAudio = { bytes: Buffer; contentType: string };

const requireMusicAdmin: RequestHandler = (request, response, next) => {
  if (!isMusicAdminAuthenticated(request)) {
    response.status(401).json({ error: "Sign in to the private music admin page." });
    return;
  }
  next();
};

function checkCommandAvailable(command: string): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ready: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ready);
    };
    const child = spawn(command, ["-version"], { stdio: "ignore" });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(false);
    }, 1_500);
    child.once("error", () => finish(false));
    child.once("close", (code) => finish(code === 0));
  });
}

function availableExpiryTimes(...times: Array<number | null>): number | null {
  const available = times.filter((time): time is number => typeof time === "number" && Number.isFinite(time));
  return available.length ? Math.min(...available) : null;
}

router.get("/music/admin/session", (request, response): void => {
  response.json(GetMusicAdminSessionResponse.parse({
    configured: isMusicAdminConfigured(),
    authenticated: isMusicAdminAuthenticated(request),
  }));
});

router.post("/music/admin/login", (request, response): void => {
  if (!isSameOriginMusicAdminRequest(request)) {
    response.status(403).json({ error: "Admin sign-in must come from this site." });
    return;
  }
  if (!isMusicAdminConfigured()) {
    response.status(503).json({ error: "Private music admin sign-in is not configured." });
    return;
  }
  const parsed = LoginMusicAdminBody.safeParse(request.body);
  if (!parsed.success) {
    response.status(400).json({ error: "Enter the admin password to continue." });
    return;
  }
  const attemptKey = request.ip || request.socket.remoteAddress || "unknown";
  const retryAfterMs = consumeMusicAdminLoginAttempt(attemptKey);
  if (retryAfterMs > 0) {
    response.setHeader("Retry-After", String(Math.ceil(retryAfterMs / 1_000)));
    response.status(429).json({ error: "Too many sign-in attempts. Wait before trying again." });
    return;
  }
  if (!verifyMusicAdminPassword(parsed.data.password)) {
    response.status(401).json({ error: "The admin password was not accepted." });
    return;
  }
  clearMusicAdminLoginAttempts(attemptKey);
  startMusicAdminSession(response, request);
  response.json(LoginMusicAdminResponse.parse({ configured: true, authenticated: true }));
});

router.post("/music/admin/logout", (request, response): void => {
  if (!isSameOriginMusicAdminRequest(request)) {
    response.status(403).json({ error: "Admin sign-out must come from this site." });
    return;
  }
  endMusicAdminSession(response, request);
  response.json(LogoutMusicAdminResponse.parse({
    configured: isMusicAdminConfigured(),
    authenticated: false,
  }));
});

router.get("/music/admin/overview", requireMusicAdmin, async (_request, response): Promise<void> => {
  const [scraperReady, ytDlpReady, ffmpegReady, ffprobeReady, hlsCache] = await Promise.all([
    isUploadedYoutubeMusicScraperAvailable(),
    findYtDlpExecutable().then(() => true).catch(() => false),
    checkCommandAvailable("ffmpeg"),
    checkCommandAvailable("ffprobe"),
    getYoutubeMusicHlsCacheStats(),
  ]);
  const scraperCache = getYoutubeMusicScraperCacheStats();
  const now = Date.now();
  const suggestionExpiries = [...musicSuggestionCache.values()]
    .filter((entry) => entry.expiresAt > now)
    .map((entry) => entry.expiresAt);
  const toolsReady = [scraperReady, ytDlpReady, ffmpegReady, ffprobeReady].every(Boolean);
  response.json(GetMusicAdminOverviewResponse.parse({
    service: {
      status: toolsReady ? "healthy" : "degraded",
      uptimeSeconds: Math.floor(process.uptime()),
      checkedAt: new Date(now).toISOString(),
    },
    tools: {
      scraper: { ready: scraperReady },
      ytDlp: { ready: ytDlpReady },
      ffmpeg: { ready: ffmpegReady },
      ffprobe: { ready: ffprobeReady },
    },
    cache: {
      suggestionEntries: suggestionExpiries.length,
      verifiedAudioEntries: 0,
      verifiedAudioBytes: 0,
      verifiedAudioMaxBytes: 0,
      scraperSessionEntries: scraperCache.entries,
      scraperAudioBytes: scraperCache.audioBytes,
      scraperAudioMaxBytes: scraperCache.maxAudioBytes,
      hlsSessionEntries: hlsCache.entries,
      activeHlsSessions: hlsCache.active,
      completedHlsSessions: hlsCache.completed,
      failedHlsSessions: hlsCache.failed,
      hlsDiskBytes: hlsCache.diskBytes,
      nextExpiryAt: availableExpiryTimes(
        suggestionExpiries.length ? Math.min(...suggestionExpiries) : null,
        scraperCache.nextExpiryAt,
        hlsCache.nextExpiryAt,
      ),
    },
    diagnostics: getMusicAdminDiagnostics(),
  }));
});

router.delete("/music/admin/diagnostics", requireMusicAdmin, (request, response): void => {
  if (!isSameOriginMusicAdminRequest(request)) {
    response.status(403).json({ error: "Diagnostics must be cleared from this site." });
    return;
  }
  clearMusicAdminDiagnostics();
  response.json(ClearMusicAdminDiagnosticsResponse.parse({ cleared: true }));
});

function normalizePlaybackQuality(quality: YoutubeAudioQuality): YoutubeAudioQuality {
  return quality === "high" || quality === "medium" ? quality : "low";
}
const pendingAudioDownloads = new Map<string, Promise<DownloadedAudio>>();
const nativePlaybackPreparations = new Map<string, Promise<void>>();

const genres = [
  { id: "afrobeats", name: "Afrobeats", searchQuery: "afrobeats Nigeria hits", description: "New sounds and favorites from across Africa." },
  { id: "hip-hop", name: "Hip-Hop", searchQuery: "hip hop hits", description: "Rap, rhythm, and current favorites." },
  { id: "r-and-b", name: "R&B", searchQuery: "R&B soul hits", description: "Smooth vocals, soul, and late-night tracks." },
  { id: "pop", name: "Pop", searchQuery: "pop music hits", description: "Popular songs across the charts." },
  { id: "amapiano", name: "Amapiano", searchQuery: "amapiano hits", description: "Piano-led dance music and South African favorites." },
  { id: "gospel", name: "Gospel", searchQuery: "gospel music Nigeria", description: "Gospel songs and worship music." },
];

function requestKey(request: Request): string {
  return request.ip || "unknown";
}

function hitLimit(
  request: Request,
  windows: Map<string, number[]>,
  limit: number,
): boolean {
  const now = Date.now();
  const key = requestKey(request);
  const recent = (windows.get(key) ?? []).filter((timestamp) => now - timestamp < 60_000);
  if (recent.length >= limit) {
    windows.set(key, recent);
    return true;
  }
  recent.push(now);
  windows.set(key, recent);
  return false;
}

function normalizeScraperTrack(
  track: { videoId: string | null; title: string; artist: string; durationSeconds: number | null },
  albumTitle: string | null,
  albumId: string | null,
  thumbnailUrl: string | null,
) {
  if (!track.videoId) return null;
  return {
    id: track.videoId,
    title: track.title,
    artist: track.artist || "Unknown artist",
    albumTitle,
    albumId,
    thumbnailUrl: thumbnailUrl ?? youtubeVideoThumbnail(track.videoId),
    durationSeconds: track.durationSeconds,
    sourceUrl: `https://music.youtube.com/watch?v=${encodeURIComponent(track.videoId)}`,
  };
}

function youtubeVideoThumbnail(videoId: string | null | undefined): string | null {
  return videoId && /^[a-zA-Z0-9_-]{11}$/.test(videoId)
    ? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`
    : null;
}

function normalizeAlbum(item: YoutubeMusicScraperResult["items"][number]) {
  const id = item.id ?? "";
  const tracks = item.tracks.flatMap((track) => {
    const normalized = normalizeScraperTrack(track, item.title, id, item.thumbnail);
    return normalized ? [normalized] : [];
  });
  return {
    id,
    title: item.title,
    artist: item.creator ?? "Unknown artist",
    thumbnailUrl: item.thumbnail ?? tracks[0]?.thumbnailUrl ?? null,
    releaseYear: item.releaseYear,
    totalTracks: item.totalTracks,
    tracks,
  };
}

async function searchCatalogAlbums(
  query: string,
  region = "NG",
): Promise<Array<ReturnType<typeof normalizeAlbum>>> {
  const result = await testUploadedYoutubeMusicScraper({
    query,
    region,
    probeStreaming: false,
    filter: "albums",
  });
  return result.items
    .filter((item) => item.category === "album" && item.id)
    .map((item) => normalizeAlbum(item));
}

async function searchMusicTracks(
  query: string,
  options: { timeoutMs?: number; region?: string } = {},
): Promise<MusicSearchTrack[]> {
  const normalizedQuery = query.trim().slice(0, 160);
  if (!normalizedQuery) return [];

  const result = await testUploadedYoutubeMusicScraper({
    query: normalizedQuery,
    region: options.region ?? "NG",
    probeStreaming: false,
    timeoutMs: options.timeoutMs,
    filter: "songs",
  });
  if (!result.status) {
    throw new Error(result.error || "The YouTube Music scraper could not search for songs.");
  }

  return result.items
    .filter((item) => item.category === "song" && !!item.title && !!item.id)
    .map((item) => ({
      title: item.title,
      artist: item.creator,
      album: item.albumTitle,
      duration: item.duration ?? (item.durationSeconds != null ? String(item.durationSeconds) : null),
      coverUrl: item.thumbnail,
      sourceUrl: item.watchUrl ?? `https://music.youtube.com/watch?v=${encodeURIComponent(item.id!)}`,
    }));
}

function durationSeconds(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds > 0) return Math.floor(seconds);
  const parts = value.split(":").map(Number);
  if (parts.length === 2 && parts.every((part) => Number.isFinite(part) && part >= 0)) {
    return parts[0] * 60 + parts[1];
  }
  if (parts.length === 3 && parts.every((part) => Number.isFinite(part) && part >= 0)) {
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  }
  return null;
}

function normalizeArtistLookupQuery(value: string): string {
  return value
    .replace(/^\s*artists?\s*:\s*/i, "")
    .trim()
    .replace(/^(?:show|list|find|search)\s+(?:me\s+)?(?:the\s+)?/i, "")
    .replace(/^(?:songs?|tracks?|music)\s+(?:by|from)\s+/i, "")
    .replace(/\s+(?:songs?|tracks?|music)$/i, "")
    .trim();
}

function normalizeMusicText(value: string): string {
  return value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, " ").trim();
}

function artistMatchesLookup(artist: string, lookup: string): boolean {
  const normalizedLookup = normalizeMusicText(lookup);
  if (!normalizedLookup) return false;
  const credits = artist
    .replace(/[()[\]{}]/g, " ")
    .split(/[,;/&+]|\b(?:feat(?:uring)?|ft|with|and)\b|\bx\b/gi)
    .map(normalizeMusicText)
    .filter(Boolean);
  return credits.includes(normalizedLookup);
}

router.get("/music/genres", (_request, response): void => {
  response.json(GetMusicGenresResponse.parse({ genres }));
});

router.post("/music/spotify-playlists/import", async (request, response): Promise<void> => {
  const parsed = ImportSpotifyPlaylistBody.safeParse(request.body);
  if (!parsed.success) {
    response.status(400).json({ error: parsed.error.message });
    return;
  }
  const playlist = normalizeSpotifyPlaylistUrl(parsed.data.url);
  if (!playlist) {
    response.status(400).json({ error: "Enter a Spotify playlist link or spotify:playlist URI." });
    return;
  }
  if (hitLimit(request, spotifyPlaylistImportRequestTimes, MAX_SPOTIFY_PLAYLIST_IMPORTS_PER_MINUTE)) {
    response.status(429).json({ error: "Too many playlist imports. Please wait a minute and try again." });
    return;
  }

  try {
    const imported = await importSpotifyPlaylist(playlist.url);
    response.json(imported);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Unknown Spotify playlist import error.";
    request.log.warn({ playlistId: playlist.id, error: detail }, "Spotify playlist import failed");
    const noTracks = /no importable songs/i.test(detail);
    response.status(noTracks ? 422 : 502).json({
      error: noTracks
        ? "This playlist has no importable songs. Check that it is public and try again."
        : "Could not load this Spotify playlist. Make sure it is public and try again.",
    });
  }
});

router.get("/music/suggestions", async (request, response): Promise<void> => {
  const parsed = GetMusicSuggestionsQueryParams.safeParse(request.query);
  if (!parsed.success) {
    response.status(400).json({ error: parsed.error.message });
    return;
  }
  const query = parsed.data.q.trim();
  if (query.length < 2) {
    response.status(400).json({ error: "Enter at least two characters for online suggestions." });
    return;
  }
  const cacheKey = normalizeMusicText(query);
  const cached = musicSuggestionCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    response.json(GetMusicSuggestionsResponse.parse({ query, suggestions: cached.suggestions }));
    return;
  }
  if (cached) musicSuggestionCache.delete(cacheKey);
  if (hitLimit(request, suggestionRequestTimes, MAX_SUGGESTION_REQUESTS_PER_MINUTE)) {
    response.status(429).json({ error: "Online suggestions are unavailable right now. Keep typing or press Search." });
    return;
  }

  try {
    const searchTerm = normalizeArtistLookupQuery(query);
    const isArtistQuery = !/\s+by\s+/i.test(query)
      && normalizeMusicText(searchTerm).split(" ").filter(Boolean).length <= 2;
    const tracks = await searchMusicTracks(searchTerm, {
      timeoutMs: 3_500,
    });
    const exactArtistTracks = isArtistQuery
      ? tracks.filter((track) => track.artist && artistMatchesLookup(track.artist, searchTerm))
      : [];
    const relevantTracks = exactArtistTracks.length
      ? exactArtistTracks
      : tracks.filter((track) => matchesMusicSuggestionQuery(track, query));
    const songSuggestions: MusicSuggestionItem[] = [];
    const albumSuggestions: MusicSuggestionItem[] = [];
    const seen = new Set<string>();
    const addSuggestion = (target: MusicSuggestionItem[], suggestion: MusicSuggestionItem) => {
      const key = `${suggestion.kind}:${normalizeMusicText(suggestion.title)}:${normalizeMusicText(suggestion.artist)}`;
      if (seen.has(key)) return;
      seen.add(key);
      target.push(suggestion);
    };
    for (const track of relevantTracks) {
      if (!track.sourceUrl || !track.title || !track.artist) continue;
      if (songSuggestions.length < 5) {
        addSuggestion(songSuggestions, {
          kind: "song",
          id: track.sourceUrl,
          title: track.title,
          artist: track.artist,
          albumId: null,
          thumbnailUrl: track.coverUrl,
          sourceUrl: track.sourceUrl,
          durationSeconds: durationSeconds(track.duration),
        });
      }
    }
    const albumQuery = normalizeArtistLookupQuery(query).split(/\s+by\s+/i)[0]?.trim() ?? searchTerm;
    const normalizedAlbumQuery = normalizeMusicText(albumQuery);
    const albumTracks = exactArtistTracks.length
      ? exactArtistTracks
      : relevantTracks.filter((track) =>
        !!track.album && !!normalizedAlbumQuery && normalizeMusicText(track.album).includes(normalizedAlbumQuery),
      );
    for (const track of albumTracks) {
      if (!track.album) continue;
      addSuggestion(albumSuggestions, {
        kind: "album",
        id: `album:${normalizeMusicText(track.album)}:${normalizeMusicText(track.artist ?? "")}`,
        title: track.album,
        artist: track.artist ?? "Unknown artist",
        albumId: null,
        thumbnailUrl: track.coverUrl,
        sourceUrl: null,
        durationSeconds: null,
      });
    }
    const suggestions = [...songSuggestions, ...albumSuggestions.slice(0, 4)].slice(0, 9);
    const safeSuggestions = suggestions.slice(0, 9);
    musicSuggestionCache.set(cacheKey, { expiresAt: Date.now() + 45_000, suggestions: safeSuggestions });
    if (musicSuggestionCache.size > 300) {
      const oldestKey = musicSuggestionCache.keys().next().value;
      if (oldestKey) musicSuggestionCache.delete(oldestKey);
    }
    response.json(GetMusicSuggestionsResponse.parse({ query, suggestions: safeSuggestions }));
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Unknown suggestion service error.";
    request.log.warn({ query, error: detail }, "Lenzo Music catalog suggestions failed");
    response.json(GetMusicSuggestionsResponse.parse({ query, suggestions: [] }));
  }
});

router.post("/music/search", async (request, response): Promise<void> => {
  const parsed = SearchMusicBody.safeParse(request.body);
  if (!parsed.success) {
    response.status(400).json({ error: parsed.error.message });
    return;
  }
  if (hitLimit(request, scraperRequestTimes, MAX_SCRAPER_REQUESTS_PER_MINUTE)) {
    response.status(429).json({ error: "Music search is unavailable right now. Please try again." });
    return;
  }

  try {
    if (parsed.data.kind === "songs" || parsed.data.kind === "all") {
      const albumsPromise: Promise<Array<ReturnType<typeof normalizeAlbum>>> = parsed.data.kind === "all"
        ? searchCatalogAlbums(parsed.data.query, parsed.data.region ?? "NG").catch((error: unknown) => {
          request.log.warn({
            query: parsed.data.query,
            error: error instanceof Error ? error.message : "Album lookup failed.",
          }, "Lenzo Music album results were unavailable during combined search");
          return [];
        })
        : Promise.resolve([]);
      const startedAt = Date.now();
      const explicitArtistLookup = /^\s*artists?\s*:/i.test(parsed.data.query);
      const artistQuery = normalizeArtistLookupQuery(parsed.data.query);
      const artistQueryWords = normalizeMusicText(artistQuery).split(" ").filter(Boolean);
      const artistLookup = explicitArtistLookup || artistQueryWords.length <= 2;
      let results = await searchMusicTracks(
        explicitArtistLookup ? artistQuery : parsed.data.query,
        { timeoutMs: 10_000, region: parsed.data.region ?? "NG" },
      );
      const getArtistResults = (tracks: typeof results) => tracks.filter((track) => {
        const duration = durationSeconds(track.duration);
        return track.artist
          && artistMatchesLookup(track.artist, artistQuery)
          && !(duration && duration > 15 * 60)
          && !/\b(?:mix|playlist|compilation|nonstop)\b/i.test(track.title);
      });
      let artistResults = artistLookup ? getArtistResults(results) : [];
      const shouldSupplementArtist = artistLookup
        && !!artistQuery
        && (explicitArtistLookup || (artistResults.length > 0 && artistResults.length < 35));
      if (shouldSupplementArtist) {
        const featuredResults = await searchMusicTracks(`${artistQuery} feat`, {
          timeoutMs: 10_000,
          region: parsed.data.region ?? "NG",
        });
        const seen = new Set<string>();
        results = [...results, ...featuredResults].filter((track) => {
          const key = `${normalizeMusicText(track.title)}|${normalizeMusicText(track.artist ?? "")}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
        artistResults = getArtistResults(results);
      }
      const relevantResults = results.filter((track) =>
        matchesMusicSuggestionQuery(track, artistLookup ? artistQuery : parsed.data.query),
      );
      const preferredResults = explicitArtistLookup
        ? artistResults
        : artistResults.length ? artistResults : relevantResults;
      const songs = preferredResults
        .filter((track) => !!track.sourceUrl && !!track.title)
        .slice(0, 75)
        .map((track) => ({
          id: randomUUID(),
          title: track.title,
          artist: track.artist ?? "Unknown artist",
          albumTitle: track.album,
          albumId: null,
          thumbnailUrl: track.coverUrl,
          durationSeconds: durationSeconds(track.duration),
          sourceUrl: track.sourceUrl,
        }));
      const albumCandidates = await albumsPromise;
      const albums = explicitArtistLookup || artistResults.length > 0
        ? albumCandidates.filter((album) => artistMatchesLookup(album.artist, artistQuery))
        : albumCandidates.filter((album) =>
          matchesMusicSuggestionQuery({ title: album.title, artist: album.artist }, parsed.data.query),
        );
      request.log.info({
        query: parsed.data.query,
        kind: parsed.data.kind,
        totalProviderMatches: results.length,
        artistMatches: artistResults.length,
        songCount: songs.length,
        albumCount: albums.length,
        elapsedMs: Date.now() - startedAt,
      }, "Lenzo Music song search completed");
      response.json(SearchMusicResponse.parse({
        query: parsed.data.query,
        kind: parsed.data.kind,
        totalResults: songs.length + albums.length,
        songs,
        albums,
      }));
      return;
    }

    const scraperRequest: YoutubeMusicScraperRequest = {
      query: parsed.data.query,
      region: parsed.data.region ?? "NG",
      probeStreaming: false,
      filter: "albums",
    };
    const result = await testUploadedYoutubeMusicScraper(scraperRequest);
    const songs = result.items
      .filter((item) => item.category === "song" && item.id)
      .map((item) => ({
        id: item.id!,
        title: item.title,
        artist: item.creator ?? "Unknown artist",
        albumTitle: item.albumTitle,
        albumId: item.albumId,
        thumbnailUrl: item.thumbnail ?? youtubeVideoThumbnail(item.id),
        durationSeconds: item.durationSeconds,
        sourceUrl: item.watchUrl ?? `https://music.youtube.com/watch?v=${encodeURIComponent(item.id!)}`,
      }));
    const albums = result.items
      .filter((item) => item.category === "album" && item.id)
      .map((item) => normalizeAlbum(item));

    request.log.info({
      query: parsed.data.query,
      kind: "albums",
      resultCount: albums.length,
      elapsedMs: result.elapsedMs,
    }, "Lenzo Music album search completed");
    response.json(SearchMusicResponse.parse({
      query: parsed.data.query,
      kind: "albums",
      totalResults: albums.length,
      songs: [],
      albums,
    }));
  } catch (error) {
    const message = error instanceof Error ? error.message : "The uploaded music scraper failed.";
    request.log.warn({ error: message }, "Lenzo Music search failed");
    response.status(502).json({ error: message });
  }
});

router.get("/music/albums/detail", async (request, response): Promise<void> => {
  const parsed = GetMusicAlbumQueryParams.safeParse(request.query);
  if (!parsed.success) {
    response.status(400).json({ error: parsed.error.message });
    return;
  }
  if (!/^[A-Za-z0-9_-]{1,160}$/.test(parsed.data.albumId)) {
    response.status(400).json({ error: "This album identifier is not supported." });
    return;
  }
  if (hitLimit(request, scraperRequestTimes, MAX_SCRAPER_REQUESTS_PER_MINUTE)) {
    response.status(429).json({ error: "Album information is unavailable right now. Please try again." });
    return;
  }

  try {
    const query = `${parsed.data.title} ${parsed.data.artist}`.slice(0, 160);
    const result = await testUploadedYoutubeMusicScraper({
      query,
      region: "NG",
      probeStreaming: false,
      albumId: parsed.data.albumId,
      albumTitle: parsed.data.title,
      albumArtist: parsed.data.artist,
    });
    const albumItem = result.items.find((item) => item.category === "album" && item.id === parsed.data.albumId)
      ?? result.items.find((item) => item.category === "album");
    if (!albumItem) {
      response.status(404).json({ error: "The album could not be found in the music source." });
      return;
    }
    const album = normalizeAlbum(albumItem);
    if (!album.tracks.length) {
      response.status(404).json({ error: "The album was found, but its tracklist is unavailable." });
      return;
    }
    response.json(GetMusicAlbumResponse.parse(album));
  } catch (error) {
    const message = error instanceof Error ? error.message : "The album source could not be reached.";
    request.log.warn({ error: message }, "Lenzo Music album loading failed");
    response.status(502).json({ error: message });
  }
});

type RequestedMusicIdentity = {
  title?: string;
  artist?: string;
  durationSeconds?: number;
};

async function createScraperMusicHlsSession(
  quality: YoutubeAudioQuality,
  request: Request,
  requestedToken: string | undefined,
  identity: RequestedMusicIdentity,
): Promise<string> {
  const title = identity.title?.trim();
  const artist = identity.artist?.trim();
  if (!title || !artist) {
    throw new Error("A selected title and artist are required for scraper playback.");
  }

  const result = await testUploadedYoutubeMusicScraper({
    query: `${title} ${artist}`.slice(0, 160),
    region: "NG",
    probeStreaming: false,
    timeoutMs: 12_000,
    filter: "songs",
  });
  if (!result.status) {
    throw new Error(result.error || "The Studio scraper returned no playable songs.");
  }

  const candidate = result.items.find((item) => {
    if (item.category !== "song" || !item.id || !item.watchUrl || !item.creator) return false;
    if (!/^[A-Za-z0-9_-]{11}$/.test(item.id)) return false;
    if (!matchesMusicTitle(title, item.title) || !matchesMusicArtist(artist, item.creator)) return false;
    if (identity.durationSeconds && item.durationSeconds) {
      const allowedDifference = Math.max(10, identity.durationSeconds * 0.12);
      if (Math.abs(identity.durationSeconds - item.durationSeconds) > allowedDifference) return false;
    }
    return true;
  });
  if (!candidate?.id) {
    throw new Error(`The Studio scraper did not find a verified match for "${title}" by ${artist}.`);
  }

  const token = createYoutubeMusicPlaybackSession(candidate.id, requestedToken);
  if (!token) {
    throw new Error("The Studio scraper returned an invalid song identifier.");
  }
  try {
    await openYoutubeMusicHlsSession(token, quality);
    request.log.info({
      title: candidate.title,
      artist: candidate.creator,
      quality,
      scraperElapsedMs: result.elapsedMs,
    }, "Started playback with the Lenzo Studio scraper");
    return token;
  } catch (error) {
    stopYoutubeMusicHlsSession(token, quality);
    removeCachedYoutubeAudioStream(token);
    throw error;
  }
}

async function createScraperFirstMusicHlsSession(
  query: string,
  quality: YoutubeAudioQuality,
  request: Request,
  requestedToken: string | undefined,
  input: RequestedMusicIdentity & { sourceUrl?: string },
): Promise<string> {
  if (!input.title?.trim() || !input.artist?.trim()) {
    throw new Error("Choose a song with a title and artist to start playback.");
  }

  const selectedVideoId = youtubeVideoIdFromSourceUrl(input.sourceUrl);
  if (selectedVideoId) {
    const token = createYoutubeMusicPlaybackSession(selectedVideoId, requestedToken);
    if (token) {
      try {
        await openYoutubeMusicHlsSession(token, quality);
        request.log.info({
          title: input.title.trim(),
          artist: input.artist.trim(),
          quality,
        }, "Started playback directly from the selected YouTube result");
        return token;
      } catch (error) {
        stopYoutubeMusicHlsSession(token, quality);
        removeCachedYoutubeAudioStream(token);
        request.log.warn({
          title: input.title.trim(),
          artist: input.artist.trim(),
          error: error instanceof Error ? error.message : "The selected YouTube stream could not start.",
        }, "Selected YouTube source failed; retrying with the uploaded scraper");
      }
    }
  }

  try {
    return await createScraperMusicHlsSession(quality, request, requestedToken, input);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Unknown scraper error";
    request.log.warn({
      query,
      title: input.title.trim(),
      artist: input.artist.trim(),
      error: detail,
    }, "The uploaded YouTube Music scraper could not prepare playback");
    throw error instanceof Error
      ? error
      : new Error("The uploaded YouTube Music scraper could not prepare this song.");
  }
}

router.post("/music/playback", async (request, response): Promise<void> => {
  const parsed = PrepareMusicPlaybackBody.safeParse(request.body);
  if (!parsed.success) {
    response.status(400).json({ error: parsed.error.message });
    return;
  }
  if (hitLimit(request, playbackRequestTimes, MAX_PLAYBACK_REQUESTS_PER_MINUTE)) {
    response.status(429).json({ error: "Playback is unavailable right now. Try again shortly." });
    return;
  }
  const quality = normalizePlaybackQuality(parsed.data.quality);
  try {
    const token = await createScraperFirstMusicHlsSession(
      parsed.data.query,
      quality,
      request,
      undefined,
      parsed.data,
    );
    const query = new URLSearchParams({ token, quality });
    const audioQuery = new URLSearchParams({ token, quality });
    response.json(PrepareMusicPlaybackResponse.parse({
      token,
      quality,
      hlsUrl: `/api/music/playback/stream.m3u8?${query.toString()}`,
      audioUrl: `/api/music/playback/audio?${audioQuery.toString()}`,
    }));
  } catch (error) {
    const message = error instanceof Error ? error.message : "The tested music route could not prepare this song.";
    request.log.warn({ error: message }, "Lenzo Music could not prepare audio from the bot music route");
    response.status(502).json({ error: message });
  }
});

router.get("/music/playback/native.m3u8", async (request, response): Promise<void> => {
  const parsed = StartNativeMusicPlaybackQueryParams.safeParse(request.query);
  if (!parsed.success) {
    response.status(400).json({ error: parsed.error.message });
    return;
  }
  const quality = normalizePlaybackQuality(parsed.data.quality);
  const preparationKey = `${parsed.data.token}:${quality}`;
  try {
    const existingSession = getCachedYoutubeAudioEntry(parsed.data.token, quality);
    let preparation = nativePlaybackPreparations.get(preparationKey);
    if (!existingSession && !preparation) {
      if (hitLimit(request, playbackRequestTimes, MAX_PLAYBACK_REQUESTS_PER_MINUTE)) {
        response.status(429).json({ error: "Playback is unavailable right now. Try again shortly." });
        return;
      }
      preparation = createScraperFirstMusicHlsSession(
        parsed.data.query,
        quality,
        request,
        parsed.data.token,
        parsed.data,
      )
        .then(() => undefined);
      nativePlaybackPreparations.set(preparationKey, preparation);
      try {
        await preparation;
      } finally {
        if (nativePlaybackPreparations.get(preparationKey) === preparation) {
          nativePlaybackPreparations.delete(preparationKey);
        }
      }
    } else if (preparation) {
      await preparation;
    } else {
      await openYoutubeMusicHlsSession(parsed.data.token, quality);
    }
    if (response.destroyed) {
      stopYoutubeMusicHlsSession(parsed.data.token, quality);
      removeCachedYoutubeAudioStream(parsed.data.token);
      return;
    }
    const playlist = await readYoutubeMusicHlsPlaylist(parsed.data.token, quality);
    response.setHeader("content-type", "application/vnd.apple.mpegurl");
    response.setHeader("cache-control", "private, no-store, no-cache, must-revalidate");
    response.setHeader("x-content-type-options", "nosniff");
    response.send(rewriteHlsPlaylist(playlist, parsed.data.token, quality));
  } catch (error) {
    const message = error instanceof Error ? error.message : "The tested music route could not prepare this song.";
    request.log.warn({ error: message }, "Native Lenzo Music playback could not start");
    if (!response.destroyed) response.status(502).json({ error: message });
  }
});

function hlsAssetUrl(token: string, quality: YoutubeAudioQuality, asset: string): string {
  const query = new URLSearchParams({ token, asset, quality });
  return `/api/music/playback/asset?${query.toString()}`;
}

function rewriteHlsPlaylist(playlist: string, token: string, quality: YoutubeAudioQuality): string {
  const lines = playlist.split(/\r?\n/);
  const headerIndex = Math.max(0, lines.indexOf("#EXTM3U")) + 1;
  const startIndex = lines.findIndex((line) => line.startsWith("#EXT-X-START:"));
  if (startIndex >= 0) lines[startIndex] = "#EXT-X-START:TIME-OFFSET=0,PRECISE=YES";
  else lines.splice(headerIndex + 1, 0, "#EXT-X-START:TIME-OFFSET=0,PRECISE=YES");
  return lines.map((line) => {
    if (line.startsWith("#EXT-X-MAP:")) {
      return line.replace(/URI="init\.mp4"/, `URI="${hlsAssetUrl(token, quality, "init.mp4")}"`);
    }
    if (/^segment_\d{5}\.m4s$/.test(line)) return hlsAssetUrl(token, quality, line);
    return line;
  }).join("\n");
}

router.get("/music/playback/stream.m3u8", async (request, response): Promise<void> => {
  const parsed = StreamMusicHlsPlaylistQueryParams.safeParse(request.query);
  if (!parsed.success) {
    response.status(400).json({ error: parsed.error.message });
    return;
  }
  const quality = normalizePlaybackQuality(parsed.data.quality);
  if (!getCachedYoutubeAudioEntry(parsed.data.token, quality)) {
    response.status(410).json({ error: "This playback link expired. Select the song again to create a new stream." });
    return;
  }
  try {
    const playlist = await readYoutubeMusicHlsPlaylist(parsed.data.token, quality);
    response.setHeader("content-type", "application/vnd.apple.mpegurl");
    response.setHeader("cache-control", "private, no-store, no-cache, must-revalidate");
    response.setHeader("x-content-type-options", "nosniff");
    response.send(rewriteHlsPlaylist(playlist, parsed.data.token, quality));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not start the audio stream.";
    request.log.warn({ error: message }, "Lenzo Music HLS stream could not start");
    response.status(502).json({ error: "Could not start the song stream. Select the song again to retry." });
  }
});

router.get("/music/playback/asset", async (request, response): Promise<void> => {
  const parsed = StreamMusicHlsAssetQueryParams.safeParse(request.query);
  if (!parsed.success) {
    response.status(400).end();
    return;
  }
  const quality = normalizePlaybackQuality(parsed.data.quality);
  const assetPath = getYoutubeMusicHlsAssetPath(parsed.data.token, quality, parsed.data.asset);
  if (!assetPath) {
    response.status(404).end();
    return;
  }
  try {
    const bytes = await readFile(assetPath);
    response.setHeader("content-type", parsed.data.asset === "init.mp4" ? "video/mp4" : "video/iso.segment");
    response.setHeader("cache-control", "private, max-age=300");
    response.setHeader("x-content-type-options", "nosniff");
    response.setHeader("content-length", bytes.byteLength);
    response.status(200).end(bytes);
  } catch {
    response.status(404).end();
  }
});

async function downloadAudioWithRetry(
  watchUrl: string,
  quality: YoutubeAudioQuality,
): Promise<DownloadedAudio> {
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      return await downloadYoutubeMusicAudio(watchUrl, quality);
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      const retryable = message.includes("The downloader could not get the full song");
      if (!retryable || attempt === 2) throw error;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw new Error("The audio download failed after retrying.");
}

function parseAudioRange(range: string, size: number): { start: number; end: number } | null {
  const match = range.match(/^bytes=(\d*)-(\d*)$/);
  if (!match || (!match[1] && !match[2])) return null;
  if (!match[1]) {
    const suffixLength = Number(match[2]);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return null;
    return { start: Math.max(0, size - suffixLength), end: size - 1 };
  }
  const start = Number(match[1]);
  const requestedEnd = match[2] ? Number(match[2]) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(requestedEnd) || start >= size || requestedEnd < start) {
    return null;
  }
  return { start, end: Math.min(requestedEnd, size - 1) };
}

function sendCachedAudio(
  response: ExpressResponse,
  audio: DownloadedAudio,
  range: string | undefined,
): void {
  const { bytes, contentType } = audio;
  response.setHeader("content-type", contentType);
  response.setHeader("accept-ranges", "bytes");
  response.setHeader("cache-control", "private, no-store");
  response.setHeader("x-content-type-options", "nosniff");

  if (!range) {
    response.status(200);
    response.setHeader("content-length", bytes.byteLength);
    response.end(bytes);
    return;
  }
  const parsed = parseAudioRange(range, bytes.byteLength);
  if (!parsed) {
    response.status(416);
    response.setHeader("content-range", `bytes */${bytes.byteLength}`);
    response.end();
    return;
  }
  const chunk = bytes.subarray(parsed.start, parsed.end + 1);
  response.status(206);
  response.setHeader("content-range", `bytes ${parsed.start}-${parsed.end}/${bytes.byteLength}`);
  response.setHeader("content-length", chunk.byteLength);
  response.end(chunk);
}

async function getOrDownloadAudio(token: string, quality: YoutubeAudioQuality): Promise<DownloadedAudio> {
  const cached = getCachedYoutubeAudioEntry(token, quality);
  if (!cached) throw new Error("This audio link expired. Select the song again.");
  if (cached.audioBytes && cached.contentType) {
    return { bytes: cached.audioBytes, contentType: cached.contentType };
  }
  const pendingKey = `${token}:${quality}`;
  const activeDownload = pendingAudioDownloads.get(pendingKey);
  if (activeDownload) return activeDownload;
  if (!cached.watchUrl) {
    throw new Error("This audio session has no source URL. Select the song again.");
  }

  const pending = downloadAudioWithRetry(cached.watchUrl, quality).then((audio) => {
    if (!cacheYoutubeAudioBytes(token, audio.bytes, audio.contentType, quality)) {
      throw new Error("The audio could not be kept available for playback.");
    }
    return audio;
  }).finally(() => pendingAudioDownloads.delete(pendingKey));
  pendingAudioDownloads.set(pendingKey, pending);
  return pending;
}

router.get("/music/playback/audio", async (request, response): Promise<void> => {
  const parsed = GetMusicPlaybackAudioQueryParams.safeParse(request.query);
  if (!parsed.success) {
    response.status(400).json({ error: parsed.error.message });
    return;
  }
  const quality = normalizePlaybackQuality(parsed.data.quality);
  if (!getCachedYoutubeAudioEntry(parsed.data.token, quality)) {
    response.status(410).json({ error: "This audio link expired. Select the song again to create a new stream." });
    return;
  }
  const range = request.header("range");
  if (range && !/^bytes=\d*-\d*$/.test(range)) {
    response.status(416).end();
    return;
  }

  try {
    sendCachedAudio(response, await getOrDownloadAudio(parsed.data.token, quality), range);
  } catch (error) {
    const message = error instanceof Error ? error.message : "The YouTube Music download failed.";
    request.log.warn({ error: message, quality }, "Lenzo Music could not deliver audio from the uploaded scraper");
    if (!response.headersSent) response.status(502).json({ error: "The YouTube Music scraper could not prepare this audio. Select the song again to retry." });
    else response.destroy();
  }
});

router.delete("/music/playback/session", (request, response): void => {
  const parsed = StopMusicPlaybackQueryParams.safeParse(request.query);
  if (!parsed.success) {
    response.status(400).json({ error: parsed.error.message });
    return;
  }
  const quality = normalizePlaybackQuality(parsed.data.quality);
  stopYoutubeMusicHlsSession(parsed.data.token, quality);
  removeCachedYoutubeAudioStream(parsed.data.token);
  response.sendStatus(204);
});

router.get("/music/lyrics", async (request, response): Promise<void> => {
  const parsed = GetMusicLyricsQueryParams.safeParse(request.query);
  if (!parsed.success) {
    response.status(400).json({ error: parsed.error.message });
    return;
  }
  if (hitLimit(request, lyricsRequestTimes, MAX_LYRICS_REQUESTS_PER_MINUTE)) {
    response.status(429).json({ error: "Lyrics are unavailable right now. Please try again." });
    return;
  }

  try {
    let lrclibLyrics = null;
    let lrclibError: unknown = null;
    try {
      lrclibLyrics = await lookupLrclibLyrics(parsed.data);
    } catch (error) {
      lrclibError = error;
    }

    const hasTimedLrclibLyrics = !!lrclibLyrics?.syncedLyrics
      && /\[\d{1,3}:\d{2}(?:[.,]\d{1,3})?\]/.test(lrclibLyrics.syncedLyrics);
    if (lrclibLyrics && hasTimedLrclibLyrics) {
      response.json(GetMusicLyricsResponse.parse({ ...lrclibLyrics, source: "LRCLIB" }));
      return;
    }

    try {
      const unisonLyrics = await lookupUnisonLyrics(parsed.data);
      if (unisonLyrics) {
        response.json(GetMusicLyricsResponse.parse({ ...unisonLyrics, source: "BetterLyrics Unison" }));
        return;
      }
    } catch (error) {
      request.log.warn({
        error: error instanceof Error ? error.message : "Unknown Unison lyrics error",
      }, "Lenzo Music Unison lyrics fallback failed");
      if (!lrclibLyrics && lrclibError) throw lrclibError;
    }

    if (lrclibLyrics) {
      response.json(GetMusicLyricsResponse.parse({ ...lrclibLyrics, source: "LRCLIB" }));
      return;
    }
    if (lrclibError) throw lrclibError;
    response.status(404).json({ error: "No matching lyrics are available for this track." });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Lyrics providers could not return lyrics.";
    request.log.warn({ error: message }, "Lenzo Music lyrics lookup failed");
    response.status(502).json({ error: message });
  }
});

export default router;
