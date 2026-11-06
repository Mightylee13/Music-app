import { matchesMusicArtist, matchesMusicTitle } from "./music-identity.js";

type SuggestibleTrack = {
  title: string;
  artist?: string | null;
};

function normalize(value: string): string {
  return value.normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function startsWithTokenSequence(candidate: string, queryWords: string[]): boolean {
  const candidateWords = normalize(candidate).split(" ").filter(Boolean);
  if (queryWords.length === 0 || queryWords.length > candidateWords.length) return false;

  for (let start = 0; start <= candidateWords.length - queryWords.length; start += 1) {
    const matches = queryWords.every((word, index) => {
      const candidateWord = candidateWords[start + index];
      return index === queryWords.length - 1
        ? candidateWord.startsWith(word)
        : candidateWord === word;
    });
    if (matches) return true;
  }
  return false;
}

export function matchesMusicSuggestionQuery(track: SuggestibleTrack, query: string): boolean {
  const byMatch = query.trim().match(/^(.+?)\s+by\s+(.+)$/i);
  if (byMatch) {
    return matchesMusicTitle(byMatch[1] ?? "", track.title)
      && matchesMusicArtist(byMatch[2] ?? "", track.artist ?? "");
  }

  const cleanedQuery = query.trim().replace(/^\s*artists?\s*:\s*/i, "");
  const queryWords = normalize(cleanedQuery).split(" ").filter(Boolean);
  if (queryWords.length === 0) return false;
  const phrases = [
    track.title,
    track.artist ?? "",
    `${track.title} ${track.artist ?? ""}`,
    `${track.artist ?? ""} ${track.title}`,
  ];
  return phrases.some((phrase) => startsWithTokenSequence(phrase, queryWords));
}
