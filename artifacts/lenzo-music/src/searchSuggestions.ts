import type { MusicTrack, MusicSuggestionsResponse } from "@workspace/api-client-react";

export type MusicSuggestion = MusicSuggestionsResponse["suggestions"][number];
export type SearchArtistHint = { name: string; query: string; label: string };

type LocalArtistSuggestion = {
  kind: "artist";
  id: string;
  title: string;
  artist: string;
  searchQuery: string;
  albumId: null;
  thumbnailUrl: null;
  sourceUrl: null;
  durationSeconds: null;
};

export type SearchSuggestion = MusicSuggestion | LocalArtistSuggestion;

export function normalizeSuggestionText(value: string): string {
  return value.normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function suggestionPhraseMatches(candidate: string, queryWords: string[]): boolean {
  const words = normalizeSuggestionText(candidate).split(" ").filter(Boolean);
  for (let start = 0; start <= words.length - queryWords.length; start += 1) {
    if (queryWords.every((word, index) => index === queryWords.length - 1
      ? words[start + index]!.startsWith(word)
      : words[start + index] === word)) return true;
  }
  return false;
}

export function localMusicSuggestions(
  query: string,
  tracks: MusicTrack[],
  artists: SearchArtistHint[],
): SearchSuggestion[] {
  const normalizedQuery = normalizeSuggestionText(query);
  const queryWords = normalizedQuery.split(" ").filter(Boolean);
  if (!queryWords.length) return [];

  const artistSuggestions: LocalArtistSuggestion[] = artists
    .filter((artist) => normalizeSuggestionText(artist.name).startsWith(normalizedQuery))
    .slice(0, 3)
    .map((artist) => ({
      kind: "artist",
      id: `artist:${normalizeSuggestionText(artist.name)}`,
      title: artist.name,
      artist: artist.label,
      searchQuery: artist.query,
      albumId: null,
      thumbnailUrl: null,
      sourceUrl: null,
      durationSeconds: null,
    }));

  const seenTracks = new Set<string>();
  const songSuggestions: MusicSuggestion[] = [];
  for (const track of tracks) {
    if (!suggestionPhraseMatches(track.title, queryWords)
      && !suggestionPhraseMatches(track.artist, queryWords)
      && !suggestionPhraseMatches(`${track.title} ${track.artist}`, queryWords)
      && !suggestionPhraseMatches(`${track.artist} ${track.title}`, queryWords)) continue;

    const key = `${normalizeSuggestionText(track.title)}:${normalizeSuggestionText(track.artist)}`;
    if (seenTracks.has(key)) continue;
    seenTracks.add(key);
    songSuggestions.push({
      kind: "song",
      id: track.sourceUrl || track.id,
      title: track.title,
      artist: track.artist,
      albumId: track.albumId,
      thumbnailUrl: track.thumbnailUrl,
      sourceUrl: track.sourceUrl,
      durationSeconds: track.durationSeconds,
    });
    if (songSuggestions.length >= 4) break;
  }
  return [...artistSuggestions, ...songSuggestions].slice(0, 9);
}

export function mergeSearchSuggestions(
  local: SearchSuggestion[],
  remote: MusicSuggestion[],
): SearchSuggestion[] {
  const seen = new Set<string>();
  return [...local, ...remote].filter((item) => {
    const key = `${item.kind}:${normalizeSuggestionText(item.title)}:${normalizeSuggestionText(item.artist)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 9);
}
