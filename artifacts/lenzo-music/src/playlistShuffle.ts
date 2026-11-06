export type QueueTrack = { id?: string; title: string; artist?: string };

export const musicTrackKey = (track: QueueTrack) =>
  track.id || `${track.title.toLowerCase()}::${(track.artist || '').toLowerCase()}`;

function uniqueTracks<T extends QueueTrack>(tracks: readonly T[]): T[] {
  const seen = new Set<string>();
  return tracks.filter((track) => {
    const key = musicTrackKey(track);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function shuffleTracks<T extends QueueTrack>(tracks: readonly T[], random = Math.random): T[] {
  const shuffled = uniqueTracks(tracks);
  for (let i = shuffled.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

export function nextUnplayedIndex<T extends QueueTrack>(queue: readonly T[], playedKeys: readonly string[]): number {
  const played = new Set(playedKeys);
  return queue.findIndex((track) => !played.has(musicTrackKey(track)));
}

export function createShuffleCycle<T extends QueueTrack>(
  tracks: readonly T[],
  currentTrack: T,
  random = Math.random,
): T[] {
  const nextCycle = shuffleTracks(tracks, random);
  if (nextCycle.length > 1 && musicTrackKey(nextCycle[0]) === musicTrackKey(currentTrack)) {
    [nextCycle[0], nextCycle[1]] = [nextCycle[1], nextCycle[0]];
  }
  return nextCycle;
}

export function shuffleQueueFromCurrent<T extends QueueTrack>(
  queue: readonly T[],
  currentTrack: T,
  playedKeys: readonly string[],
  random = Math.random,
): { queue: T[]; index: number } {
  const currentKey = musicTrackKey(currentTrack);
  const keys = new Set<string>();
  const history = playedKeys
    .filter((key) => key !== currentKey)
    .map((key) => queue.find((track) => musicTrackKey(track) === key))
    .filter((track): track is T => {
      if (!track) return false;
      const key = musicTrackKey(track);
      if (keys.has(key)) return false;
      keys.add(key);
      return true;
    });

  keys.add(currentKey);
  const unplayed = queue.filter((track) => {
    const key = musicTrackKey(track);
    if (keys.has(key)) return false;
    keys.add(key);
    return true;
  });
  const randomizedRemaining = shuffleTracks(unplayed, random);
  const result = [...history, currentTrack, ...randomizedRemaining];
  return { queue: result, index: history.length };
}
