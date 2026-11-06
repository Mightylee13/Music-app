import { type FormEvent, type KeyboardEvent, type ReactNode, type RefObject, useEffect, useMemo, useRef, useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  getGetMusicAlbumQueryKey, getGetMusicLyricsQueryKey, getMusicSuggestions, useGetMusicAlbum, useGetMusicGenres,
  useGetMusicLyrics, useImportSpotifyPlaylist, usePrepareMusicPlayback, useSearchMusic, useStopMusicPlayback,
} from '@workspace/api-client-react';
import type { MusicAlbum, MusicTrack, YoutubeMusicLyricsResponse } from '@workspace/api-client-react';
import Hls from 'hls.js';
import {
  Album, ArrowDown, ArrowLeft, ArrowRight, AudioLines, Bug, CircleAlert, Clock3, Disc3, Headphones,
  Home as HomeIcon, Library, ListMusic, Menu, Music2, Pause, Play, Plus, Search, SkipBack,
  SkipForward, Trash2, Volume2, X, ChevronDown, Shuffle,
} from 'lucide-react';
import { createShuffleCycle, musicTrackKey, nextUnplayedIndex, shuffleQueueFromCurrent, shuffleTracks } from './playlistShuffle';
import { MusicDiagnosticsDialog } from './MusicDiagnosticsDialog';
import MusicAdminPage from './components/admin/MusicAdminPage';
import { HomeCatalog, QUICK_SEARCH_ARTISTS } from './HomeCatalog';
import { localMusicSuggestions, mergeSearchSuggestions, normalizeSuggestionText, type SearchSuggestion } from './searchSuggestions';
import { recordMusicDiagnostic } from './musicDiagnostics';
import { Link, Route, Router as WouterRouter, Switch, useLocation, useParams, useSearch } from 'wouter';
import { ErrorBoundary } from '@/components/error-boundary';
import NotFound from '@/pages/not-found';
import './index.css';

const queryClient = new QueryClient();
const STORAGE = 'lenzo.music.playlists.v1';
const RECENT_SEARCHES_STORAGE = 'lenzo.music.recent-searches.v1';
const MIN_SUGGESTION_QUERY_LENGTH = 2;
const NEXT_TRACK_PRELOAD_LEAD_SECONDS = 20;
const SUGGESTION_DEBOUNCE_MS = 160;
type Playlist = { id: string; name: string; createdAt: number; tracks: MusicTrack[] };
type Now = { track: MusicTrack; queue?: MusicTrack[]; index?: number; originalQueue?: MusicTrack[]; shuffled?: boolean; playedTrackKeys?: string[] };
type MusicStream = { token: string; quality: 'low' | 'medium' | 'high'; hlsUrl: string; audioUrl: string; native?: boolean };
const trackKey = musicTrackKey;
function readRecentSearches(): string[] {
  try {
    if (typeof localStorage === 'undefined') return [];
    const parsed = JSON.parse(localStorage.getItem(RECENT_SEARCHES_STORAGE) || '[]');
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string').slice(0, 8) : [];
  } catch { return []; }
}
const safePlaylists = (): Playlist[] => {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE) || '[]');
    return Array.isArray(value) ? value : [];
  } catch { return []; }
};
function storePlaylists(lists: Playlist[]) {
  localStorage.setItem(STORAGE, JSON.stringify(lists.map(({ id, name, createdAt, tracks }) => ({
    id, name, createdAt, tracks: tracks.map(({ id: trackId, title, artist, albumTitle, albumId, thumbnailUrl, durationSeconds, sourceUrl }) =>
      ({ id: trackId, title, artist, albumTitle, albumId, thumbnailUrl, durationSeconds, sourceUrl })),
  }))));
}
function formatDuration(value?: number | null) {
  return value ? `${Math.floor(value / 60)}:${String(Math.floor(value % 60)).padStart(2, '0')}` : '—';
}
function musicQueryFor(track: MusicTrack) {
  return track.artist && track.artist !== 'Unknown artist' ? `${track.title} by ${track.artist}` : track.title;
}
function musicPlaybackInput(track: MusicTrack, quality: 'low' | 'medium' | 'high') {
  return {
    query: musicQueryFor(track),
    quality,
    title: track.title,
    artist: track.artist,
    ...(track.sourceUrl ? { sourceUrl: track.sourceUrl } : {}),
    ...(track.durationSeconds ? { durationSeconds: track.durationSeconds } : {}),
  };
}
function Cover({ src, title, className = '' }: { src?: string | null; title: string; className?: string }) {
  const shades = ['from-lime-300/30 to-emerald-950', 'from-rose-300/25 to-indigo-950', 'from-amber-200/25 to-slate-900', 'from-cyan-300/25 to-blue-950'];
  const shade = title.split('').reduce((sum, char) => sum + char.charCodeAt(0), 0) % shades.length;
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  useEffect(() => setFailedSrc(null), [src]);
  return <div data-testid={`cover-${title.replace(/\W+/g, '-').toLowerCase()}`} className={`relative overflow-hidden bg-gradient-to-br ${shades[shade]} ${className}`}>
    {src && failedSrc !== src
      ? <img src={src} alt={`${title} cover`} loading="lazy" onError={() => setFailedSrc(src)} className="h-full w-full object-cover" />
      : <div className="absolute inset-0 grid place-items-center"><Disc3 className="h-1/3 w-1/3 text-white/30" strokeWidth={1} /></div>}
  </div>;
}
function IconButton({ label, onClick, children, disabled = false, className = '' }: { label: string; onClick: () => void; children: ReactNode; disabled?: boolean; className?: string }) {
  return <button type="button" data-testid={`button-${label}`} aria-label={label} onClick={onClick} disabled={disabled} className={`grid place-items-center transition hover:text-lime-300 disabled:cursor-not-allowed disabled:opacity-35 ${className}`}>{children}</button>;
}
function App() {
  const [lists, setLists] = useState<Playlist[]>([]);
  const [now, setNow] = useState<Now | null>(null);
  const [stream, setStream] = useState<MusicStream | null>(null);
  const [playing, setPlaying] = useState(false);
  const [error, setError] = useState('');
  const [playbackStatus, setPlaybackStatus] = useState('');
  const [quality, setQuality] = useState<'low' | 'medium' | 'high'>('low');
  const [lyricsOpen, setLyricsOpen] = useState(false);
  const [awaitingPrepared, setAwaitingPrepared] = useState(false);
  const [volume, setVolume] = useState(.76);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const audioRef = useRef<HTMLAudioElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const playRequestRef = useRef(0);
  const fallbackAttemptedRef = useRef(false);
  const preloadRef = useRef<{ key: string; promise: Promise<MusicStream> } | null>(null);
  const prepare = usePrepareMusicPlayback();
  const prefetchPrepare = usePrepareMusicPlayback();
  const stop = useStopMusicPlayback();
  const spotifyPlaylistImport = useImportSpotifyPlaylist();
  const [path, setLocation] = useLocation();
  useEffect(() => {
    const onError = (event: ErrorEvent) => {
      recordMusicDiagnostic('error', 'App', event.message || 'A browser error occurred.');
    };
    const onUnhandledRejection = (event: PromiseRejectionEvent) => {
      const reason = event.reason;
      recordMusicDiagnostic('error', 'App', reason instanceof Error ? reason.message : String(reason || 'An unhandled request failed.'));
    };
    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onUnhandledRejection);
    return () => {
      window.removeEventListener('error', onError);
      window.removeEventListener('unhandledrejection', onUnhandledRejection);
    };
  }, []);
  useEffect(() => {
    setLists(safePlaylists());
    const refresh = () => setLists(safePlaylists());
    window.addEventListener('storage', refresh);
    return () => window.removeEventListener('storage', refresh);
  }, []);
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const root = document.documentElement;
    const updateKeyboardInset = () => {
      const inset = Math.max(0, root.clientHeight - viewport.height - viewport.offsetTop);
      root.style.setProperty('--music-keyboard-inset', `${inset > 120 ? inset : 0}px`);
    };
    updateKeyboardInset();
    viewport.addEventListener('resize', updateKeyboardInset);
    viewport.addEventListener('scroll', updateKeyboardInset);
    window.addEventListener('resize', updateKeyboardInset);
    return () => {
      viewport.removeEventListener('resize', updateKeyboardInset);
      viewport.removeEventListener('scroll', updateKeyboardInset);
      window.removeEventListener('resize', updateKeyboardInset);
      root.style.removeProperty('--music-keyboard-inset');
    };
  }, []);
  useEffect(() => () => {
    const pending = preloadRef.current;
    if (pending) void pending.promise.then((prepared) => stop.mutate({ params: { token: prepared.token, quality: prepared.quality } })).catch(() => undefined);
  }, []);
  const persist = (next: Playlist[]) => { setLists(next); storePlaylists(next); };
  const importSpotifyPlaylist = async (url: string) => {
    const imported = await spotifyPlaylistImport.mutateAsync({ data: { url } });
    const tracks: MusicTrack[] = imported.tracks.map((track, index) => ({
      id: `spotify:${track.uri || imported.playlistId}:${index}`,
      title: track.title,
      artist: track.artist,
      albumTitle: track.album,
      albumId: null,
      thumbnailUrl: track.thumbnailUrl,
      durationSeconds: track.durationMs == null ? null : Math.round(track.durationMs / 1000),
      // Imported Spotify URLs identify songs only; Lenzo resolves playback using its existing music sources.
      sourceUrl: null,
    }));
    const currentLists = safePlaylists();
    const id = `spotify-${imported.playlistId}`;
    const existing = currentLists.find((playlist) => playlist.id === id);
    const playlist: Playlist = {
      id,
      name: imported.name,
      createdAt: existing?.createdAt ?? Date.now(),
      tracks,
    };
    persist([playlist, ...currentLists.filter((item) => item.id !== id)]);
    return {
      playlistId: id,
      playlistName: playlist.name,
      trackCount: tracks.length,
      updated: !!existing,
    };
  };
  const createPlaylist = () => {
    const name = window.prompt('Name your playlist');
    if (!name?.trim()) return;
    const list = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, name: name.trim(), createdAt: Date.now(), tracks: [] };
    persist([list, ...lists]); setLocation(`/playlists/${list.id}`);
  };
  const saveTrack = (track: MusicTrack) => {
    if (!lists.length) {
      const name = window.prompt('Create a playlist for this song');
      if (name?.trim()) persist([{ id: `${Date.now()}`, name: name.trim(), createdAt: Date.now(), tracks: [track] }, ...lists]);
      return;
    }
    const response = window.prompt(`Add to which playlist?\n${lists.map((p, i) => `${i + 1}. ${p.name}`).join('\n')}\n\nEnter a playlist number.`);
    const i = Number(response) - 1;
    if (i < 0 || i >= lists.length) return;
    persist(lists.map((p, n) => n === i && !p.tracks.some((t) => t.id === track.id) ? { ...p, tracks: [...p.tracks, track] } : p));
  };
  useEffect(() => {
    const saveCurrent = () => { if (now?.track) saveTrack(now.track); };
    window.addEventListener('lenzo-save-current', saveCurrent);
    return () => window.removeEventListener('lenzo-save-current', saveCurrent);
  }, [now, lists]);
  const stopStream = (active: MusicStream | null) => {
    if (active) stop.mutate({ params: { token: active.token, quality: active.quality } });
  };
  const discardPreload = (exceptKey?: string) => {
    const pending = preloadRef.current;
    if (!pending || pending.key === exceptKey) return;
    preloadRef.current = null;
    void pending.promise.then((prepared) => stopStream(prepared)).catch(() => undefined);
  };
  const teardown = () => {
    if (stream) stop.mutate({ params: { token: stream.token, quality: stream.quality } });
    hlsRef.current?.destroy(); hlsRef.current = null;
    if (audioRef.current) { audioRef.current.pause(); audioRef.current.removeAttribute('src'); audioRef.current.load(); }
  };
  const preloadTrack = (track: MusicTrack) => {
    const key = `${quality}:${track.id}`;
    if (preloadRef.current?.key === key) return;
    discardPreload();
    recordMusicDiagnostic('info', 'Next track preload', 'Preloading the next track before the current song ends.', {
      title: track.title,
      artist: track.artist,
      quality,
    });
    const promise = prefetchPrepare.mutateAsync({ data: musicPlaybackInput(track, quality) }).then((prepared) => {
      recordMusicDiagnostic('info', 'Next track preload', 'Next track is ready and will be reused when playback advances.', {
        title: track.title,
        artist: track.artist,
        quality,
      });
      return prepared;
    }).catch((error: unknown) => {
      recordMusicDiagnostic('warning', 'Next track preload', error instanceof Error ? error.message : 'Next track preload failed.', {
        title: track.title,
        artist: track.artist,
        quality,
      });
      throw error;
    });
    preloadRef.current = { key, promise };
    void promise.catch(() => { if (preloadRef.current?.key === key) preloadRef.current = null; });
  };
  const playTrack = async (
    track: MusicTrack,
    queue?: MusicTrack[],
    index?: number,
    options?: { shuffled?: boolean; originalQueue?: MusicTrack[]; playedTrackKeys?: string[] },
  ) => {
    const requestId = ++playRequestRef.current;
    recordMusicDiagnostic('info', 'Playback', 'Track selected for playback.', {
      title: track.title,
      artist: track.artist,
      quality,
      queueLength: queue?.length ?? 1,
    });
    const key = `${quality}:${track.id}`;
    const prepared = preloadRef.current?.key === key ? preloadRef.current.promise : null;
    discardPreload(key);
    setError(''); setPlaybackStatus(prepared ? 'Starting the prepared track…' : 'Preparing the song stream…'); setPlaying(false); setAwaitingPrepared(false); fallbackAttemptedRef.current = false; teardown(); setStream(null);
    const sameQueue = Boolean(now?.queue && now.queue === queue);
    const sameShuffledQueue = Boolean(now?.shuffled && sameQueue);
    const originalQueue = options?.originalQueue ?? (sameShuffledQueue ? now?.originalQueue : queue);
    const shuffled = options?.shuffled ?? sameShuffledQueue;
    const priorPlayed = sameQueue && now
      ? (now.playedTrackKeys ?? [trackKey(now.track)])
      : [];
    const playedTrackKeys = options?.playedTrackKeys ?? [...new Set([...priorPlayed, trackKey(track)])];
    setNow({ track, queue, index, originalQueue, shuffled, playedTrackKeys });
    const audio = audioRef.current;
    const musicQuery = musicQueryFor(track);
    const nativeHlsSupported = Boolean(
      audio?.canPlayType('application/vnd.apple.mpegurl')
      || audio?.canPlayType('application/x-mpegURL'),
    );
    if (audio && nativeHlsSupported) {
      if (prepared) {
        setAwaitingPrepared(true);
        try {
          const fresh = await prepared;
          if (requestId !== playRequestRef.current) {
            return;
          }
          if (preloadRef.current?.key === key) preloadRef.current = null;
          setAwaitingPrepared(false);
          const nativeStream = { ...fresh, native: true };
          setStream(nativeStream);
          setPlaybackStatus('Starting the prepared track…');
          recordMusicDiagnostic('info', 'Playback preparation', 'Prepared track is ready for native playback.', { title: track.title, artist: track.artist, quality });
          audio.src = fresh.hlsUrl;
          audio.load();
          void audio.play().catch(() => {
            if (requestId !== playRequestRef.current) return;
            setPlaying(false);
            setPlaybackStatus('The prepared track is ready. Tap Play below to start it.');
            setError('Automatic playback was blocked. Tap Play below after preparation finishes.');
            recordMusicDiagnostic('warning', 'Playback control', 'Browser blocked automatic playback after preparation.', { title: track.title, artist: track.artist });
          });
        } catch (e) {
          if (requestId !== playRequestRef.current) return;
          setAwaitingPrepared(false);
          setStream(null);
          setPlaybackStatus('');
          const message = e instanceof Error ? e.message : 'Could not start the prepared track. Try again.';
          setError(message);
          recordMusicDiagnostic('error', 'Playback preparation', message, { title: track.title, artist: track.artist, quality });
        }
        return;
      }
      try {
        recordMusicDiagnostic('info', 'Playback preparation', 'Trying the selected YouTube result first, then the uploaded scraper. Playback uses the scraper only.', { title: track.title, artist: track.artist, quality });
        const fresh = await prepare.mutateAsync({ data: musicPlaybackInput(track, quality) });
        if (requestId !== playRequestRef.current) {
          stopStream(fresh);
          return;
        }
        if (preloadRef.current?.key === key) preloadRef.current = null;
        setStream({ ...fresh, native: true });
        setPlaybackStatus('Starting the prepared song stream…');
        audio.src = fresh.hlsUrl;
        audio.load();
        void audio.play().catch(() => {
          if (requestId !== playRequestRef.current) return;
          setPlaying(false);
          setPlaybackStatus('The prepared track is ready. Tap Play below to start it.');
          setError('Automatic playback was blocked. Tap Play below to start the prepared stream.');
          recordMusicDiagnostic('warning', 'Playback control', 'Browser blocked automatic playback after the song stream was prepared.', { title: track.title, artist: track.artist });
        });
      } catch (e) {
        if (requestId !== playRequestRef.current) return;
        setStream(null);
        setPlaybackStatus('');
        const message = e instanceof Error ? e.message : 'Could not prepare the song stream.';
        setError(message);
        recordMusicDiagnostic('error', 'Playback preparation', message, { title: track.title, artist: track.artist, quality });
      }
      return;
    }
    try {
      let fresh: MusicStream;
      if (prepared) {
        setAwaitingPrepared(true);
        try { fresh = await prepared; }
        catch {
          if (requestId !== playRequestRef.current) return;
          fresh = await prepare.mutateAsync({ data: musicPlaybackInput(track, quality) });
        } finally {
          if (requestId === playRequestRef.current) setAwaitingPrepared(false);
        }
      } else fresh = await prepare.mutateAsync({ data: musicPlaybackInput(track, quality) });
      if (requestId !== playRequestRef.current) {
        if (!prepared) stopStream(fresh);
        return;
      }
      if (preloadRef.current?.key === key) preloadRef.current = null;
      setStream(fresh);
    } catch (e) {
      if (requestId !== playRequestRef.current) return;
      const message = e instanceof Error ? e.message : 'Could not start this stream. Try again.';
      setStream(null); setPlaybackStatus(''); setError(message);
      recordMusicDiagnostic('error', 'Playback preparation', message, { title: track.title, artist: track.artist, quality });
    }
  };
  const fallbackToFullTrack = (activeStream: typeof stream) => {
    const audio = audioRef.current;
    if (!activeStream || !audio) return;
    if (fallbackAttemptedRef.current) return;
    fallbackAttemptedRef.current = true;
    recordMusicDiagnostic('warning', 'Playback fallback', 'Live HLS stream failed; switched to full-track fallback.', {
      title: now?.track.title,
      artist: now?.track.artist,
      mediaErrorCode: audio.error?.code ?? null,
      readyState: audio.readyState,
      networkState: audio.networkState,
    });
    hlsRef.current?.destroy(); hlsRef.current = null;
    setError('');
    setPlaybackStatus('Live streaming failed; trying full-track playback…');
    audio.pause();
    audio.src = activeStream.audioUrl;
    audio.load();
    void audio.play().catch((error: unknown) => {
      setPlaying(false);
      setPlaybackStatus('The track is ready. Tap the green Play button below to start it.');
      setError('Your browser blocked automatic playback after loading the song. Tap Play below.');
      recordMusicDiagnostic('warning', 'Playback control', error instanceof Error ? error.message : 'Browser blocked full-track fallback playback.', {
        title: now?.track.title,
        artist: now?.track.artist,
      });
    });
  };
  const handleAudioError = () => {
    if (!stream) return;
    const audio = audioRef.current;
    recordMusicDiagnostic('error', 'Audio element', 'Browser reported an audio playback error.', {
      title: now?.track.title,
      artist: now?.track.artist,
      mediaErrorCode: audio?.error?.code ?? null,
      readyState: audio?.readyState ?? null,
      networkState: audio?.networkState ?? null,
      currentTime: audio?.currentTime ?? null,
    });
    if (!fallbackAttemptedRef.current) fallbackToFullTrack(stream);
    else {
      setPlaybackStatus('');
      setPlaying(false);
      setError('The full-track fallback failed too. No audio was played.');
      recordMusicDiagnostic('error', 'Playback fallback', 'Full-track fallback failed after the live stream error.', {
        title: now?.track.title,
        artist: now?.track.artist,
        mediaErrorCode: audio?.error?.code ?? null,
      });
    }
  };
  useEffect(() => {
    if (!stream || !audioRef.current) return;
    if (stream.native) return;
    const audio = audioRef.current;
    if (Hls.isSupported()) {
      const hls = new Hls({ autoStartLoad: false, backBufferLength: 20, maxBufferLength: 24 });
      hlsRef.current = hls;
      hls.on(Hls.Events.MEDIA_ATTACHED, () => hls.loadSource(stream.hlsUrl));
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        hls.startLoad(0);
        void audio.play().catch((error: unknown) => {
          setPlaybackStatus('The verified track is ready. Tap Play below to start it.');
          setError('Tap Play below to start audio playback.');
          recordMusicDiagnostic('warning', 'Playback control', error instanceof Error ? error.message : 'Browser blocked HLS playback.', {
            title: now?.track.title,
            artist: now?.track.artist,
          });
        });
      });
      hls.on(Hls.Events.ERROR, (_event, info) => {
        if (info.fatal) {
          recordMusicDiagnostic('error', 'HLS stream', 'Fatal HLS playback error.', {
            title: now?.track.title,
            artist: now?.track.artist,
            type: info.type,
            details: info.details,
            fatal: info.fatal,
          });
          fallbackToFullTrack(stream);
        }
      });
      hls.attachMedia(audio);
    } else if (audio.canPlayType('application/vnd.apple.mpegurl')) {
      audio.src = stream.hlsUrl; audio.load();
      void audio.play().catch((error: unknown) => {
        setPlaybackStatus('The verified track is ready. Tap Play below to start it.');
        setError('Tap Play below to start audio playback.');
        recordMusicDiagnostic('warning', 'Playback control', error instanceof Error ? error.message : 'Browser blocked native HLS playback.', {
          title: now?.track.title,
          artist: now?.track.artist,
        });
      });
    } else {
      fallbackToFullTrack(stream);
    }
    return () => { hlsRef.current?.destroy(); hlsRef.current = null; };
  }, [stream]);
  useEffect(() => { if (audioRef.current) audioRef.current.volume = volume; }, [volume]);
  const togglePlay = () => {
    if (!audioRef.current) return;
    if (audioRef.current.paused) void audioRef.current.play().then(() => { setPlaying(true); setError(''); }).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : 'Playback was blocked.';
      setError('Playback was blocked. Press play to try again.');
      recordMusicDiagnostic('error', 'Playback control', message, { title: now?.track.title, artist: now?.track.artist });
    });
    else { audioRef.current.pause(); setPlaying(false); }
  };
  const skip = (delta: -1 | 1) => {
    if (!now?.queue?.length || now.index === undefined) return;
    if (now.shuffled && delta > 0) {
      const queue = now.queue;
      const played = new Set(now.playedTrackKeys ?? [trackKey(now.track)]);
      const nextIndex = nextUnplayedIndex(queue, [...played]);
      if (nextIndex >= 0) {
        const nextTrack = queue[nextIndex];
        void playTrack(nextTrack, queue, nextIndex, {
          shuffled: true,
          originalQueue: now.originalQueue,
          playedTrackKeys: [...played, trackKey(nextTrack)],
        });
        return;
      }
      const originalQueue = now.originalQueue ?? queue;
      const nextCycle = createShuffleCycle(originalQueue, now.track);
      const firstTrack = nextCycle[0];
      if (firstTrack) void playTrack(firstTrack, nextCycle, 0, {
        shuffled: true,
        originalQueue,
        playedTrackKeys: [trackKey(firstTrack)],
      });
      return;
    }
    if (now.shuffled && delta < 0) {
      const history = now.playedTrackKeys ?? [trackKey(now.track)];
      const currentHistoryIndex = history.lastIndexOf(trackKey(now.track));
      const previousKey = history[currentHistoryIndex - 1];
      const previousIndex = previousKey ? now.queue.findIndex((track) => trackKey(track) === previousKey) : -1;
      if (previousIndex >= 0) {
        void playTrack(now.queue[previousIndex], now.queue, previousIndex, {
          shuffled: true,
          originalQueue: now.originalQueue,
          playedTrackKeys: history,
        });
      }
      return;
    }
    const next = (now.index + delta + now.queue.length) % now.queue.length;
    void playTrack(now.queue[next], now.queue, next);
  };
  const toggleShuffle = () => {
    if (!now?.queue?.length || now.index === undefined) return;
    if (now.shuffled) {
      const queue = now.originalQueue ?? now.queue;
      const restoredIndex = queue.findIndex((track) => track.id === now.track.id);
      discardPreload();
      const index = restoredIndex >= 0 ? restoredIndex : 0;
      const availableKeys = new Set(queue.map(trackKey));
      const playedTrackKeys = [...new Set((now.playedTrackKeys ?? [trackKey(now.track)]).filter((key) => availableKeys.has(key)))];
      if (!playedTrackKeys.includes(trackKey(now.track))) playedTrackKeys.push(trackKey(now.track));
      setNow({ ...now, track: now.track, queue, index, originalQueue: queue, shuffled: false, playedTrackKeys });
      return;
    }
    const queue = now.queue;
    const playedTrackKeys = now.playedTrackKeys ?? [trackKey(now.track)];
    const { queue: shuffledQueue, index: currentIndex } = shuffleQueueFromCurrent(queue, now.track, playedTrackKeys);
    discardPreload();
    setNow({ ...now, queue: shuffledQueue, index: currentIndex, originalQueue: now.originalQueue ?? queue, shuffled: true, playedTrackKeys });
  };
  const shufflePlaylist = (tracks: MusicTrack[]) => {
    if (tracks.length < 2) return;
    const originalQueue = [...tracks];
    const shuffledQueue = shuffleTracks(tracks);
    const firstTrack = shuffledQueue[0];
    if (firstTrack) void playTrack(firstTrack, shuffledQueue, 0, { shuffled: true, originalQueue, playedTrackKeys: [trackKey(firstTrack)] });
  };
  const navSection = path === '/' ? 'discover' : path.split('/')[1];
  return <div className="min-h-[100dvh] bg-[#101114] text-[#eeeae0]">
    <div className="flex min-h-[100dvh]">
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-[248px] flex-col border-r border-white/[.065] bg-[#0c0d0f] px-5 pb-28 pt-7 md:flex">
        <Link href="/" data-testid="link-lenzo-home" className="mb-10 flex items-center gap-3 px-2"><span className="grid h-9 w-9 place-items-center rounded-xl bg-[#d2f36b] text-[#171912]"><AudioLines size={21} strokeWidth={2.8} /></span><span className="font-display text-[23px] font-bold tracking-[-1.5px]">lenzo<span className="text-lime-300">.</span></span></Link>
        <div className="space-y-1"><Nav href="/" current={navSection === 'discover'} icon={<HomeIcon size={19} />} label="Discover" /><Nav href="/search" current={navSection === 'search'} icon={<Search size={19} />} label="Search" /><Nav href="/library" current={navSection === 'library' || navSection === 'playlists'} icon={<Library size={19} />} label="Your library" /></div>
        <div className="mt-10 flex items-center justify-between px-2"><span className="font-mono-ui text-[10px] uppercase tracking-[.2em] text-[#777a78]">Your playlists</span><IconButton label="create-playlist" onClick={createPlaylist} className="h-8 w-8 rounded-lg text-[#92948e] hover:bg-white/[.06]"><Plus size={17} /></IconButton></div>
        <div className="mt-3 space-y-1 overflow-y-auto">
          {lists.map((list) => <Link href={`/playlists/${list.id}`} key={list.id} data-testid={`link-playlist-${list.id}`} className={`flex items-center gap-3 rounded-lg px-2 py-2.5 text-[13px] transition hover:bg-white/[.045] ${path === `/playlists/${list.id}` ? 'text-lime-300' : 'text-[#9c9e99]'}`}><ListMusic size={16} /><span className="truncate">{list.name}</span><span className="ml-auto text-[10px] text-[#656762]">{list.tracks.length}</span></Link>)}
          {!lists.length && <p className="px-2 py-2 text-xs leading-relaxed text-[#62645f]">Make a place for the songs that stay with you.</p>}
        </div>
        <div className="mt-auto border-t border-white/[.07] pt-5"><div className="flex items-center gap-3 px-2"><span className="grid h-9 w-9 place-items-center rounded-full border border-white/10 bg-[#191b1e] text-[#cbd4a3]"><Headphones size={16} /></span><div><p className="text-xs font-semibold">Personal listening</p><p className="mt-0.5 text-[10px] text-[#747771]">Your own music space</p></div></div></div>
      </aside>
      <main className="music-main min-w-0 flex-1 pb-[170px] md:ml-[248px] md:pb-[105px]">
        <header className={`${path === '/search' ? 'hidden md:flex' : 'flex'} sticky top-0 z-20 h-[72px] items-center justify-between border-b border-white/[.055] bg-[#101114]/90 px-5 backdrop-blur-xl sm:px-9`}>
          <div className="flex items-center gap-3"><button aria-label="Open navigation" data-testid="button-mobile-menu" className="grid h-9 w-9 place-items-center rounded-lg text-white/70 hover:bg-white/5 md:hidden" onClick={() => setMobileOpen(!mobileOpen)}><Menu size={19} /></button>
            <div className="hidden gap-2 md:flex"><IconButton label="back" onClick={() => window.history.back()} className="h-8 w-8 rounded-full bg-white/[.06] text-white/70"><ArrowLeft className="rotate-180" size={16} /></IconButton><IconButton label="forward" onClick={() => window.history.forward()} className="h-8 w-8 rounded-full bg-white/[.06] text-white/70"><ArrowRight size={16} /></IconButton></div>
          </div><div className="flex items-center gap-3"><span className="hidden font-mono-ui text-[10px] uppercase tracking-[.18em] text-[#686b65] sm:block">A quieter kind of listening</span><button type="button" data-testid="button-open-diagnostics" onClick={() => setDiagnosticsOpen(true)} aria-label="Open music diagnostics" title="Music diagnostics" className="grid h-9 w-9 place-items-center rounded-full text-white/55 hover:bg-white/10 hover:text-lime-200"><Bug size={17} /></button><span className="h-1 w-1 rounded-full bg-lime-300" /><span className="font-mono-ui text-[10px] text-[#93958f]">LENZO / 01</span></div>
        </header>
        {mobileOpen && <div className="fixed inset-0 z-40 bg-black/65 md:hidden" onClick={() => setMobileOpen(false)}><div className="h-full w-[280px] bg-[#0c0d0f] p-5" onClick={(e) => e.stopPropagation()}><div className="mb-8 flex justify-between"><span className="font-display text-xl font-bold">lenzo.</span><IconButton label="close-menu" onClick={() => setMobileOpen(false)}><X size={20} /></IconButton></div><Nav href="/" current={navSection === 'discover'} icon={<HomeIcon size={19} />} label="Discover" onClick={() => setMobileOpen(false)} /><Nav href="/search" current={navSection === 'search'} icon={<Search size={19} />} label="Search" onClick={() => setMobileOpen(false)} /><Nav href="/library" current={navSection === 'library' || navSection === 'playlists'} icon={<Library size={19} />} label="Your library" onClick={() => setMobileOpen(false)} /><button onClick={() => { createPlaylist(); setMobileOpen(false); }} className="mt-6 flex items-center gap-3 px-3 py-2 text-sm text-white/60"><Plus size={17} /> New playlist</button></div></div>}
        <ErrorBoundary resetKey={path}><Switch>
          <Route path="/"><Discover onPlay={playTrack} onSave={saveTrack} /></Route>
          <Route path="/search"><SearchPage lists={lists} onPlay={playTrack} onSave={saveTrack} onOpenDiagnostics={() => setDiagnosticsOpen(true)} /></Route>
          <Route path="/albums/:id"><AlbumPage onPlay={playTrack} onSave={saveTrack} /></Route>
          <Route path="/library"><LibraryPage lists={lists} create={createPlaylist} onImportSpotifyPlaylist={importSpotifyPlaylist} /></Route>
          <Route path="/playlists/:id"><PlaylistPage lists={lists} update={persist} onPlay={playTrack} onShuffle={shufflePlaylist} /></Route>
          <Route component={NotFound} />
        </Switch></ErrorBoundary>
      </main>
    </div>
    <nav aria-label="Main navigation" data-testid="nav-mobile-tabs" className="mobile-tabs fixed inset-x-0 bottom-0 z-30 grid h-[68px] grid-cols-4 border-t border-white/[.08] bg-[#111214]/95 px-2 pt-2 backdrop-blur-xl md:hidden">
      <MobileTab href="/" current={navSection === 'discover'} icon={<HomeIcon size={18} />} label="Home" />
      <MobileTab href="/search" current={navSection === 'search'} icon={<Search size={18} />} label="Search" />
      <MobileTab href="/library" current={navSection === 'library' || navSection === 'playlists'} icon={<Library size={18} />} label="Your library" />
      <button type="button" data-testid="button-mobile-create-playlist" onClick={createPlaylist} className="flex flex-col items-center gap-1 text-[9px] font-semibold text-[#8d9088] hover:text-lime-300"><Plus size={18} /><span>Create</span></button>
    </nav>
    <Player current={now} stream={stream} playing={playing} setPlaying={setPlaying} setError={setError} status={playbackStatus} setStatus={setPlaybackStatus} onAudioError={handleAudioError} audioRef={audioRef} volume={volume} setVolume={setVolume} toggle={togglePlay} skip={skip} playQueueTrack={playTrack} onPreload={preloadTrack} onShuffle={toggleShuffle} lyricsOpen={lyricsOpen} setLyricsOpen={setLyricsOpen} error={error} busy={prepare.isPending || awaitingPrepared} quality={quality} setQuality={setQuality} />
    <MusicDiagnosticsDialog open={diagnosticsOpen} onClose={() => setDiagnosticsOpen(false)} />
  </div>;
}
function MobileTab({ href, current, icon, label }: { href: string; current: boolean; icon: ReactNode; label: string }) {
  return <Link href={href} data-testid={`tab-${label.toLowerCase().replaceAll(' ', '-')}`} aria-current={current ? 'page' : undefined} className={`flex flex-col items-center gap-1 text-[9px] font-semibold transition ${current ? 'text-lime-300' : 'text-[#8d9088] hover:text-white'}`}>{icon}<span>{label}</span></Link>;
}
function Nav({ href, current, icon, label, onClick }: { href: string; current: boolean; icon: ReactNode; label: string; onClick?: () => void }) {
  return <Link href={href} onClick={onClick} data-testid={`nav-${label.toLowerCase().replaceAll(' ', '-')}`} className={`relative flex items-center gap-3 rounded-xl px-3 py-3 text-[13px] font-semibold transition ${current ? 'bg-[#d2f36b]/10 text-[#d2f36b]' : 'text-[#8f918c] hover:bg-white/[.045] hover:text-[#e8e6dc]'}`}>{icon}<span>{label}</span>{current && <span className="absolute bottom-2 left-0 top-2 w-[2px] rounded-r bg-lime-300" />}</Link>;
}
function Heading({ kicker, title, action }: { kicker?: string; title: string; action?: ReactNode }) {
  return <div className="mb-5 flex items-end justify-between gap-3"><div>{kicker && <p className="mb-2 font-mono-ui text-[9px] uppercase tracking-[.23em] text-[#777b70]">{kicker}</p>}<h2 className="font-display text-[23px] font-semibold tracking-[-.8px] sm:text-[27px]">{title}</h2></div>{action}</div>;
}
function Empty({ icon, title, text, action }: { icon: ReactNode; title: string; text: string; action?: ReactNode }) {
  return <div className="grid min-h-[245px] place-items-center rounded-3xl border border-dashed border-white/10 bg-white/[.015] px-5 text-center"><div><span className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-white/[.045] text-[#b5c18c]">{icon}</span><h2 className="mt-5 font-display text-xl font-semibold">{title}</h2><p className="mx-auto mt-2 max-w-[320px] text-xs leading-5 text-[#83867f]">{text}</p>{action}</div></div>;
}
function Failure({ message, retry }: { message: string; retry: () => void }) {
  return <div className="flex items-center justify-between gap-4 rounded-2xl border border-red-200/10 bg-red-300/[.035] px-5 py-4"><p className="flex items-center gap-2 text-xs text-[#d69b96]"><CircleAlert size={15} />{message}</p><button onClick={retry} className="shrink-0 text-xs font-bold text-lime-300" data-testid="button-retry">Try again</button></div>;
}
function LoadingRows() {
  return <div className="space-y-2">{[0,1,2,3].map((i) => <div key={i} className="flex items-center gap-3 rounded-xl px-3 py-2"><div className="skeleton h-8 w-8 rounded" /><div className="skeleton h-11 w-11 rounded-md" /><div className="flex-1 space-y-2"><div className="skeleton h-3 w-2/5 rounded" /><div className="skeleton h-2 w-1/4 rounded" /></div></div>)}</div>;
}
function TrackRow({ track, onPlay, onSave, index, queue }: { track: MusicTrack; onPlay: (t: MusicTrack, q?: MusicTrack[], i?: number) => void; onSave: (t: MusicTrack) => void; index: number; queue: MusicTrack[] }) {
  return <div data-testid={`row-track-${track.id}`} className="group grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-xl px-3 py-2.5 transition hover:bg-white/[.045]">
    <button data-testid={`button-play-track-${track.id}`} aria-label={`Play ${track.title} by ${track.artist}`} onClick={() => onPlay(track, queue, index)} className="grid min-w-0 grid-cols-[30px_minmax(0,1fr)] items-center gap-3 text-left sm:grid-cols-[36px_minmax(0,1fr)_minmax(90px,.7fr)_52px]">
      <span className="grid h-8 w-8 place-items-center text-[#858780] group-hover:text-lime-300"><span className="group-hover:hidden">{String(index + 1).padStart(2, '0')}</span><Play className="hidden fill-current group-hover:block" size={15} /></span>
      <span className="flex min-w-0 items-center gap-3"><Cover src={track.thumbnailUrl} title={track.title} className="h-10 w-10 shrink-0 rounded-md" /><span className="min-w-0"><span className="block truncate text-[13px] font-semibold text-[#e7e5db]">{track.title}</span><span className="mt-1 block truncate text-[11px] text-[#858780]">{track.artist}</span></span></span>
      <span className="hidden truncate text-left text-xs text-[#888a83] sm:block">{track.albumTitle || 'Single'}</span>
      <span className="hidden text-right font-mono-ui text-[10px] text-[#777a73] sm:block">{formatDuration(track.durationSeconds)}</span>
    </button>
    <div className="flex justify-end sm:opacity-0 sm:group-hover:opacity-100"><IconButton label={`save-track-${track.id}`} onClick={() => onSave(track)} className="h-8 w-8 rounded-full text-[#858780] hover:bg-white/10"><Plus size={15} /></IconButton></div>
  </div>;
}
function AlbumCard({ album }: { album: MusicAlbum }) {
  return <Link href={`/albums/${album.id}?title=${encodeURIComponent(album.title)}&artist=${encodeURIComponent(album.artist)}`} data-testid={`card-album-${album.id}`} className="group min-w-0 rounded-2xl p-2 transition hover:bg-white/[.045]">
    <div className="relative mb-3 aspect-square overflow-hidden rounded-xl shadow-lg shadow-black/20"><Cover src={album.thumbnailUrl} title={album.title} className="h-full w-full transition duration-500 group-hover:scale-[1.035]" /><span className="absolute bottom-3 right-3 grid h-10 w-10 translate-y-2 place-items-center rounded-full bg-[#d2f36b] text-[#171912] opacity-0 shadow-xl transition group-hover:translate-y-0 group-hover:opacity-100"><Play size={17} fill="currentColor" /></span></div>
    <p className="truncate text-[13px] font-bold">{album.title}</p><p className="mt-1 truncate text-[11px] text-[#858780]">{album.artist}</p>
  </Link>;
}
function Discover({ onPlay, onSave }: { onPlay: (t: MusicTrack, q?: MusicTrack[], i?: number) => void; onSave: (t: MusicTrack) => void }) {
  const genresQuery = useGetMusicGenres();
  const search = useSearchMusic();
  const [tracks, setTracks] = useState<MusicTrack[]>([]);
  const [activeShelf, setActiveShelf] = useState('');
  const [failure, setFailure] = useState('');
  const genres = genresQuery.data?.genres ?? [];
  const selectShelf = async (query: string, id: string) => {
    setActiveShelf(id); setFailure('');
    try { const result = await search.mutateAsync({ data: { query, kind: 'songs', region: 'NG' } }); setTracks(result.songs); }
    catch (e) { setTracks([]); setFailure(e instanceof Error ? e.message : 'Genre search failed. Try again.'); }
  };
  return <div className="page-enter mx-auto max-w-[1500px] px-5 py-7 sm:px-9 sm:py-10">
    <section className="relative mb-12 overflow-hidden rounded-[28px] border border-white/[.07] bg-[#191b1d] px-6 py-8 sm:px-11 sm:py-10 lg:min-h-[340px]">
      <div className="absolute -right-12 -top-28 h-[390px] w-[390px] rounded-full border border-[#d2f36b]/10 sm:right-[4%] sm:top-[-95px]"><div className="absolute inset-[28px] rounded-full border border-[#d2f36b]/[.08]" /><div className="absolute inset-[60px] rounded-full border border-[#d2f36b]/[.08]" /><div className="absolute inset-[90px] rounded-full bg-[radial-gradient(circle,rgba(210,243,107,.14),transparent_70%)]" /><div className="absolute right-[18%] top-[24%] h-3 w-3 rounded-full bg-[#d2f36b] shadow-[0_0_30px_#d2f36b]" /></div>
      <div className="relative z-10 max-w-[560px]"><div className="mb-5 inline-flex items-center gap-2 rounded-full border border-lime-200/15 bg-lime-200/[.07] px-3 py-1.5 font-mono-ui text-[9px] uppercase tracking-[.18em] text-[#c7e97b]"><span className="h-1.5 w-1.5 rounded-full bg-lime-300" /> Your listening room</div>
        <h1 className="font-display text-[clamp(42px,7vw,76px)] font-semibold leading-[.98] tracking-[-4px]">Find your<br /><span className="text-[#d2f36b]">next feeling.</span></h1>
        <p className="mt-5 max-w-[360px] text-sm leading-6 text-[#a2a49e]">A little room to wander. Follow a sound, land somewhere new, stay as long as you like.</p>
        <Link href="/search" className="mt-7 inline-flex h-11 items-center gap-2 rounded-full bg-[#d2f36b] px-5 text-xs font-extrabold text-[#171912] transition hover:bg-[#e1ff8b]" data-testid="link-start-search"><Search size={15} /> Start exploring</Link>
      </div>
      {tracks[0] && <div className="relative z-10 mt-8 flex max-w-[440px] items-center gap-3 rounded-2xl border border-white/10 bg-black/20 p-3 lg:absolute lg:bottom-8 lg:right-8 lg:mt-0"><Cover src={tracks[0].thumbnailUrl} title={tracks[0].title} className="h-12 w-12 rounded-lg" /><div className="min-w-0 flex-1"><p className="font-mono-ui text-[9px] uppercase tracking-[.16em] text-lime-300">From this shelf</p><p className="mt-1 truncate text-xs font-semibold">{tracks[0].title} · {tracks[0].artist}</p></div><IconButton label="play-featured-track" onClick={() => onPlay(tracks[0], tracks, 0)} className="h-10 w-10 rounded-full bg-lime-300 text-[#171912]"><Play size={16} fill="currentColor" /></IconButton></div>}
    </section>
     <HomeCatalog onPlay={onPlay} onSave={onSave} />
    <section className="mb-12"><Heading kicker="Pick a direction" title="Browse by mood" />
      {genresQuery.isLoading ? <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">{[0,1,2,3,4,5,6,7].map((i) => <div key={i} className="skeleton h-[104px] rounded-2xl" />)}</div> :
       genresQuery.isError ? <Failure message="We couldn't load the genre shelves." retry={() => void genresQuery.refetch()} /> :
       genres.length === 0 ? <Empty icon={<AudioLines />} title="No shelves just yet" text="Check back when new listening paths are available." /> :
       <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">{genres.map((genre, i) => <button key={genre.id} data-testid={`button-genre-${genre.id}`} onClick={() => void selectShelf(genre.searchQuery, genre.id)} className={`group relative min-h-[104px] overflow-hidden rounded-2xl border px-4 py-4 text-left transition hover:-translate-y-0.5 ${activeShelf === genre.id ? 'border-lime-300/45 bg-lime-300/[.1]' : 'border-white/[.07] bg-[#17191b] hover:border-white/[.16]'}`}>
         <span className={`absolute -right-5 -top-7 h-24 w-24 rounded-full blur-2xl opacity-20 ${['bg-lime-300','bg-rose-300','bg-cyan-300','bg-orange-300'][i%4]}`} /><span className="relative block font-display text-lg font-semibold tracking-[-.4px]">{genre.name}</span><span className="relative mt-1 block line-clamp-2 text-[10px] leading-4 text-[#92948e]">{genre.description}</span>
       </button>)}</div>}
    </section>
    {(search.isPending || tracks.length > 0 || failure || activeShelf) && <section className="mb-12"><Heading kicker="A shelf selected for you" title={genres.find((g) => g.id === activeShelf)?.name || 'Songs to follow'} />
      {search.isPending ? <LoadingRows /> : failure ? <Failure message={failure} retry={() => { const genre = genres.find((g) => g.id === activeShelf); if (genre) void selectShelf(genre.searchQuery, genre.id); }} /> :
       tracks.length ? <div className="divide-y divide-white/[.045]">{tracks.map((track, i) => <TrackRow key={`${track.id}-${i}`} track={track} index={i} queue={tracks} onPlay={onPlay} onSave={onSave} />)}</div> :
       <Empty icon={<Music2 />} title="Nothing on this shelf" text="Try another genre to keep the discovery going." />}
    </section>}
    <section className="rounded-2xl border border-white/[.06] bg-[#151719] px-5 py-5 sm:flex sm:items-center sm:justify-between sm:px-7"><div><p className="font-mono-ui text-[9px] uppercase tracking-[.2em] text-[#73766f]">The fine print, not the loud kind</p><p className="mt-2 text-sm font-semibold">Play the song, save the song — never the stream.</p><p className="mt-1 text-xs text-[#858780]">Playlists keep only track details. Every listen gets a fresh session.</p></div><Link href="/library" className="mt-4 inline-flex items-center gap-2 text-xs font-semibold text-lime-300 sm:mt-0" data-testid="link-listen-library">Go to your library <ArrowRight size={14} /></Link></section>
  </div>;
}
function SearchPage({ lists, onPlay, onSave, onOpenDiagnostics }: { lists: Playlist[]; onPlay: (t: MusicTrack, q?: MusicTrack[], i?: number) => void; onSave: (t: MusicTrack) => void; onOpenDiagnostics: () => void }) {
  const search = useSearchMusic();
  const genreQuery = useGetMusicGenres();
  const [, setLocation] = useLocation();
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<'all'|'songs'|'albums'>('all');
  const kind: 'all'|'songs'|'albums' = filter;
  const [submitted, setSubmitted] = useState('');
  const [failure, setFailure] = useState('');
  const [results, setResults] = useState<Awaited<ReturnType<typeof search.mutateAsync>> | null>(null);
  const [suggestions, setSuggestions] = useState<SearchSuggestion[]>([]);
  const [suggestionError, setSuggestionError] = useState('');
  const [suggestionBusy, setSuggestionBusy] = useState(false);
  const [resultsBusy, setResultsBusy] = useState(false);
  const [highlighted, setHighlighted] = useState(-1);
  const [suggestionsOpen, setSuggestionsOpen] = useState(false);
  const [searchFocused, setSearchFocused] = useState(false);
  const [recentSearches, setRecentSearches] = useState<string[]>(readRecentSearches);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const genresRef = useRef<HTMLDivElement>(null);
  const selectedResult = useRef<{ query: string; kind: 'all'|'songs'|'albums'; result: Awaited<ReturnType<typeof search.mutateAsync>> } | null>(null);
  const queryRef = useRef(query);
  const requestVersion = useRef(0);
  const suggestionAbortRef = useRef<AbortController | null>(null);
  const suppressSuggestionFor = useRef<string | null>(null);
  queryRef.current = query;
  const rememberSearch = (term: string) => {
    const value = term.trim();
    if (!value) return;
    const next = [value, ...recentSearches.filter((item) => item.toLowerCase() !== value.toLowerCase())].slice(0, 8);
    setRecentSearches(next);
    try { localStorage.setItem(RECENT_SEARCHES_STORAGE, JSON.stringify(next)); } catch { /* Recent searches are optional. */ }
  };
  const removeRecentSearch = (term: string) => {
    const next = recentSearches.filter((item) => item !== term);
    setRecentSearches(next);
    try { localStorage.setItem(RECENT_SEARCHES_STORAGE, JSON.stringify(next)); } catch { /* Recent searches are optional. */ }
  };
  const localSuggestionTracks = useMemo(
    () => [...(results?.songs ?? []), ...lists.flatMap((list) => list.tracks)],
    [results?.songs, lists],
  );
  const localSuggestions = useMemo(
    () => localMusicSuggestions(query, localSuggestionTracks, QUICK_SEARCH_ARTISTS),
    [query, localSuggestionTracks],
  );

  useEffect(() => {
    const term = query.trim();
    const normalizedTerm = normalizeSuggestionText(term);
    const version = ++requestVersion.current;
    if (suppressSuggestionFor.current === term) {
      suppressSuggestionFor.current = null;
      setSuggestions([]);
      setSuggestionError('');
      setSuggestionsOpen(false);
      setSuggestionBusy(false);
      setHighlighted(-1);
      return;
    }
    if (term.length < MIN_SUGGESTION_QUERY_LENGTH) {
      suggestionAbortRef.current?.abort();
      setSuggestions([]);
      setSuggestionError('');
      setSuggestionBusy(false);
      setSuggestionsOpen(false);
      setHighlighted(-1);
      return;
    }
    setSuggestions(localSuggestions);
    setSuggestionError('');
    setSuggestionsOpen(true);
    setHighlighted(-1);
    setSuggestionBusy(false);
    if (normalizedTerm.length < 3) return;
    const artistMatches = QUICK_SEARCH_ARTISTS.filter((artist) =>
      normalizeSuggestionText(artist.name).startsWith(normalizedTerm),
    );
    const remoteQuery = artistMatches.length === 1 ? artistMatches[0]!.query : term;
    const timer = window.setTimeout(() => {
      suggestionAbortRef.current?.abort();
      const controller = new AbortController();
      suggestionAbortRef.current = controller;
      setSuggestionBusy(true);
      const startedAt = performance.now();
      void getMusicSuggestions({ q: remoteQuery }, { signal: controller.signal }).then((response) => {
        if (requestVersion.current !== version || queryRef.current.trim() !== term) return;
        setSuggestions(mergeSearchSuggestions(localSuggestions, response.suggestions));
        setSuggestionsOpen(true);
        recordMusicDiagnostic('info', 'Online suggestions', 'Suggestion list loaded.', {
          query: term,
          resolvedQuery: remoteQuery,
          count: response.suggestions.length,
          durationMs: Math.round(performance.now() - startedAt),
        });
      }).catch((error: unknown) => {
        if (controller.signal.aborted || requestVersion.current !== version) return;
        const message = error instanceof Error ? error.message : 'Online suggestions failed.';
        setSuggestionError(/\b429\b|rate.?limit/i.test(message) ? 'Online suggestions are unavailable right now.' : message);
        setSuggestionsOpen(true);
        recordMusicDiagnostic('warning', 'Online suggestions', message, { query: term });
      }).finally(() => {
        if (requestVersion.current === version) setSuggestionBusy(false);
      });
    }, SUGGESTION_DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
      suggestionAbortRef.current?.abort();
    };
  }, [query, localSuggestions]);

  const chooseSuggestion = (suggestion: SearchSuggestion) => {
    suppressSuggestionFor.current = suggestion.title.trim();
    setSuggestionsOpen(false);
    setSearchFocused(false);
    if (suggestion.kind === 'artist') {
      setFilter('songs');
      void searchFor(suggestion.searchQuery, 'songs');
      return;
    }
    if (suggestion.kind === 'album') {
      if (suggestion.albumId) {
        setLocation(`/albums/${encodeURIComponent(suggestion.albumId)}?title=${encodeURIComponent(suggestion.title)}&artist=${encodeURIComponent(suggestion.artist)}`);
        return;
      }
      const term = `${suggestion.title} ${suggestion.artist}`.trim();
      setFilter('albums');
      void searchFor(term, 'albums');
      return;
    }
    const selectedTrack: MusicTrack = {
      id: suggestion.id,
      title: suggestion.title,
      artist: suggestion.artist,
      albumTitle: null,
      albumId: suggestion.albumId,
      thumbnailUrl: suggestion.thumbnailUrl,
      durationSeconds: suggestion.durationSeconds,
      sourceUrl: suggestion.sourceUrl,
    };
    setFilter('songs');
    void searchFor(suggestion.artist || suggestion.title, 'songs', selectedTrack);
  };
  const searchFor = async (
    term: string,
    requestedKind: 'all'|'songs'|'albums' = kind,
    preferredTrack?: MusicTrack,
  ) => {
    const normalized = term.trim();
    if (!normalized) return;
    const startedAt = performance.now();
    recordMusicDiagnostic('info', 'Search', 'Song search started.', { query: normalized, kind: requestedKind });
    setQuery(normalized);
    setSubmitted(normalized);
    setFailure('');
    setResultsBusy(true);
    setSuggestionsOpen(false);
    selectedResult.current = null;
    if (normalized !== queryRef.current.trim()) suppressSuggestionFor.current = normalized;
    try {
      let response = await search.mutateAsync({ data: { query: normalized, kind: requestedKind, region: 'NG' } });
      if (preferredTrack && requestedKind !== 'albums') {
        const preferredKey = trackKey(preferredTrack);
        const songs = [
          preferredTrack,
          ...response.songs.filter((track) => trackKey(track) !== preferredKey),
        ];
        response = { ...response, songs, totalResults: Math.max(response.totalResults, songs.length) };
      }
      setResults(response);
      selectedResult.current = { query: normalized, kind: requestedKind, result: response };
      rememberSearch(normalized);
      recordMusicDiagnostic(response.totalResults ? 'info' : 'warning', 'Search', response.totalResults ? 'Music search completed.' : 'Music search returned no matches.', {
        query: normalized,
        kind: requestedKind,
        results: response.totalResults,
        durationMs: Math.round(performance.now() - startedAt),
        topTracks: response.songs.slice(0, 5).map((track) => `${track.title} — ${track.artist}`).join(' | '),
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Search failed. Please try again.';
      setFailure(/\b429\b|rate.?limit/i.test(message) ? 'Search is unavailable right now. Please try again.' : message);
      recordMusicDiagnostic('error', 'Search', message, {
        query: normalized,
        kind: requestedKind,
        durationMs: Math.round(performance.now() - startedAt),
      });
    }
    finally { setResultsBusy(false); }
  };
  const handleInputKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (!suggestionsOpen || !suggestions.length) {
      if (event.key === 'Escape') setSuggestionsOpen(false);
      return;
    }
    if (event.key === 'ArrowDown') { event.preventDefault(); setHighlighted((index) => (index + 1) % suggestions.length); }
    if (event.key === 'ArrowUp') { event.preventDefault(); setHighlighted((index) => (index - 1 + suggestions.length) % suggestions.length); }
    if (event.key === 'Escape') { setSuggestionsOpen(false); setHighlighted(-1); }
    if (event.key === 'Enter' && highlighted >= 0) { event.preventDefault(); chooseSuggestion(suggestions[highlighted]!); }
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault(); const term = query.trim(); if (!term) return;
    if (selectedResult.current?.query.toLowerCase() === term.toLowerCase() && selectedResult.current.kind === kind) {
      setResults(selectedResult.current.result);
      setSubmitted(selectedResult.current.result.query);
      setSuggestionsOpen(false);
      rememberSearch(term);
      setSearchFocused(false);
      return;
    }
    await searchFor(term);
  };
  const result = results?.query === submitted && submitted === query.trim() && results.kind === kind ? results : undefined;
  const retry = () => {
    if (!submitted) return;
    setResultsBusy(true);
    const startedAt = performance.now();
    void search.mutateAsync({ data: { query: submitted, kind, region: 'NG' } }).then((response) => {
      setResults(response); selectedResult.current = { query: submitted, kind, result: response }; setFailure('');
      recordMusicDiagnostic('info', 'Search retry', 'Music search retry completed.', { query: submitted, results: response.totalResults, durationMs: Math.round(performance.now() - startedAt) });
    }).catch((e) => {
      const message = e instanceof Error ? e.message : 'Search failed.';
      setFailure(message);
      recordMusicDiagnostic('error', 'Search retry', message, { query: submitted, durationMs: Math.round(performance.now() - startedAt) });
    }).finally(() => setResultsBusy(false));
  };
  const colors = ['#e53778', '#5b58d6', '#248b70', '#bc5741', '#ca7c26', '#168595', '#7b49b6', '#4170b8'];
  const categories = [
    { label: 'Music', icon: <Music2 size={22} />, color: '#df3772', action: () => { setFilter('songs'); selectedResult.current = null; searchInputRef.current?.focus(); } },
    { label: 'Albums', icon: <Album size={22} />, color: '#554dce', action: () => { setFilter('albums'); selectedResult.current = null; searchInputRef.current?.focus(); } },
    { label: 'Playlists', icon: <ListMusic size={22} />, color: '#187f69', action: () => setLocation('/library') },
    { label: 'Genres', icon: <AudioLines size={22} />, color: '#b85839', action: () => genresRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }) },
  ];
  const recentTracks = lists.flatMap((list) => list.tracks.map((track, index) => ({ track, queue: list.tracks, index }))).slice(0, 10);
  const showRecents = searchFocused && !query.trim() && recentSearches.length > 0;
  return <div className="page-enter mx-auto max-w-[1200px] px-4 pb-8 pt-3 sm:px-9 sm:py-10">
    <div className="mb-4 flex items-center justify-between md:hidden">
      <div className="flex items-center gap-3"><span className="grid h-8 w-8 place-items-center rounded-full bg-[#e53778] font-display text-base font-black text-white">L</span><h1 className="font-display text-[25px] font-bold tracking-[-.8px]">Search</h1></div>
      <button type="button" data-testid="button-open-diagnostics-search" onClick={onOpenDiagnostics} aria-label="Open music diagnostics" title="Music diagnostics" className="grid h-9 w-9 place-items-center rounded-full text-white/55 hover:bg-white/10 hover:text-lime-200"><Bug size={17} /></button>
    </div>
    <div className="mb-7 hidden md:block"><p className="mb-2 font-mono-ui text-[10px] uppercase tracking-[.22em] text-[#777b70]">Find your next favorite</p><h1 className="font-display text-4xl font-semibold tracking-[-1.7px] sm:text-5xl">Search</h1></div>
    <form onSubmit={submit} className="relative max-w-[780px]">
      <label className="flex h-[52px] items-center gap-3 rounded-xl bg-[#f4f4f4] px-4 text-[#1c1c1c] transition focus-within:ring-2 focus-within:ring-white/30 md:h-14 md:rounded-2xl">
        <Search size={20} className="shrink-0 text-[#242424]" />
        <input ref={searchInputRef} data-testid="input-music-search" role="combobox" aria-autocomplete="list" aria-expanded={suggestionsOpen && (suggestions.length > 0 || suggestionBusy || !!suggestionError)} aria-controls="music-search-suggestions" aria-activedescendant={highlighted >= 0 ? `music-suggestion-${highlighted}` : undefined} value={query}
          onChange={(e) => { setQuery(e.target.value); setSubmitted(''); setFailure(''); setResultsBusy(false); setSuggestionsOpen(true); selectedResult.current = null; }}
          onFocus={() => { setSearchFocused(true); if (query.trim().length >= MIN_SUGGESTION_QUERY_LENGTH) setSuggestionsOpen(true); }}
          onBlur={() => window.setTimeout(() => setSearchFocused(false), 120)}
          onKeyDown={handleInputKeyDown} placeholder="What do you want to listen to?"
          className="w-full bg-transparent text-sm text-[#181818] outline-none placeholder:text-[#6b6b6b]" />
        {query && <button type="button" data-testid="button-clear-search" aria-label="Clear search" onClick={() => { setQuery(''); setResults(null); setSubmitted(''); setFailure(''); setResultsBusy(false); selectedResult.current = null; setSuggestionsOpen(false); searchInputRef.current?.focus(); }} className="text-[#555]"><X size={17} /></button>}
      </label>
      {showRecents && <div className="absolute left-0 right-0 top-[58px] z-30 overflow-hidden rounded-xl border border-white/10 bg-[#1b1b1b] p-2 shadow-2xl md:top-[62px]">
        <div className="flex items-center justify-between px-3 py-2"><span className="text-sm font-bold">Recent searches</span><button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => { setRecentSearches([]); try { localStorage.removeItem(RECENT_SEARCHES_STORAGE); } catch { /* optional */ } }} className="text-[11px] font-semibold text-white/55 hover:text-white">Clear</button></div>
        {recentSearches.map((term) => <div key={term} className="flex items-center gap-2 rounded-lg px-2 hover:bg-white/[.06]">
          <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => { setSearchFocused(false); void searchFor(term); }} className="flex min-w-0 flex-1 items-center gap-3 py-2 text-left"><span className="grid h-9 w-9 shrink-0 place-items-center rounded-md bg-white/10 text-white/60"><Clock3 size={16} /></span><span className="truncate text-[13px]">{term}</span></button>
          <button type="button" aria-label={`Remove ${term} from recent searches`} onMouseDown={(e) => e.preventDefault()} onClick={() => removeRecentSearch(term)} className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-white/45 hover:bg-white/10 hover:text-white"><X size={14} /></button>
        </div>)}
      </div>}
      {suggestionsOpen && query.trim().length >= MIN_SUGGESTION_QUERY_LENGTH && <div id="music-search-suggestions" role="listbox" aria-label="Online search suggestions" data-testid="list-search-suggestions" className="absolute left-0 right-0 top-[58px] z-30 overflow-hidden rounded-xl border border-white/10 bg-[#1a1c1e] p-1.5 shadow-2xl md:top-[62px] md:rounded-2xl">
        {suggestionBusy && !suggestions.length ? <div role="status" className="flex items-center gap-3 px-3 py-3 text-xs text-[#94968f]"><Search size={15} className="shrink-0" />Searching online…</div> :
          suggestions.length ? <>{suggestions.map((item, index) => <button type="button" role="option" aria-selected={highlighted === index} id={`music-suggestion-${index}`} key={`${item.kind}-${item.id}-${index}`} data-testid={`button-search-suggestion-${index}`} onMouseDown={(e) => e.preventDefault()} onClick={() => chooseSuggestion(item)} className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition ${highlighted === index ? 'bg-white/[.09]' : 'hover:bg-white/[.06]'}`}>
            {item.kind === 'artist' ? <Headphones size={16} className="shrink-0 text-lime-200" /> : item.kind === 'album' ? <Album size={16} className="shrink-0 text-white/55" /> : <Music2 size={16} className="shrink-0 text-white/55" />}
            <span className="min-w-0 flex-1"><span className="block truncate text-[12px] font-medium text-white/90">{item.title}</span><span className="mt-0.5 block truncate text-[10px] text-white/55">{item.kind === 'artist' ? `Artist · ${item.artist}` : item.kind === 'album' ? `Album · ${item.artist}` : `Song · ${item.artist}`}</span></span>
          </button>)}{suggestionBusy && <div role="status" className="px-3 py-2 text-[10px] text-[#858780]">Finding matching songs…</div>}</> : suggestionError ? <div className="px-3 py-2">
            <p role="status" className="text-[11px] text-amber-100/75">Online suggestions couldn’t load. You can still search this text.</p>
            <button type="button" role="option" onMouseDown={(e) => e.preventDefault()} onClick={() => { setSuggestionsOpen(false); void searchFor(query.trim(), kind); }} className="mt-2 flex w-full items-center gap-3 rounded-lg bg-white/[.05] px-3 py-2.5 text-left text-[12px] font-medium"><Search size={15} /> Search for “{query.trim()}”</button>
          </div> : <div className="px-3 py-3 text-xs text-[#858780]">No online suggestions. Press Search to look in the song catalog.</div>}
      </div>}
    </form>
    {query.trim() && <div className="mt-3 flex gap-2 overflow-x-auto pb-1" aria-label="Search filters">
      {(['all', 'songs', 'albums'] as const).map((value) => <button key={value} type="button" aria-pressed={filter === value} onClick={() => { setFilter(value); selectedResult.current = null; if (query.trim()) void searchFor(query.trim(), value); }} data-testid={`button-search-kind-${value}`} className={`shrink-0 rounded-full px-4 py-2 text-xs font-semibold capitalize transition ${filter === value ? 'bg-white text-black' : 'bg-white/[.1] text-[#dfdfdf] hover:bg-white/[.16]'}`}>{value}</button>)}
    </div>}
    {!query.trim() && <div className="mt-5 grid grid-cols-2 gap-3 md:hidden">
      {categories.map((category) => <button key={category.label} type="button" onClick={category.action} className="relative flex h-[94px] items-start justify-between overflow-hidden rounded-lg p-3 text-left transition active:scale-[.98]" style={{ backgroundColor: category.color }}>
        <span className="max-w-[70%] font-display text-[17px] font-bold leading-tight">{category.label}</span><span className="absolute -bottom-2 -right-2 rotate-[18deg] text-white/60">{category.icon}</span>
      </button>)}
    </div>}
    {!query.trim() && <div className="mt-8 space-y-8 md:mt-9">
      {recentTracks.length > 0 && <section>
        <div className="mb-3 flex items-center justify-between"><h2 className="font-display text-[19px] font-bold tracking-[-.4px]">Made for you</h2><Link href="/library" className="text-[11px] font-bold uppercase tracking-wide text-white/55 hover:text-white">See all</Link></div>
        <div className="flex gap-3 overflow-x-auto pb-2">
          {recentTracks.map(({ track, queue, index }, i) => <button type="button" key={`${track.id}-${i}`} onClick={() => onPlay(track, queue, index)} className="w-[128px] shrink-0 rounded-lg p-2 text-left transition hover:bg-white/[.06] sm:w-[150px]">
            <Cover src={track.thumbnailUrl} title={track.title} className="mb-2 aspect-square w-full rounded-md shadow-lg" />
            <span className="block truncate text-[12px] font-bold">{track.title}</span><span className="mt-1 block truncate text-[10px] text-white/55">{track.artist}</span>
          </button>)}
        </div>
      </section>}
      {genreQuery.data?.genres?.length ? <section ref={genresRef} className="scroll-mt-5">
        <div className="mb-3 flex items-center justify-between"><div><h2 className="font-display text-[19px] font-bold tracking-[-.4px]">Discover something new</h2><p className="mt-1 text-[11px] text-white/50">Browse by genre and mood.</p></div></div>
        <div className="flex gap-3 overflow-x-auto pb-2 sm:grid sm:grid-cols-3 sm:overflow-visible lg:grid-cols-4">
          {genreQuery.data.genres.slice(0, 8).map((genre, index) => <button key={genre.id} type="button" data-testid={`button-search-genre-${genre.id}`} onClick={() => { setFilter('songs'); void searchFor(genre.searchQuery, 'songs'); }} className="relative h-[142px] w-[132px] shrink-0 overflow-hidden rounded-lg p-3 text-left transition hover:brightness-110 sm:h-[150px] sm:w-auto" style={{ background: `linear-gradient(145deg, ${colors[index % colors.length]}, #17191d 112%)` }}>
            <span className="relative z-10 block max-w-[90%] font-display text-[17px] font-bold leading-tight">{genre.name}</span><Music2 aria-hidden="true" className="absolute -bottom-3 -right-3 rotate-12 text-white/25" size={80} />
          </button>)}
        </div>
      </section> : genreQuery.isError ? <p className="text-[10px] text-[#82857f]">Browse categories are unavailable right now.</p> : null}
      {lists.length > 0 && <section>
        <div className="mb-3 flex items-center justify-between"><h2 className="font-display text-[19px] font-bold tracking-[-.4px]">Your playlists</h2><Link href="/library" className="text-[11px] font-bold uppercase tracking-wide text-white/55 hover:text-white">See all</Link></div>
        <div className="flex gap-3 overflow-x-auto pb-2">
          {lists.slice(0, 8).map((list, index) => <Link key={list.id} href={`/playlists/${list.id}`} className="w-[128px] shrink-0 rounded-lg p-2 transition hover:bg-white/[.06] sm:w-[150px]">
            {list.tracks[0] ? <Cover src={list.tracks[0].thumbnailUrl} title={list.name} className="mb-2 aspect-square w-full rounded-md shadow-lg" /> : <div className="mb-2 grid aspect-square w-full place-items-center rounded-md bg-white/10 text-white/60"><ListMusic size={32} /></div>}
            <span className="block truncate text-[12px] font-bold">{list.name}</span><span className="mt-1 block truncate text-[10px] text-white/55">{list.tracks.length} songs</span>
          </Link>)}
        </div>
      </section>}
    </div>}
    <div className={`${query.trim() ? 'mt-7' : 'mt-8'}`}>{resultsBusy ? <><div className="skeleton mb-5 h-7 w-44 rounded" /><LoadingRows /></> : failure ? <Failure message={failure} retry={retry} /> : result ? <>
      <div className="mb-5 flex items-end justify-between"><div><p className="font-mono-ui text-[9px] uppercase tracking-[.2em] text-[#747770]">Search results</p><h2 className="mt-2 font-display text-2xl font-semibold">“{result.query}”</h2></div><span className="font-mono-ui text-[10px] text-[#777a73]">{result.totalResults} found</span></div>
      {!result.totalResults ? <Empty icon={<Search />} title="No matches this time" text="Try a different title, artist, or spelling." /> :
       kind === 'albums' ? <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">{result.albums.map((album) => <AlbumCard key={album.id} album={album} />)}</div> :
       kind === 'all' ? <div className="space-y-8">
         {result.albums.length > 0 && <section><h3 className="mb-3 font-display text-lg font-bold">Albums</h3><div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">{result.albums.map((album) => <AlbumCard key={album.id} album={album} />)}</div></section>}
         {result.songs.length > 0 && <section><h3 className="mb-3 font-display text-lg font-bold">Songs</h3><div className="divide-y divide-white/[.045]">{result.songs.map((track, i) => <TrackRow key={`${track.id}-${i}`} track={track} index={i} queue={result.songs} onPlay={onPlay} onSave={onSave} />)}</div></section>}
       </div> :
       <div className="divide-y divide-white/[.045]">{result.songs.map((track, i) => <TrackRow key={`${track.id}-${i}`} track={track} index={i} queue={result.songs} onPlay={onPlay} onSave={onSave} />)}</div>}
    </> : query.trim() ? <Empty icon={<Search />} title="Keep typing" text="Live song or album matches will appear here." /> : null}</div>
  </div>;
}
function AlbumPage({ onPlay, onSave }: { onPlay: (t: MusicTrack, q?: MusicTrack[], i?: number) => void; onSave: (t: MusicTrack) => void }) {
  const { id } = useParams<{ id: string }>();
  const search = useSearch();
  const paramsFromUrl = new URLSearchParams(search);
  const title = paramsFromUrl.get('title') || id || '';
  const artist = paramsFromUrl.get('artist') || 'Unknown artist';
  const params = useMemo(() => ({ albumId: id || '', title, artist }), [id, title, artist]);
  const query = useGetMusicAlbum(params, { query: { enabled: !!id, queryKey: getGetMusicAlbumQueryKey(params) } });
  const album = query.data;
  return <div className="page-enter mx-auto max-w-[1200px] px-5 py-8 sm:px-9 sm:py-10">
    <Link href="/search" className="mb-7 inline-flex items-center gap-2 text-xs text-[#92948c] hover:text-white" data-testid="link-back-search"><ArrowLeft size={15} /> Back to search</Link>
    {query.isLoading ? <div className="flex flex-col gap-6 sm:flex-row"><div className="skeleton aspect-square w-full max-w-[260px] rounded-2xl" /><div className="flex-1 space-y-4 pt-10"><div className="skeleton h-3 w-24 rounded" /><div className="skeleton h-12 w-3/4 rounded" /><div className="skeleton h-4 w-40 rounded" /></div></div> :
     query.isError ? <Failure message="This album could not be loaded." retry={() => void query.refetch()} /> :
     album ? <>
      <div className="mb-10 grid items-end gap-7 sm:grid-cols-[minmax(180px,280px)_1fr]"><Cover src={album.thumbnailUrl} title={album.title} className="aspect-square w-full max-w-[280px] rounded-2xl shadow-2xl shadow-black/40" />
       <div className="pb-2"><p className="mb-3 font-mono-ui text-[9px] uppercase tracking-[.22em] text-lime-300">Album detail</p><h1 className="font-display text-4xl font-semibold leading-tight tracking-[-1.8px] sm:text-[54px]">{album.title}</h1><p className="mt-3 text-sm font-semibold">{album.artist}</p><p className="mt-2 text-xs text-[#878a83]">{[album.releaseYear, album.totalTracks ? `${album.totalTracks} tracks` : null].filter(Boolean).join(' · ')}</p>
        {album.tracks.length > 0 && <button onClick={() => onPlay(album.tracks[0], album.tracks, 0)} data-testid="button-play-album" className="mt-6 inline-flex h-11 items-center gap-2 rounded-full bg-[#d2f36b] px-5 text-xs font-extrabold text-[#171912]"><Play size={15} fill="currentColor" /> Play album</button>}
       </div></div>
      <Heading kicker="The complete tracklist" title={`${album.tracks.length} tracks`} />
      {album.tracks.length ? <div className="divide-y divide-white/[.045]">{album.tracks.map((track, i) => <TrackRow key={`${track.id}-${i}`} track={track} index={i} queue={album.tracks} onPlay={onPlay} onSave={onSave} />)}</div> : <Empty icon={<Album />} title="No tracks returned" text="The album detail is available, but its tracklist is empty." />}
     </> : <Empty icon={<Album />} title="Album not found" text="No album details were returned for this selection." />}
  </div>;
}
function LibraryPage({ lists, create, onImportSpotifyPlaylist }: {
  lists: Playlist[];
  create: () => void;
  onImportSpotifyPlaylist: (url: string) => Promise<{
    playlistId: string;
    playlistName: string;
    trackCount: number;
    updated: boolean;
  }>;
}) {
  const [spotifyUrl, setSpotifyUrl] = useState('');
  const [importingSpotify, setImportingSpotify] = useState(false);
  const [importNotice, setImportNotice] = useState<{
    kind: 'success' | 'error';
    text: string;
    playlistId?: string;
  } | null>(null);
  const importSpotify = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!spotifyUrl.trim() || importingSpotify) return;
    setImportingSpotify(true);
    setImportNotice(null);
    try {
      const result = await onImportSpotifyPlaylist(spotifyUrl.trim());
      setSpotifyUrl('');
      setImportNotice({
        kind: 'success',
        text: `${result.updated ? 'Updated' : 'Imported'} ${result.trackCount} songs from “${result.playlistName}”.`,
        playlistId: result.playlistId,
      });
    } catch (error) {
      const apiMessage = (error as { data?: { error?: string } } | null)?.data?.error;
      const message = apiMessage || (error instanceof Error ? error.message : '');
      setImportNotice({
        kind: 'error',
        text: message && !/^request failed/i.test(message)
          ? message
          : 'Could not import that playlist. Check that the Spotify playlist is public and try again.',
      });
    } finally {
      setImportingSpotify(false);
    }
  };
  return <div className="page-enter mx-auto max-w-[1200px] px-5 py-8 sm:px-9 sm:py-10">
    <div className="mb-9 flex items-end justify-between gap-4"><div><p className="mb-2 font-mono-ui text-[10px] uppercase tracking-[.22em] text-[#777b70]">Collected, not copied</p><h1 className="font-display text-4xl font-semibold tracking-[-1.8px] sm:text-5xl">Your library</h1><p className="mt-3 text-xs text-[#858780]">Playlists save song details only. Streams are freshly resolved when played.</p></div><button onClick={create} data-testid="button-create-library-playlist" className="inline-flex h-10 shrink-0 items-center gap-2 rounded-full bg-[#d2f36b] px-4 text-xs font-extrabold text-[#171912]"><Plus size={15} /> New playlist</button></div>
    <section aria-labelledby="spotify-import-heading" className="mb-8 rounded-2xl border border-white/[.08] bg-[#17191b] p-4 sm:p-5">
      <div className="mb-4 flex items-start gap-3">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-[#1ed760]/15 text-[#66e28a]"><ListMusic size={18} /></span>
        <div><h2 id="spotify-import-heading" className="font-display text-lg font-semibold">Bring a playlist from Spotify</h2><p className="mt-1 text-xs leading-relaxed text-[#8e9089]">Paste a public Spotify playlist link. Lenzo imports up to 200 song details only; playback uses Lenzo’s existing music sources.</p></div>
      </div>
      <form onSubmit={(event) => void importSpotify(event)} className="flex flex-col gap-2 sm:flex-row">
        <label className="sr-only" htmlFor="spotify-playlist-url">Spotify playlist link</label>
        <input id="spotify-playlist-url" data-testid="input-spotify-playlist-url" type="url" inputMode="url" autoComplete="url" required maxLength={500} value={spotifyUrl} onChange={(event) => setSpotifyUrl(event.target.value)} placeholder="https://open.spotify.com/playlist/…" className="h-11 min-w-0 flex-1 rounded-xl border border-white/[.1] bg-[#101114] px-4 text-sm text-white outline-none placeholder:text-[#666962] focus:border-lime-300/60" />
        <button type="submit" data-testid="button-import-spotify-playlist" disabled={importingSpotify || !spotifyUrl.trim()} className="inline-flex h-11 shrink-0 items-center justify-center gap-2 rounded-xl bg-[#d2f36b] px-5 text-xs font-extrabold text-[#171912] transition hover:bg-[#defb83] disabled:cursor-wait disabled:opacity-55">
          <ArrowDown size={15} className="-rotate-90" /> {importingSpotify ? 'Importing…' : 'Import playlist'}
        </button>
      </form>
      {importNotice && <div role={importNotice.kind === 'error' ? 'alert' : 'status'} className={`mt-3 flex items-center gap-2 text-xs ${importNotice.kind === 'error' ? 'text-[#e59a93]' : 'text-lime-200'}`}>
        {importNotice.kind === 'error' ? <CircleAlert size={14} /> : <ListMusic size={14} />}
        <span>{importNotice.text}{importNotice.playlistId && <> <Link href={`/playlists/${importNotice.playlistId}`} className="ml-1 font-bold underline underline-offset-2">Open playlist</Link></>}</span>
      </div>}
    </section>
    {!lists.length ? <Empty icon={<Library size={22} />} title="Your collection starts here" text="Save songs into a playlist and keep a small map of the sounds you love." action={<button onClick={create} data-testid="button-create-first-playlist" className="mt-5 text-xs font-bold text-lime-300">Create a playlist <ArrowRight className="ml-1 inline" size={14} /></button>} /> :
     <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">{lists.map((list) => <Link href={`/playlists/${list.id}`} key={list.id} data-testid={`card-playlist-${list.id}`} className="group flex items-center gap-4 rounded-2xl border border-white/[.07] bg-[#17191b] p-4 transition hover:border-white/[.15] hover:bg-[#1b1d1f]">
      <div className="grid h-[74px] w-[74px] shrink-0 grid-cols-2 gap-[2px] overflow-hidden rounded-xl bg-[#222528]">{list.tracks.slice(0,4).map((t,i) => <Cover key={`${t.id}-${i}`} src={t.thumbnailUrl} title={t.title} className="h-full w-full" />)}{!list.tracks.length && <div className="col-span-2 row-span-2 grid place-items-center text-[#a7b87d]"><ListMusic size={25} /></div>}</div>
      <div className="min-w-0 flex-1"><p className="truncate font-display text-base font-semibold">{list.name}</p><p className="mt-1 text-[11px] text-[#858780]">{list.tracks.length} {list.tracks.length === 1 ? 'song' : 'songs'}</p><p className="mt-2 font-mono-ui text-[9px] uppercase tracking-[.13em] text-[#666962]">Playlist</p></div><span className="grid h-9 w-9 place-items-center rounded-full bg-lime-300 text-[#171912] opacity-0 transition group-hover:opacity-100"><Play size={15} fill="currentColor" /></span>
     </Link>)}</div>}
  </div>;
}
function PlaylistPage({ lists, update, onPlay, onShuffle }: { lists: Playlist[]; update: (p: Playlist[]) => void; onPlay: (t: MusicTrack, q?: MusicTrack[], i?: number) => void; onShuffle: (tracks: MusicTrack[]) => void }) {
  const { id } = useParams<{ id: string }>();
  const [, setLocation] = useLocation();
  const list = lists.find((p) => p.id === id);
  const rename = () => {
    if (!list) return;
    const name = window.prompt('Rename playlist', list.name);
    if (name?.trim()) update(lists.map((p) => p.id === id ? { ...p, name: name.trim() } : p));
  };
  const remove = (index: number) => { if (list) update(lists.map((p) => p.id === id ? { ...p, tracks: p.tracks.filter((_, i) => i !== index) } : p)); };
  const move = (index: number, direction: -1 | 1) => {
    if (!list) return;
    const target = index + direction;
    if (target < 0 || target >= list.tracks.length) return;
    const tracks = [...list.tracks]; [tracks[index], tracks[target]] = [tracks[target], tracks[index]];
    update(lists.map((p) => p.id === id ? { ...p, tracks } : p));
  };
  const del = () => {
    if (!list || !window.confirm(`Delete “${list.name}”? This cannot be undone.`)) return;
    update(lists.filter((p) => p.id !== id)); setLocation('/library');
  };
  if (!list) return <div className="page-enter mx-auto max-w-[1200px] px-5 py-10 sm:px-9"><Empty icon={<ListMusic />} title="Playlist not found" text="This playlist may have been removed from your library." action={<Link href="/library" className="mt-4 inline-block text-xs font-bold text-lime-300" data-testid="link-return-library">Return to library</Link>} /></div>;
  return <div className="page-enter mx-auto max-w-[1200px] px-5 py-8 sm:px-9 sm:py-10">
    <Link href="/library" className="mb-7 inline-flex items-center gap-2 text-xs text-[#92948c] hover:text-white" data-testid="link-back-library"><ArrowLeft size={15} /> Your library</Link>
    <div className="mb-9 flex flex-col gap-6 sm:flex-row sm:items-end"><div className="grid h-[190px] w-[190px] shrink-0 grid-cols-2 gap-[2px] overflow-hidden rounded-2xl bg-[#222528] shadow-2xl shadow-black/30">{list.tracks.slice(0,4).map((t,i)=><Cover key={`${t.id}-${i}`} src={t.thumbnailUrl} title={t.title} className="h-full w-full" />)}{!list.tracks.length && <div className="col-span-2 row-span-2 grid place-items-center bg-gradient-to-br from-[#293023] to-[#121512] text-lime-300"><ListMusic size={50} strokeWidth={1} /></div>}</div>
      <div className="pb-1"><p className="mb-2 font-mono-ui text-[9px] uppercase tracking-[.22em] text-lime-300">Playlist</p><h1 data-testid="text-playlist-name" className="font-display text-4xl font-semibold tracking-[-1.8px] sm:text-5xl">{list.name}</h1><p className="mt-3 text-xs text-[#898b85]">{list.tracks.length} songs · Stored on this device</p><div className="mt-5 flex flex-wrap gap-2">
        {list.tracks.length > 0 && <button onClick={() => onPlay(list.tracks[0], list.tracks, 0)} data-testid="button-play-playlist" className="inline-flex h-10 items-center gap-2 rounded-full bg-[#d2f36b] px-5 text-xs font-extrabold text-[#171912]"><Play size={15} fill="currentColor" /> Play all</button>}
        {list.tracks.length > 1 && <button onClick={() => onShuffle(list.tracks)} data-testid="button-shuffle-playlist" className="inline-flex h-10 items-center gap-2 rounded-full border border-lime-300/30 px-4 text-xs font-semibold text-lime-200 hover:bg-lime-300/10"><Shuffle size={15} /> Shuffle</button>}
        <button onClick={rename} data-testid="button-rename-playlist" className="h-10 rounded-full border border-white/10 px-4 text-xs font-semibold text-[#c5c5bd] hover:bg-white/[.05]">Rename</button><button onClick={del} data-testid="button-delete-playlist" className="inline-flex h-10 items-center gap-2 rounded-full border border-red-200/10 px-4 text-xs font-semibold text-[#c88983] hover:bg-red-300/[.07]"><Trash2 size={14} /> Delete</button>
      </div></div>
    </div>
    {list.tracks.length ? <div className="overflow-x-auto"><div className="mb-2 grid min-w-[620px] grid-cols-[36px_minmax(0,1fr)_minmax(90px,.7fr)_52px_110px] gap-3 border-b border-white/[.07] px-3 pb-3 font-mono-ui text-[9px] uppercase tracking-[.17em] text-[#686b65]"><span>#</span><span>Title</span><span>Album</span><span>Time</span><span className="text-right">Arrange</span></div>
      <div className="min-w-[620px] divide-y divide-white/[.045]">{list.tracks.map((track, i) => <div key={`${track.id}-${i}`} className="grid grid-cols-[36px_minmax(0,1fr)_minmax(90px,.7fr)_52px_110px] items-center gap-3 rounded-xl px-3 py-2 transition hover:bg-white/[.04]" data-testid={`row-playlist-track-${i}`}>
        <button onClick={() => onPlay(track, list.tracks, i)} data-testid={`button-play-playlist-track-${i}`} aria-label={`Play ${track.title}`} className="text-xs text-[#858780] hover:text-lime-300">{String(i+1).padStart(2,'0')}</button>
        <button type="button" onClick={() => onPlay(track, list.tracks, i)} data-testid={`button-play-playlist-title-${i}`} aria-label={`Play ${track.title} by ${track.artist}`} className="flex min-w-0 items-center gap-3 text-left">
          <Cover src={track.thumbnailUrl} title={track.title} className="h-10 w-10 shrink-0 rounded-md" /><span className="min-w-0"><span className="block truncate text-[13px] font-semibold">{track.title}</span><span className="mt-1 block truncate text-[11px] text-[#858780]">{track.artist}</span></span>
        </button>
        <p className="truncate text-xs text-[#888a83]">{track.albumTitle || 'Single'}</p><span className="font-mono-ui text-[10px] text-[#777a73]">{formatDuration(track.durationSeconds)}</span>
        <div className="flex justify-end gap-1"><IconButton label={`move-track-up-${i}`} onClick={() => move(i,-1)} disabled={i===0} className="h-8 w-8 rounded-lg text-[#8b8d87] hover:bg-white/10"><ArrowDown className="rotate-180" size={14} /></IconButton><IconButton label={`move-track-down-${i}`} onClick={() => move(i,1)} disabled={i===list.tracks.length-1} className="h-8 w-8 rounded-lg text-[#8b8d87] hover:bg-white/10"><ArrowDown size={14} /></IconButton><IconButton label={`remove-track-${i}`} onClick={() => remove(i)} className="h-8 w-8 rounded-lg text-[#8b8d87] hover:bg-red-300/10 hover:text-red-300"><X size={14} /></IconButton></div>
      </div>)}</div></div> :
      <Empty icon={<Music2 />} title="This playlist is waiting" text="Search for a song and add it to this playlist." action={<Link href="/search" className="mt-4 inline-flex items-center gap-2 text-xs font-bold text-lime-300" data-testid="link-search-for-playlist">Find music <ArrowRight size={14} /></Link>} />}
  </div>;
}
function Player({ current, stream, playing, setPlaying, setError, status, setStatus, onAudioError, audioRef, volume, setVolume, toggle, skip, playQueueTrack, onPreload, onShuffle, lyricsOpen, setLyricsOpen, error, busy, quality, setQuality }: {
  current: Now | null; stream: MusicStream | null; playing: boolean; setPlaying: (v: boolean) => void; setError: (v: string) => void; status: string; setStatus: (v: string) => void; onAudioError: () => void; audioRef: RefObject<HTMLAudioElement | null>; volume: number; setVolume: (v: number) => void; toggle: () => void; skip: (v: -1 | 1) => void; playQueueTrack: (track: MusicTrack, queue?: MusicTrack[], index?: number) => void; onPreload: (track: MusicTrack) => void; onShuffle: () => void; lyricsOpen: boolean; setLyricsOpen: (v: boolean) => void; error: string; busy: boolean; quality: 'low' | 'medium' | 'high'; setQuality: (v: 'low' | 'medium' | 'high') => void;
}) {
  const track = current?.track;
  const [progress, setProgress] = useState(0);
  const [duration, setDuration] = useState(0);
  const [fullPlayer, setFullPlayer] = useState(false);
  const guardedStartTokenRef = useRef<string | null>(null);
  const lyricLineRefs = useRef<(HTMLButtonElement | null)[]>([]);
  useEffect(() => {
    setProgress(0);
    setDuration(0);
    guardedStartTokenRef.current = null;
  }, [track?.id, stream?.token]);
  const lyricParams = useMemo(() => track ? ({
    trackName: track.title, artistName: track.artist,
    ...(track.albumTitle ? { albumName: track.albumTitle } : {}),
    ...(track.durationSeconds ? { duration: track.durationSeconds } : {}),
  }) : { trackName: '', artistName: '' }, [track]);
  const lyricQuery = useGetMusicLyrics(lyricParams, { query: { enabled: !!track, queryKey: getGetMusicLyricsQueryKey(lyricParams) } });
  const lyrics = lyricQuery.data as YoutubeMusicLyricsResponse | undefined;
  const lines = lyrics?.syncedLyrics?.split('\n').map((line) => {
    const match = line.match(/^\[(\d{2}):(\d{2})(?:\.(\d{1,3}))?\](.*)$/);
    const time = match ? Number(match[1]) * 60 + Number(match[2]) + Number(`0.${match[3] || '0'}`) : -1;
    return { time: Number.isFinite(time) ? time : -1, text: match ? match[4].trim() : line.trim() };
  }).filter((line) => line.text) || [];
  const activeLyric = lines.reduce((active, line, index) => line.time >= 0 && progress >= line.time ? index : active, -1);
  useEffect(() => {
    if (lyricsOpen && activeLyric >= 0) lyricLineRefs.current[activeLyric]?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [activeLyric, lyricsOpen]);
  const seekToLyric = (time: number) => {
    if (!Number.isFinite(time) || time < 0 || !audioRef.current) return;
    audioRef.current.currentTime = time;
    setProgress(time);
  };
  return <>
     {fullPlayer && track && <section aria-label="Now playing" aria-modal="true" role="dialog" data-testid="panel-full-player" className="fixed inset-0 z-40 overflow-hidden bg-[#090a0c] text-white">
       <div className="absolute inset-0 overflow-hidden" aria-hidden="true">
         {track.thumbnailUrl && <img src={track.thumbnailUrl} alt="" className="h-full w-full scale-110 object-cover opacity-45 blur-3xl" />}
         <div className="absolute inset-0 bg-gradient-to-b from-black/45 via-[#0a0c0e]/65 to-[#08090b]/95" />
       </div>
        <div className="relative mx-auto flex h-[100dvh] max-w-3xl flex-col px-4 pb-[max(10px,env(safe-area-inset-bottom))] pt-[max(8px,env(safe-area-inset-top))] sm:px-9">
          <div className="flex h-10 shrink-0 items-center justify-between">
            <IconButton label="close-full-player" onClick={() => setFullPlayer(false)} className="h-9 w-9 rounded-full text-white/90 hover:bg-white/10"><ChevronDown size={21} /></IconButton>
           <div className="min-w-0 px-3 text-center"><p className="text-[9px] font-bold uppercase tracking-[.18em] text-white/55">Playing from</p><p className="mt-1 max-w-[220px] truncate text-[11px] font-semibold">{track.albumTitle || 'Your queue'}</p></div>
            <IconButton label="open-full-player-lyrics" onClick={() => setLyricsOpen(true)} className="h-9 w-9 rounded-full text-white/80 hover:bg-white/10"><AudioLines size={19} /></IconButton>
         </div>
          <div className="mx-auto flex min-h-0 w-full max-w-[520px] flex-1 flex-col justify-end overflow-y-auto pb-0">
            <div className="relative mb-3 min-h-[180px] max-h-[38dvh] flex-1 overflow-hidden rounded-[24px] border border-white/10 shadow-2xl shadow-black/45" data-testid="full-player-poster">
             <Cover src={track.thumbnailUrl} title={track.title} className="absolute inset-0 h-full w-full scale-105 blur-[2px]" />
             <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/35 to-black/15" />
              <button type="button" data-testid="button-lyrics-preview-open" onClick={() => setLyricsOpen(true)} className="absolute inset-0 flex flex-col justify-end p-4 text-left sm:p-6">
                <p className="mb-2 text-[9px] font-bold uppercase tracking-[.2em] text-white/70">Lyrics preview</p>
                <p className="line-clamp-3 font-display text-[22px] font-extrabold leading-tight tracking-[-.6px] text-white drop-shadow-lg sm:text-[27px]">
                 {lines[Math.max(activeLyric, 0)]?.text || lyrics?.plainLyrics?.split(/\r?\n/).find((line) => line.trim()) || 'Lyrics will appear here when available.'}
               </p>
                {lines[Math.max(activeLyric, 0) + 1] && <p className="mt-1.5 line-clamp-2 font-display text-sm font-bold leading-snug text-white/70 drop-shadow-md">{lines[Math.max(activeLyric, 0) + 1].text}</p>}
                <span className="mt-2.5 text-[10px] font-semibold text-white/70">Tap to open synced lyrics</span>
             </button>
           </div>
           <div className="flex items-center gap-3">
              <div className="min-w-0 flex-1"><h1 className="truncate font-display text-[19px] font-bold tracking-[-.4px]">{track.title}</h1><p className="mt-0.5 truncate text-[12px] text-white/65">{track.artist}</p></div>
              <button type="button" data-testid="button-full-player-save" onClick={() => window.dispatchEvent(new CustomEvent('lenzo-save-current'))} aria-label="Save current song" className="grid h-9 w-9 shrink-0 place-items-center rounded-full text-white/75 hover:bg-white/10"><Plus size={20} /></button>
           </div>
            <div className="mt-4 flex items-center gap-2">
             <span className="w-9 text-right font-mono-ui text-[10px] text-white/65">{formatDuration(progress)}</span>
             <input aria-label="Playback position" data-testid="input-full-player-position" type="range" min={0} max={duration || 1} value={Math.min(progress, duration || 1)} onChange={(e) => { const next = Number(e.target.value); setProgress(next); if (audioRef.current) audioRef.current.currentTime = next; }} className="h-1 flex-1 accent-[#d2f36b]" />
             <span className="w-9 font-mono-ui text-[10px] text-white/65">{formatDuration(duration)}</span>
           </div>
            <div className="mt-3 flex items-center justify-between">
             <IconButton label="shuffle-playlist-full" onClick={onShuffle} disabled={!current?.queue || current.queue.length < 2} className={current?.shuffled ? 'text-lime-300' : 'text-white/65'}><Shuffle size={19} /></IconButton>
             <IconButton label="previous-track-full" onClick={() => skip(-1)} disabled={!current?.queue} className="text-white"><SkipBack size={23} /></IconButton>
              <button type="button" data-testid="button-toggle-playback-full" onClick={toggle} disabled={!stream && !busy} aria-label={playing ? 'Pause' : 'Play'} className="grid h-[56px] w-[56px] place-items-center rounded-full bg-white text-[#111] transition hover:scale-105 disabled:opacity-50">{busy ? <span className="h-5 w-5 animate-spin rounded-full border-2 border-[#111] border-t-transparent" /> : playing ? <Pause size={23} fill="currentColor" /> : <Play size={23} fill="currentColor" />}</button>
             <IconButton label="next-track-full" onClick={() => skip(1)} disabled={!current?.queue} className="text-white"><SkipForward size={23} /></IconButton>
             <button type="button" data-testid="button-full-player-lyrics" onClick={() => setLyricsOpen(true)} className="grid h-10 w-10 place-items-center rounded-full text-white/80 hover:bg-white/10" aria-label="Open lyrics"><AudioLines size={19} /></button>
           </div>
            <div className="mt-3 flex items-center justify-between rounded-xl border border-white/10 bg-black/20 px-2.5 py-2">
             <button type="button" onClick={() => setLyricsOpen(true)} className="flex items-center gap-2 text-[11px] font-bold text-white/80"><AudioLines size={15} /> Open lyrics</button>
             <label className="text-[10px] font-semibold text-white/55">Quality <select aria-label="Stream quality for next track" data-testid="select-stream-quality-full" value={quality} onChange={(e) => setQuality(e.target.value as 'low'|'medium'|'high')} className="ml-1 bg-transparent text-[10px] text-white"><option className="text-black" value="low">Low · 32 kbps</option><option className="text-black" value="medium">Medium · 64 kbps</option><option className="text-black" value="high">High · 128 kbps</option></select></label>
           </div>
            {status && <p role="status" data-testid="status-full-player" className="mt-2 text-center text-[10px] text-white/65">{status}</p>}
            {current.queue && current.queue.length > 1 && <div className="mt-3 border-t border-white/10 pt-3">
             <div className="mb-2 flex items-center justify-between"><h2 className="font-display text-base font-semibold">Up next</h2><span className="text-[9px] text-white/45">{current.queue.length} tracks</span></div>
              <div className="max-h-20 space-y-1 overflow-y-auto">{current.queue.slice((current.index ?? 0) + 1).map((nextTrack, index) => <button type="button" key={`${nextTrack.id}-${index}`} data-testid={`button-play-queue-${index}`} onClick={() => playQueueTrack(nextTrack, current.queue, (current.index ?? 0) + index + 1)} className="flex w-full items-center gap-3 rounded-lg px-2 py-1 text-left hover:bg-white/[.07]"><Cover src={nextTrack.thumbnailUrl} title={nextTrack.title} className="h-7 w-7 rounded-md" /><span className="min-w-0 flex-1"><span className="block truncate text-[10px] font-semibold">{nextTrack.title}</span><span className="mt-0.5 block truncate text-[9px] text-white/55">{nextTrack.artist}</span></span><span className="font-mono-ui text-[9px] text-white/45">{formatDuration(nextTrack.durationSeconds)}</span></button>)}</div>
           </div>}
         </div>
       </div>
     </section>}
     {lyricsOpen && <section aria-label="Synced lyrics" aria-modal="true" role="dialog" className="fixed inset-0 z-50 overflow-hidden bg-[#090a0c] text-white" data-testid="panel-synced-lyrics">
       <div className="absolute inset-0 overflow-hidden" aria-hidden="true">
         {track?.thumbnailUrl && <img src={track.thumbnailUrl} alt="" className="h-full w-full scale-105 object-cover opacity-50 blur-[5px]" />}
         <div className="absolute inset-0 bg-gradient-to-b from-black/45 via-[#0b0d0f]/50 to-[#08090b]/82" />
       </div>
       <div className="relative mx-auto flex h-[100dvh] max-w-4xl flex-col px-5 pb-[max(14px,env(safe-area-inset-bottom))] pt-[max(12px,env(safe-area-inset-top))] sm:px-9">
         <div className="flex h-14 shrink-0 items-center gap-3">
           <IconButton label="close-lyrics" onClick={() => setLyricsOpen(false)} className="h-10 w-10 rounded-full text-white hover:bg-white/10"><ChevronDown size={22} /></IconButton>
           <div className="min-w-0 flex-1 text-center"><p className="truncate text-[12px] font-bold">{track?.title || 'Nothing playing'}</p><p className="mt-0.5 truncate text-[10px] text-white/60">{track?.artist}</p></div>
           <span className="h-10 w-10" aria-hidden="true" />
         </div>
         <div className="flex-1 overflow-y-auto py-[12vh]">
           {lyricQuery.isLoading ? <div className="mx-auto mt-12 max-w-md space-y-5">{[1,2,3,4,5].map((i)=><div key={i} className="skeleton mx-auto h-5 rounded" style={{ width: `${45+(i%3)*12}%` }} />)}</div> :
             lyricQuery.isError ? <p className="mt-20 text-center text-sm text-white/70">Lyrics couldn't be loaded. Playback is still available.</p> :
              lines.length ? <div className="mx-auto max-w-2xl space-y-6">{lines.map((line,i) => <button ref={(element) => { lyricLineRefs.current[i] = element; }} type="button" key={i} data-testid={`lyric-line-${i}`} aria-label={line.time >= 0 ? `Seek to lyric at ${formatDuration(line.time)}` : undefined} disabled={line.time < 0} onClick={() => seekToLyric(line.time)} className={`block w-full text-left font-display text-[27px] font-extrabold leading-[1.18] tracking-[-.7px] drop-shadow-lg transition sm:text-[34px] ${line.time >= 0 ? 'cursor-pointer' : 'cursor-default'} ${i === activeLyric ? 'scale-[1.01] text-white' : 'text-white/52'} disabled:opacity-70`}>{line.text}</button>)}</div> :
              lyrics?.plainLyrics ? <p className="mx-auto max-w-2xl whitespace-pre-line text-left font-display text-[25px] font-extrabold leading-[1.5] tracking-[-.6px] text-white/70">{lyrics.plainLyrics}</p> :
              <div className="mt-20 text-center"><p className="font-display text-2xl font-semibold text-white/80">No lyrics found</p><p className="mt-2 text-sm text-white/55">We'll keep the music going.</p></div>}
         </div>
         <div className="shrink-0 border-t border-white/10 pt-3">
           <div className="flex items-center gap-2">
             <span className="w-9 text-right font-mono-ui text-[9px] text-white/55">{formatDuration(progress)}</span>
             <input aria-label="Playback position" data-testid="input-lyrics-position" type="range" min={0} max={duration || 1} value={Math.min(progress, duration || 1)} onChange={(e) => { const next = Number(e.target.value); setProgress(next); if (audioRef.current) audioRef.current.currentTime = next; }} className="h-1 flex-1 accent-[#d2f36b]" />
             <span className="w-9 font-mono-ui text-[9px] text-white/55">{formatDuration(duration)}</span>
           </div>
           <div className="mt-3 flex items-center justify-between gap-3">
             <div className="min-w-0"><p className="truncate text-[11px] font-bold">{track?.title || 'No track selected'}</p><p className="mt-0.5 truncate text-[9px] text-white/55">{lyrics?.source ? `Lyrics · ${lyrics.source}` : 'Lenzo lyrics'}</p></div>
             <div className="flex shrink-0 items-center gap-4">
               <IconButton label="previous-track-lyrics" onClick={() => skip(-1)} disabled={!current?.queue} className="text-white/85"><SkipBack size={19} /></IconButton>
               <button type="button" data-testid="button-toggle-playback-lyrics" onClick={toggle} disabled={!stream && !busy} aria-label={playing ? 'Pause' : 'Play'} className="grid h-12 w-12 place-items-center rounded-full bg-white text-[#111] disabled:opacity-50">{busy ? <span className="h-4 w-4 animate-spin rounded-full border-2 border-[#111] border-t-transparent" /> : playing ? <Pause size={20} fill="currentColor" /> : <Play size={20} fill="currentColor" />}</button>
               <IconButton label="next-track-lyrics" onClick={() => skip(1)} disabled={!current?.queue} className="text-white/85"><SkipForward size={19} /></IconButton>
             </div>
           </div>
         </div>
       </div>
     </section>}
    <audio
      ref={audioRef}
      preload="none"
      onTimeUpdate={(e) => {
        const audio = e.currentTarget;
        const currentTime = audio.currentTime;
        const remaining = audio.duration - currentTime;
        setProgress(currentTime);
        if (playing && Number.isFinite(remaining) && remaining > 0 && remaining <= NEXT_TRACK_PRELOAD_LEAD_SECONDS && current?.queue && current.index !== undefined) {
          const next = current.shuffled
            ? current.queue.find((item) => !(current.playedTrackKeys ?? [trackKey(current.track)]).includes(trackKey(item)))
            : current.queue[(current.index + 1) % current.queue.length];
          if (next && current.queue.length > 1) onPreload(next);
        }
      }}
      onDurationChange={(e) => setDuration(e.currentTarget.duration || 0)}
      onEnded={() => {
        recordMusicDiagnostic('info', 'Playback', 'Track finished.', { title: track?.title, artist: track?.artist });
        setPlaying(false);
        skip(1);
      }}
      onCanPlay={() => {
        if (!playing && stream && status) {
          setStatus('The verified track is ready. Tap Play below to start it.');
          if (error.toLowerCase().includes('automatic playback')) {
            setError('Automatic playback was blocked. Tap Play below to start the ready track.');
          }
        }
      }}
      onPause={() => setPlaying(false)}
      onPlay={() => {
        recordMusicDiagnostic('info', 'Playback', 'Audio playback started or resumed.', { title: track?.title, artist: track?.artist });
        setPlaying(true);
        setStatus('');
        setError('');
      }}
      onPlaying={(e) => {
        if (!stream?.native || !stream.token || guardedStartTokenRef.current === stream.token) return;
        guardedStartTokenRef.current = stream.token;
        if (e.currentTarget.currentTime > 2) {
          try {
            e.currentTarget.currentTime = 0;
            setProgress(0);
          } catch {
            guardedStartTokenRef.current = null;
          }
        }
      }}
      onError={onAudioError}
    />
    <footer className="player-footer fixed inset-x-0 z-30 border-t border-white/[.08] bg-[#121315]/95 px-3 py-3 backdrop-blur-xl sm:px-6">
      <span aria-live="polite" aria-atomic="true" className="sr-only" data-testid="player-playback-live-status">{error || status}</span>
      <div className="mx-auto grid max-w-[1800px] grid-cols-[minmax(0,1fr)_auto] items-center gap-3 md:grid-cols-[minmax(200px,1fr)_minmax(260px,1.2fr)_minmax(200px,1fr)]">
        <div className="flex min-w-0 items-center gap-3">
          <button type="button" data-testid="button-open-full-player" onClick={() => track && setFullPlayer(true)} className="flex min-w-0 items-center gap-3 text-left" aria-label={track ? `Open now playing: ${track.title}` : 'No track selected'}>
            {track ? <Cover src={track.thumbnailUrl} title={track.title} className="h-12 w-12 shrink-0 rounded-md" /> : <div className="grid h-12 w-12 shrink-0 place-items-center rounded-md bg-[#222528] text-[#868a7d]"><Music2 size={19} /></div>}
            <span className="min-w-0"><span data-testid="text-player-track" className="block truncate text-xs font-semibold">{track?.title || 'Choose a song to begin'}</span><span data-testid="text-player-artist" className="mt-1 block truncate text-[10px] text-[#858780]">{track?.artist || 'Your listening room is ready'}</span></span>
          </button>
          {track && <button data-testid="button-player-save" onClick={() => window.dispatchEvent(new CustomEvent('lenzo-save-current'))} className="hidden text-[#777a73] hover:text-lime-300 sm:block" aria-label="Save current song"><Plus size={16} /></button>}
        </div>
        <div className="flex min-w-0 flex-col items-center gap-1.5">
           <div className="flex items-center gap-4"><IconButton label="shuffle-playlist" onClick={onShuffle} disabled={!current?.queue || current.queue.length < 2} className={current?.shuffled ? 'text-lime-300' : 'text-[#858780]'}><Shuffle size={15} /></IconButton><IconButton label="previous-track" onClick={() => skip(-1)} disabled={!current?.queue} className="text-[#858780]"><SkipBack size={16} /></IconButton><button data-testid="button-toggle-playback" onClick={toggle} disabled={!track || (!stream && !busy)} aria-label={playing ? 'Pause' : 'Play'} className="grid h-9 w-9 place-items-center rounded-full bg-[#d2f36b] text-[#171912] transition hover:scale-105 disabled:opacity-50">{busy ? <span className="h-4 w-4 animate-spin rounded-full border-2 border-[#171912] border-t-transparent" /> : playing ? <Pause size={16} fill="currentColor" /> : <Play size={16} fill="currentColor" />}</button><IconButton label="next-track" onClick={() => skip(1)} disabled={!current?.queue} className="text-[#858780]"><SkipForward size={16} /></IconButton></div>
          <div className="flex w-full items-center gap-2"><span className="w-8 text-right font-mono-ui text-[9px] text-[#73766f]">{formatDuration(progress)}</span><input aria-label="Playback position" data-testid="input-playback-position" type="range" min={0} max={duration || 1} value={Math.min(progress, duration || 1)} onChange={(e) => { const next = Number(e.target.value); setProgress(next); if (audioRef.current) audioRef.current.currentTime = next; }} className="h-1 min-w-10 flex-1 accent-[#d2f36b]" /><span className="w-8 font-mono-ui text-[9px] text-[#73766f]">{formatDuration(duration)}</span></div>
        </div>
        <div className="hidden items-center justify-end gap-3 md:flex"><button onClick={() => setLyricsOpen(!lyricsOpen)} data-testid="button-open-lyrics" disabled={!track} className={`text-[10px] font-semibold ${lyricsOpen ? 'text-lime-300' : 'text-[#858780] hover:text-white'}`}>Lyrics</button><label className="font-mono-ui text-[9px] text-[#73766f]">Next stream<select aria-label="Stream quality for next track" data-testid="select-stream-quality" value={quality} onChange={(e) => setQuality(e.target.value as 'low'|'medium'|'high')} className="ml-1 bg-transparent text-[10px] text-[#a9aaa3] outline-none"><option value="low">Low · 32</option><option value="medium">Medium · 64</option><option value="high">High · 128</option></select></label><Volume2 size={16} className="text-[#858780]" /><input aria-label="Volume" data-testid="input-volume" type="range" min={0} max={1} step={.01} value={volume} onChange={(e) => setVolume(Number(e.target.value))} className="w-20 accent-[#d2f36b]" /></div>
        <div className="flex items-center justify-end gap-2 md:hidden"><button onClick={() => setLyricsOpen(!lyricsOpen)} disabled={!track} data-testid="button-open-lyrics-mobile" className="text-[10px] font-semibold text-[#858780]">Lyrics</button><select aria-label="Stream quality" data-testid="select-stream-quality-mobile" value={quality} onChange={(e) => setQuality(e.target.value as 'low'|'medium'|'high')} className="w-16 bg-transparent text-[10px] text-[#a9aaa3]"><option value="low">Low</option><option value="medium">Med</option><option value="high">High</option></select></div>
      </div>
    </footer>
  </>;
}
function RoutedApp() {
  const [path] = useLocation();
  return path === '/admin' ? <MusicAdminPage /> : <App />;
}
function LenzoApp() {
  return <QueryClientProvider client={queryClient}><WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}><div className="dark"><RoutedApp /></div></WouterRouter></QueryClientProvider>;
}
export default LenzoApp;
