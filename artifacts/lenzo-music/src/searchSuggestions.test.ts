import assert from "node:assert/strict";
import test from "node:test";
import { localMusicSuggestions, mergeSearchSuggestions } from "./searchSuggestions.js";
import type { MusicTrack } from "@workspace/api-client-react";

const artistHints = [
  { name: "Davido", query: "Davido", label: "Nigeria" },
  { name: "Rema", query: "Rema", label: "Nigeria" },
];

function track(overrides: Partial<MusicTrack> = {}): MusicTrack {
  return {
    id: "track-1",
    title: "Calm Down",
    artist: "Rema",
    albumTitle: null,
    albumId: null,
    thumbnailUrl: null,
    durationSeconds: 190,
    sourceUrl: "https://youtube.com/watch?v=abcdefghijk",
    ...overrides,
  };
}

test("shows the matching artist as soon as a partial name is typed", () => {
  const suggestions = localMusicSuggestions("Davi", [], artistHints);
  assert.deepEqual(suggestions.map(({ kind, title }) => ({ kind, title })), [
    { kind: "artist", title: "Davido" },
  ]);
});

test("matches partial song titles from already loaded catalog results", () => {
  const suggestions = localMusicSuggestions("Calm Do", [track()], artistHints);
  assert.deepEqual(suggestions.map(({ kind, title }) => ({ kind, title })), [
    { kind: "song", title: "Calm Down" },
  ]);
});

test("does not suggest unrelated tracks for an artist prefix", () => {
  const suggestions = localMusicSuggestions("Davi", [track()], artistHints);
  assert.deepEqual(suggestions.map(({ kind, title }) => ({ kind, title })), [
    { kind: "artist", title: "Davido" },
  ]);
});

test("removes duplicate songs after online suggestions arrive", () => {
  const local = localMusicSuggestions("Calm Do", [track()], artistHints);
  const merged = mergeSearchSuggestions(local, [{
    kind: "song",
    id: "another-id",
    title: "Calm Down",
    artist: "Rema",
    albumId: null,
    thumbnailUrl: null,
    sourceUrl: null,
    durationSeconds: null,
  }]);
  assert.deepEqual(merged.map(({ kind, title }) => ({ kind, title })), [
    { kind: "song", title: "Calm Down" },
  ]);
});
