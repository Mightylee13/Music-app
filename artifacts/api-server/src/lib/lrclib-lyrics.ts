export type LrclibLyrics = {
  trackName: string;
  artistName: string;
  albumName: string | null;
  duration: number | null;
  plainLyrics: string | null;
  syncedLyrics: string | null;
  hasWordSync: boolean;
};

type Metadata = {
  trackName: string;
  artistName: string;
  albumName?: string;
  duration?: number;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function optionalText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalize(value: string): string {
  return value.normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, " ")
    .trim();
}

function parseLyrics(value: unknown): LrclibLyrics | null {
  const row = asRecord(value);
  if (!row) return null;

  const trackName = optionalText(row.trackName) ?? optionalText(row.name);
  const artistName = optionalText(row.artistName);
  const plainLyrics = optionalText(row.plainLyrics);
  const syncedLyrics = optionalText(row.syncedLyrics);
  if (!trackName || !artistName || (!plainLyrics && !syncedLyrics)) return null;

  return {
    trackName,
    artistName,
    albumName: optionalText(row.albumName),
    duration: typeof row.duration === "number" && Number.isFinite(row.duration) ? row.duration : null,
    plainLyrics,
    syncedLyrics,
    hasWordSync: row.hasWordSync === true,
  };
}

function matchesTrack(candidate: LrclibLyrics, requested: Metadata): boolean {
  if (normalize(candidate.trackName) !== normalize(requested.trackName)) return false;

  const artist = normalize(candidate.artistName);
  const requestedArtist = normalize(requested.artistName);
  if (!artist || !requestedArtist || !(artist === requestedArtist || artist.includes(requestedArtist) || requestedArtist.includes(artist))) {
    return false;
  }

  if (requested.duration && candidate.duration && Math.abs(requested.duration - candidate.duration) > 20) {
    return false;
  }
  return true;
}

function chooseBestMatch(results: unknown, requested: Metadata): LrclibLyrics | null {
  if (!Array.isArray(results)) return null;
  const matches = results
    .map(parseLyrics)
    .filter((candidate): candidate is LrclibLyrics => !!candidate && matchesTrack(candidate, requested));

  matches.sort((left, right) => {
    const syncScore = Number(!!right.syncedLyrics) - Number(!!left.syncedLyrics);
    if (syncScore) return syncScore;
    const leftDistance = requested.duration && left.duration ? Math.abs(requested.duration - left.duration) : Infinity;
    const rightDistance = requested.duration && right.duration ? Math.abs(requested.duration - right.duration) : Infinity;
    return leftDistance - rightDistance;
  });
  return matches[0] ?? null;
}

async function requestJson(url: URL): Promise<unknown | null> {
  let response: Response;
  try {
    response = await fetch(url, {
      headers: {
        accept: "application/json",
        "Lrclib-Client": "LenzoStudio/1.0",
      },
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
      throw new Error("LRCLIB took too long to respond.");
    }
    throw new Error("Could not connect to LRCLIB.");
  }

  if (response.status === 404) return null;
  if (response.status === 429) throw new Error("LRCLIB is rate-limiting requests. Wait briefly and try again.");
  if (!response.ok) throw new Error(`LRCLIB returned HTTP ${response.status}.`);

  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > 1024 * 1024) {
    throw new Error("LRCLIB returned a response that was too large.");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error("LRCLIB returned invalid JSON.");
  }
}

function createApiUrl(path: string, requested: Metadata): URL {
  const url = new URL(`https://lrclib.net/api/${path}`);
  url.searchParams.set("track_name", requested.trackName);
  url.searchParams.set("artist_name", requested.artistName);
  if (requested.albumName) url.searchParams.set("album_name", requested.albumName);
  if (requested.duration) url.searchParams.set("duration", String(Math.round(requested.duration)));
  return url;
}

export async function lookupLrclibLyrics(requested: Metadata): Promise<LrclibLyrics | null> {
  const directResult = await requestJson(createApiUrl("get", requested));
  const directMatch = parseLyrics(directResult);
  if (directMatch && matchesTrack(directMatch, requested) && directMatch.syncedLyrics) {
    return directMatch;
  }

  let searchResult: unknown | null;
  try {
    searchResult = await requestJson(createApiUrl("search", requested));
  } catch (error) {
    if (directMatch && matchesTrack(directMatch, requested)) return directMatch;
    throw error;
  }
  const searchMatch = chooseBestMatch(searchResult, requested);
  if (searchMatch?.syncedLyrics) return searchMatch;
  if (directMatch && matchesTrack(directMatch, requested)) return directMatch;
  return searchMatch;
}
