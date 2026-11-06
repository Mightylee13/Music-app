import type { LrclibLyrics } from "./lrclib-lyrics.js";

type LyricsRequest = {
  trackName: string;
  artistName: string;
  albumName?: string;
  duration?: number;
};

export type UnisonLyricsFragmentCandidate = {
  title: string;
  artist: string;
  videoId: string | null;
  duration: number | null;
  format: string | null;
  syncType: string | null;
  confidence: string | null;
  matchScore: number | null;
};

const UNISON_SEARCH_URL = "https://unison.boidu.dev/lyrics/search";
const MAX_RESPONSE_BYTES = 512 * 1024;
const MAX_FRAGMENT_RESULTS = 20;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function normalize(value: string): string {
  return value.normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, " ")
    .trim();
}

function parseClockTime(value: string): number | null {
  const parts = value.trim().split(":");
  if (parts.length < 1 || parts.length > 3) return null;

  const last = Number(parts.at(-1));
  if (!Number.isFinite(last) || last < 0) return null;
  if (parts.length === 1) return last;

  const preceding = parts.slice(0, -1).map(Number);
  if (preceding.some((part) => !Number.isFinite(part) || part < 0)) return null;
  if (last >= 60) return null;
  if (preceding.length === 2 && preceding[1] >= 60) return null;

  if (parts.length === 2) return preceding[0] * 60 + last;
  return preceding[0] * 3600 + preceding[1] * 60 + last;
}

function decodeXmlText(value: string): string {
  return value.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (entity, code: string) => {
    const lower = code.toLowerCase();
    if (lower === "amp") return "&";
    if (lower === "lt") return "<";
    if (lower === "gt") return ">";
    if (lower === "quot") return "\"";
    if (lower === "apos") return "'";
    const numeric = lower.startsWith("#x")
      ? Number.parseInt(lower.slice(2), 16)
      : Number.parseInt(lower.slice(1), 10);
    return Number.isFinite(numeric) && numeric >= 0 && numeric <= 0x10ffff
      ? String.fromCodePoint(numeric)
      : entity;
  });
}

function formatLrcTimestamp(seconds: number): string {
  const totalMilliseconds = Math.max(0, Math.round(seconds * 1000));
  const minutes = Math.floor(totalMilliseconds / 60_000);
  const remainingSeconds = (totalMilliseconds % 60_000) / 1000;
  return `[${String(minutes).padStart(2, "0")}:${remainingSeconds.toFixed(3).padStart(6, "0")}]`;
}

function normalizeLrc(value: string): string | null {
  const rows: Array<{ seconds: number; text: string }> = [];
  const timestampPattern = /\[(\d{1,3}):(\d{2})(?:[.,](\d{1,3}))?\]/g;
  for (const line of value.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const timestamps = [...line.matchAll(timestampPattern)];
    if (!timestamps.length) continue;
    const text = line.replace(timestampPattern, "").trim();
    if (!text) continue;
    for (const match of timestamps) {
      const minutes = Number(match[1]);
      const seconds = Number(match[2]);
      const fraction = match[3] ? Number(`0.${match[3]}`) : 0;
      if (seconds > 59) continue;
      rows.push({ seconds: minutes * 60 + seconds + fraction, text });
    }
  }
  if (!rows.length) return null;
  return rows.sort((left, right) => left.seconds - right.seconds)
    .map((row) => `${formatLrcTimestamp(row.seconds)}${row.text}`)
    .join("\n");
}

function parseTtml(value: string): string | null {
  const rows: Array<{ seconds: number; text: string }> = [];
  const paragraphs = value.matchAll(/<p\b([^>]*)>([\s\S]*?)<\/p\s*>/gi);

  for (const paragraph of paragraphs) {
    const attributes = paragraph[1] ?? "";
    const content = paragraph[2] ?? "";
    const beginAttribute = attributes.match(/\bbegin\s*=\s*["']([^"']+)["']/i)?.[1];
    const firstWordTime = content.match(/<span\b[^>]*\bbegin\s*=\s*["']([^"']+)["']/i)?.[1];
    const seconds = parseClockTime(beginAttribute ?? firstWordTime ?? "");
    if (seconds === null) continue;

    const text = decodeXmlText(
      content
        .replace(/<br\s*\/?>/gi, " ")
        .replace(/<span\b[^>]*>/gi, "")
        .replace(/<\/span\s*>/gi, " ")
        .replace(/<[^>]*>/g, "")
        .replace(/\s+/g, " "),
    ).trim();
    if (text) rows.push({ seconds, text });
  }

  if (!rows.length) return null;
  return rows.sort((left, right) => left.seconds - right.seconds)
    .map((row) => `${formatLrcTimestamp(row.seconds)}${row.text}`)
    .join("\n");
}

export function normalizeUnisonTimedLyrics(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/^\s*\[\d{1,3}:\d{2}(?:[.,]\d{1,3})?\]/m.test(trimmed)) {
    return normalizeLrc(trimmed);
  }
  if (/<(?:[\w.-]+:)?tt\b|<(?:[\w.-]+:)?p\b/i.test(trimmed)) {
    return parseTtml(trimmed);
  }
  return null;
}

function parseDuration(value: unknown, lyrics: string): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  const duration = lyrics.match(/<body\b[^>]*\bdur\s*=\s*["']([^"']+)["']/i)?.[1];
  return duration ? parseClockTime(duration) : null;
}

function parseCandidate(value: unknown, request: LyricsRequest): LrclibLyrics | null {
  const row = asRecord(value);
  if (!row || typeof row.song !== "string" || typeof row.artist !== "string" || typeof row.lyrics !== "string") return null;
  if (normalize(row.song) !== normalize(request.trackName)) return null;
  if (normalize(row.artist) !== normalize(request.artistName)) return null;

  const syncedLyrics = normalizeUnisonTimedLyrics(row.lyrics);
  if (!syncedLyrics) return null;
  const duration = parseDuration(row.duration, row.lyrics);
  if (request.duration && duration && Math.abs(request.duration - duration) > 20) return null;

  return {
    trackName: row.song,
    artistName: row.artist,
    albumName: typeof row.album === "string" && row.album.trim() ? row.album.trim() : null,
    duration,
    plainLyrics: null,
    syncedLyrics,
    hasWordSync: /<span\b[^>]*\bbegin\s*=/i.test(row.lyrics) || /itunes:timing\s*=\s*["']Word["']/i.test(row.lyrics),
  };
}

async function readBoundedResponse(response: Response): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length") ?? 0);
  if (declaredLength > MAX_RESPONSE_BYTES) {
    throw new Error("BetterLyrics Unison returned a response that was too large.");
  }
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error("BetterLyrics Unison returned a response that was too large.");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
}

async function requestUnisonSearch(
  params: Record<string, string>,
  fetcher: typeof fetch,
): Promise<unknown[]> {
  const url = new URL(UNISON_SEARCH_URL);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);

  let response: Response;
  try {
    response = await fetcher(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
      throw new Error("BetterLyrics Unison took too long to respond.");
    }
    throw new Error("Could not connect to BetterLyrics Unison.");
  }

  if (response.status === 404) return [];
  if (response.status === 429) throw new Error("BetterLyrics Unison is rate-limiting requests. Wait briefly and try again.");
  if (!response.ok) throw new Error(`BetterLyrics Unison returned HTTP ${response.status}.`);

  let payload: unknown;
  try {
    payload = JSON.parse(await readBoundedResponse(response)) as unknown;
  } catch (error) {
    if (error instanceof Error && error.message.includes("too large")) throw error;
    throw new Error("BetterLyrics Unison returned invalid JSON.");
  }

  const envelope = asRecord(payload);
  if (envelope?.success === false) return [];
  const data = envelope && "data" in envelope ? envelope.data : payload;
  return Array.isArray(data) ? data : data ? [data] : [];
}

export async function lookupUnisonLyrics(
  requested: LyricsRequest,
  fetcher: typeof fetch = fetch,
): Promise<LrclibLyrics | null> {
  const candidates = await requestUnisonSearch({
    song: requested.trackName,
    artist: requested.artistName,
  }, fetcher);
  for (const candidate of candidates) {
    const parsed = parseCandidate(candidate, requested);
    if (parsed) return parsed;
  }
  return null;
}

export async function searchUnisonLyricsFragments(
  query: string,
  fetcher: typeof fetch = fetch,
): Promise<UnisonLyricsFragmentCandidate[]> {
  const records = await requestUnisonSearch({ q: query }, fetcher);
  return records.flatMap((value) => {
    const row = asRecord(value);
    if (!row || typeof row.song !== "string" || typeof row.artist !== "string") return [];
    const title = row.song.trim();
    const artist = row.artist.trim();
    if (!title || !artist) return [];
    return [{
      title,
      artist,
      videoId: typeof row.videoId === "string" && row.videoId.trim() ? row.videoId.trim() : null,
      duration: typeof row.duration === "number" && Number.isFinite(row.duration) && row.duration > 0
        ? row.duration
        : null,
      format: typeof row.format === "string" && row.format.trim() ? row.format.trim() : null,
      syncType: typeof row.syncType === "string" && row.syncType.trim() ? row.syncType.trim() : null,
      confidence: typeof row.confidence === "string" && row.confidence.trim() ? row.confidence.trim() : null,
      matchScore: typeof row.matchScore === "number" && Number.isFinite(row.matchScore)
        ? Math.min(1, Math.max(0, row.matchScore))
        : null,
    }];
  }).slice(0, MAX_FRAGMENT_RESULTS);
}
