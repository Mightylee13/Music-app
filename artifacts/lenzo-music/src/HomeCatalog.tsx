import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { useSearchMusic } from "@workspace/api-client-react";
import type { MusicAlbum, MusicTrack } from "@workspace/api-client-react";
import { ArrowRight, Disc3, Music2, Plus, Search } from "lucide-react";
import { Link } from "wouter";

export type FeaturedArtist = {
  name: string;
  query: string;
  region: "NG" | "US";
  label: string;
};

export const FEATURED_ARTISTS: FeaturedArtist[] = [
  { name: "Burna Boy", query: "Burna Boy", region: "NG", label: "Nigeria" },
  { name: "Wizkid", query: "Wizkid", region: "NG", label: "Nigeria" },
  { name: "Taylor Swift", query: "Taylor Swift", region: "US", label: "United States" },
  { name: "Beyoncé", query: "Beyonce", region: "US", label: "United States" },
  { name: "Davido", query: "Davido", region: "NG", label: "Nigeria" },
  { name: "Asake", query: "Asake", region: "NG", label: "Nigeria" },
  { name: "Kendrick Lamar", query: "Kendrick Lamar", region: "US", label: "United States" },
  { name: "Billie Eilish", query: "Billie Eilish", region: "US", label: "United States" },
];
export const QUICK_SEARCH_ARTISTS: FeaturedArtist[] = [
  ...FEATURED_ARTISTS,
  { name: "Rema", query: "Rema", region: "NG", label: "Nigeria" },
  { name: "Tems", query: "Tems", region: "NG", label: "Nigeria" },
  { name: "Omah Lay", query: "Omah Lay", region: "NG", label: "Nigeria" },
  { name: "Ayra Starr", query: "Ayra Starr", region: "NG", label: "Nigeria" },
  { name: "BNXN", query: "BNXN", region: "NG", label: "Nigeria" },
  { name: "Fireboy DML", query: "Fireboy DML", region: "NG", label: "Nigeria" },
  { name: "Seyi Vibez", query: "Seyi Vibez", region: "NG", label: "Nigeria" },
  { name: "Drake", query: "Drake", region: "US", label: "United States" },
  { name: "The Weeknd", query: "The Weeknd", region: "US", label: "United States" },
  { name: "Rihanna", query: "Rihanna", region: "US", label: "United States" },
  { name: "SZA", query: "SZA", region: "US", label: "United States" },
  { name: "Travis Scott", query: "Travis Scott", region: "US", label: "United States" },
];
const INITIAL_ARTISTS = FEATURED_ARTISTS.slice(0, 4);

const ALBUM_SEARCHES = [
  { query: "Burna Boy", expectedArtist: "Burna Boy", region: "NG" as const },
  { query: "Taylor Swift", expectedArtist: "Taylor Swift", region: "US" as const },
];
const SONGS_PER_PAGE = 10;
const catalogSearchCache = new Map<string, Promise<unknown>>();

function normalizeArtistName(value: string) {
  return value.normalize("NFKD").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function cachedCatalogSearch<Result>(key: string, search: () => Promise<Result>): Promise<Result> {
  const cached = catalogSearchCache.get(key);
  if (cached) return cached as Promise<Result>;
  const pending = search();
  catalogSearchCache.set(key, pending);
  void pending.catch(() => {
    if (catalogSearchCache.get(key) === pending) catalogSearchCache.delete(key);
  });
  return pending;
}

function SectionHeading({ eyebrow, title }: { eyebrow: string; title: string }) {
  return <div className="mb-4">
    <p className="mb-1 font-mono-ui text-[9px] uppercase tracking-[.2em] text-[#777b70]">{eyebrow}</p>
    <h2 className="font-display text-[22px] font-semibold tracking-[-.6px]">{title}</h2>
  </div>;
}

function Artwork({ src, title, className = "" }: { src?: string | null; title: string; className?: string }) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  useEffect(() => setFailedSrc(null), [src]);
  const colors = ["from-lime-300/25 to-emerald-950", "from-rose-300/25 to-indigo-950", "from-amber-200/25 to-slate-900", "from-cyan-300/25 to-blue-950"];
  const shade = title.split("").reduce((sum, char) => sum + char.charCodeAt(0), 0) % colors.length;
  return <div className={`relative overflow-hidden bg-gradient-to-br ${colors[shade]} ${className}`}>
    {src && src !== failedSrc
      ? <img src={src} alt={`${title} artwork`} loading="lazy" onError={() => setFailedSrc(src)} className="h-full w-full object-cover" />
      : <div className="absolute inset-0 grid place-items-center"><Disc3 className="h-1/3 w-1/3 text-white/35" strokeWidth={1} /></div>}
  </div>;
}

function durationLabel(seconds?: number | null) {
  return seconds ? `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}` : "—";
}

function TrackRow({
  track, index, queue, onPlay, onSave,
}: {
  track: MusicTrack;
  index: number;
  queue: MusicTrack[];
  onPlay: (track: MusicTrack, queue?: MusicTrack[], index?: number) => void;
  onSave: (track: MusicTrack) => void;
}) {
  return <div className="group flex items-center gap-3 rounded-xl px-2 py-2 transition hover:bg-white/[.05]">
    <button type="button" onClick={() => onPlay(track, queue, index)} aria-label={`Play ${track.title} by ${track.artist}`} data-testid={`home-artist-song-${track.id}`} className="flex min-w-0 flex-1 items-center gap-3 text-left">
      <span className="w-6 shrink-0 text-center font-mono-ui text-[10px] text-white/45 group-hover:text-lime-200">{String(index + 1).padStart(2, "0")}</span>
      <Artwork src={track.thumbnailUrl} title={track.title} className="h-11 w-11 shrink-0 rounded-lg" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[12px] font-semibold text-white/90">{track.title}</span>
        <span className="mt-1 block truncate text-[10px] text-white/50">{track.artist}{track.albumTitle ? ` · ${track.albumTitle}` : ""}</span>
      </span>
      <span className="hidden shrink-0 font-mono-ui text-[9px] text-white/45 sm:block">{durationLabel(track.durationSeconds)}</span>
    </button>
    <button type="button" onClick={() => onSave(track)} aria-label={`Save ${track.title}`} className="grid h-9 w-9 shrink-0 place-items-center rounded-full text-white/45 hover:bg-white/10 hover:text-lime-200"><Plus size={15} /></button>
  </div>;
}

export function HomeCatalog({
  onPlay,
  onSave,
}: {
  onPlay: (track: MusicTrack, queue?: MusicTrack[], index?: number) => void;
  onSave: (track: MusicTrack) => void;
}) {
  const artistSearch = useSearchMusic();
  const albumSearch = useSearchMusic();
  const artistSearchFnRef = useRef(artistSearch.mutateAsync);
  const albumSearchFnRef = useRef(albumSearch.mutateAsync);
  artistSearchFnRef.current = artistSearch.mutateAsync;
  albumSearchFnRef.current = albumSearch.mutateAsync;
  const [artistSongs, setArtistSongs] = useState<Record<string, MusicTrack[]>>({});
  const [loadingArtists, setLoadingArtists] = useState<Record<string, boolean>>({});
  const [failedArtists, setFailedArtists] = useState<Record<string, boolean>>({});
  const [activeArtist, setActiveArtist] = useState<FeaturedArtist | null>(null);
  const [showAllArtists, setShowAllArtists] = useState(false);
  const [artistSearchTerm, setArtistSearchTerm] = useState("");
  const [visibleSongCount, setVisibleSongCount] = useState(SONGS_PER_PAGE);
  const [albums, setAlbums] = useState<MusicAlbum[]>([]);
  const [albumsLoading, setAlbumsLoading] = useState(true);
  const [albumsFailed, setAlbumsFailed] = useState(false);
  const artistSongsRef = useRef<Record<string, MusicTrack[]>>({});
  const artistPromisesRef = useRef(new Map<string, Promise<MusicTrack[] | undefined>>());
  const albumPromiseRef = useRef<Promise<void> | null>(null);
  const mountedRef = useRef(false);
  const artistResultsRef = useRef<HTMLElement | null>(null);

  const loadArtist = useCallback(async (artist: FeaturedArtist) => {
    if (artistSongsRef.current[artist.name]) return artistSongsRef.current[artist.name];
    const existing = artistPromisesRef.current.get(artist.name);
    if (existing) return existing;
    if (mountedRef.current) {
      setLoadingArtists((current) => ({ ...current, [artist.name]: true }));
      setFailedArtists((current) => ({ ...current, [artist.name]: false }));
    }
    const pending = (async () => {
      try {
        const result = await cachedCatalogSearch(
          `songs:${artist.region}:${artist.query.toLowerCase()}`,
          () => artistSearchFnRef.current({
            data: { query: `artist: ${artist.query}`, kind: "songs", region: artist.region },
          }),
        );
        const songs = result.songs.slice(0, 75);
        artistSongsRef.current = { ...artistSongsRef.current, [artist.name]: songs };
        if (mountedRef.current) setArtistSongs((current) => ({ ...current, [artist.name]: songs }));
        return songs;
      } catch {
        if (mountedRef.current) setFailedArtists((current) => ({ ...current, [artist.name]: true }));
        return undefined;
      } finally {
        artistPromisesRef.current.delete(artist.name);
        if (mountedRef.current) setLoadingArtists((current) => ({ ...current, [artist.name]: false }));
      }
    })();
    artistPromisesRef.current.set(artist.name, pending);
    return pending;
  }, []);

  const loadAlbums = useCallback(async () => {
    if (albumPromiseRef.current) return albumPromiseRef.current;
    setAlbumsLoading(true);
    setAlbumsFailed(false);
    const pending = (async () => {
      const results = await Promise.allSettled(ALBUM_SEARCHES.map(({ query, region }) =>
        cachedCatalogSearch(
          `albums:${region}:${query.toLowerCase()}`,
          () => albumSearchFnRef.current({ data: { query, kind: "albums", region } }),
        ),
      ));
      const nextAlbums = new Map<string, MusicAlbum>();
      let anySucceeded = false;
      for (const [index, result] of results.entries()) {
        if (result.status !== "fulfilled") continue;
        anySucceeded = true;
        const expectedArtist = normalizeArtistName(ALBUM_SEARCHES[index].expectedArtist);
        for (const album of result.value.albums) {
          const actualArtist = normalizeArtistName(album.artist);
          const artistMatches = actualArtist === expectedArtist || actualArtist.startsWith(`${expectedArtist} `);
          if (!album.id || !album.tracks.length || !artistMatches) continue;
          const key = album.id || `${album.title.toLowerCase()}-${album.artist.toLowerCase()}`;
          if (!nextAlbums.has(key)) nextAlbums.set(key, album);
        }
      }
      if (mountedRef.current) {
        setAlbums([...nextAlbums.values()].slice(0, 12));
        setAlbumsFailed(!anySucceeded || nextAlbums.size === 0);
        setAlbumsLoading(false);
      }
    })().finally(() => { albumPromiseRef.current = null; });
    albumPromiseRef.current = pending;
    return pending;
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    let nextArtist = 0;
    const workers = Array.from({ length: 3 }, async () => {
      while (mountedRef.current) {
        const artist = INITIAL_ARTISTS[nextArtist++];
        if (!artist) return;
        await loadArtist(artist);
      }
    });
    void Promise.all([...workers, loadAlbums()]);
    return () => { mountedRef.current = false; };
  }, [loadArtist, loadAlbums]);

  const selectArtist = (artist: FeaturedArtist) => {
    setActiveArtist(artist);
    setVisibleSongCount(SONGS_PER_PAGE);
    if (!artistSongsRef.current[artist.name]) void loadArtist(artist);
    window.requestAnimationFrame(() => artistResultsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
  };
  const findArtist = () => {
    const query = artistSearchTerm.trim();
    if (!query) return;
    const normalized = normalizeArtistName(query);
    const featured = FEATURED_ARTISTS.find((artist) => normalizeArtistName(artist.name) === normalized);
    selectArtist(featured ?? { name: query, query, region: "NG", label: "Artist search" });
  };
  const submitArtistSearch = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    findArtist();
  };

  const activeSongs = activeArtist ? artistSongs[activeArtist.name] ?? [] : [];
  const artistIsLoading = activeArtist ? !!loadingArtists[activeArtist.name] : false;
  const artistFailed = activeArtist ? !!failedArtists[activeArtist.name] : false;
  const normalizedArtistSearch = normalizeArtistName(artistSearchTerm);
  const visibleArtists = normalizedArtistSearch
    ? FEATURED_ARTISTS.filter((artist) => normalizeArtistName(artist.name).includes(normalizedArtistSearch))
    : showAllArtists ? FEATURED_ARTISTS : INITIAL_ARTISTS;

  return <div className="mb-12 space-y-10">
    <section aria-label="Featured artists">
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <SectionHeading eyebrow="Find your people" title="Featured artists" />
        <form onSubmit={submitArtistSearch} role="search" className="flex h-10 w-full items-center gap-2 rounded-full border border-white/10 bg-white/[.04] px-3 sm:max-w-[260px]">
          <Search size={15} className="shrink-0 text-white/45" />
          <input
            value={artistSearchTerm}
            onChange={(event) => setArtistSearchTerm(event.target.value)}
            aria-label="Search your artist"
            placeholder="Search your artist"
            className="min-w-0 flex-1 bg-transparent text-xs text-white outline-none placeholder:text-white/40"
          />
          {artistSearchTerm && <button type="submit" aria-label="Search artist" className="shrink-0 text-[10px] font-bold text-lime-200">Go</button>}
        </form>
      </div>
      <div className="flex snap-x gap-4 overflow-x-auto pb-3 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden" aria-label="Artist list">
        {visibleArtists.map((artist) => {
          const songs = artistSongs[artist.name] ?? [];
          const loading = !!loadingArtists[artist.name];
          return <button key={artist.name} type="button" onClick={() => selectArtist(artist)} data-testid={`button-featured-artist-${artist.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`} aria-pressed={activeArtist?.name === artist.name} className={`group flex w-[104px] shrink-0 snap-start flex-col items-center text-center transition ${activeArtist?.name === artist.name ? "text-lime-200" : "text-white/75 hover:text-white"}`}>
            <span className={`relative mb-2 block h-[88px] w-[88px] overflow-hidden rounded-full border transition ${activeArtist?.name === artist.name ? "border-lime-200 ring-2 ring-lime-200/20" : "border-white/10 group-hover:border-white/35"}`}>
              {loading && !songs[0]?.thumbnailUrl
                ? <span className="skeleton absolute inset-0" />
                : <Artwork src={songs[0]?.thumbnailUrl} title={artist.name} className="absolute inset-0 h-full w-full rounded-full transition duration-300 group-hover:scale-[1.06]" />}
            </span>
            <span className="block max-w-full truncate font-display text-[12px] font-bold">{artist.name}</span>
            <span className="mt-1 block font-mono-ui text-[8px] uppercase tracking-[.12em] text-white/40">{artist.label}</span>
          </button>;
        })}
        {normalizedArtistSearch && visibleArtists.length === 0 && <button type="button" onClick={findArtist} className="flex h-[126px] w-[140px] shrink-0 snap-start flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-white/15 text-xs text-white/60 hover:border-lime-200/35 hover:text-lime-200">
          <Search size={20} />Search songs by<br /><span className="max-w-full truncate font-bold text-white">{artistSearchTerm.trim()}</span>
        </button>}
      </div>
      {!showAllArtists && !normalizedArtistSearch && <button type="button" onClick={() => setShowAllArtists(true)} className="mt-3 inline-flex h-9 items-center gap-2 rounded-full border border-white/10 px-4 text-[10px] font-semibold text-white/60 transition hover:border-lime-200/30 hover:text-lime-200">More artists <ArrowRight size={13} /></button>}
    </section>

    {activeArtist && <section ref={artistResultsRef} aria-label={`Songs by ${activeArtist.name}`} data-testid="home-artist-results" className="scroll-mt-6 rounded-2xl border border-white/[.07] bg-[#141618] p-3 sm:p-5">
      <div className="mb-3 flex items-end justify-between gap-3">
        <div><p className="mb-1 font-mono-ui text-[9px] uppercase tracking-[.18em] text-lime-200">{activeArtist.label}</p><h2 className="font-display text-xl font-bold">Songs by {activeArtist.name}</h2></div>
        <button type="button" onClick={() => setActiveArtist(null)} className="shrink-0 rounded-full px-3 py-2 text-[10px] font-semibold text-white/55 hover:bg-white/10 hover:text-white">Close</button>
      </div>
      {artistIsLoading ? <div className="space-y-2">{[0, 1, 2, 3].map((item) => <div key={item} className="skeleton h-14 rounded-xl" />)}</div> :
        artistFailed ? <div className="rounded-xl border border-red-200/10 p-4 text-xs text-red-100/75"><p>Couldn’t load this artist’s songs.</p><button type="button" onClick={() => void loadArtist(activeArtist)} className="mt-3 font-bold text-lime-200">Try again</button></div> :
        activeSongs.length ? <>
          <div className="divide-y divide-white/[.05]">{activeSongs.slice(0, visibleSongCount).map((track, index) =>
            <TrackRow key={`${track.id}-${index}`} track={track} index={index} queue={activeSongs} onPlay={onPlay} onSave={onSave} />,
          )}</div>
          {visibleSongCount < activeSongs.length && <button type="button" onClick={() => setVisibleSongCount((count) => count + SONGS_PER_PAGE)} data-testid="button-load-more-artist-songs" className="mt-3 inline-flex h-10 w-full items-center justify-center gap-2 rounded-xl border border-white/10 text-xs font-semibold text-white/70 transition hover:border-lime-200/30 hover:text-lime-200">Load more songs <ArrowRight size={14} /></button>}
          <p className="mt-3 text-center text-[9px] text-white/35">Showing {Math.min(visibleSongCount, activeSongs.length)} of {activeSongs.length} songs found.</p>
        </> : <div className="rounded-xl border border-white/[.06] p-5 text-center text-xs text-white/50"><Music2 className="mx-auto mb-2" size={20} />No songs found for this artist yet.</div>}
    </section>}

    <section aria-label="Albums to explore">
      <SectionHeading eyebrow="Full tracklists" title="Albums to explore" />
      {albumsLoading ? <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">{[0, 1, 2, 3].map((item) => <div key={item} className="skeleton aspect-[.84] rounded-2xl" />)}</div> :
        albumsFailed ? <div className="rounded-2xl border border-white/[.07] bg-[#141618] px-4 py-5 text-xs text-white/50">Albums are unavailable right now. Search for an album to open its full tracklist.</div> :
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {albums.map((album) => <Link key={`${album.id}-${album.title}`} href={`/albums/${album.id}?title=${encodeURIComponent(album.title)}&artist=${encodeURIComponent(album.artist)}`} data-testid={`home-album-${album.id}`} className="group min-w-0 rounded-2xl border border-white/[.07] bg-[#151719] p-2 transition hover:-translate-y-0.5 hover:border-white/20">
            <Artwork src={album.thumbnailUrl} title={album.title} className="mb-2 aspect-square w-full rounded-xl transition duration-500 group-hover:scale-[1.02]" />
            <span className="block truncate px-1 text-[12px] font-bold">{album.title}</span>
            <span className="mt-1 block truncate px-1 pb-1 text-[10px] text-white/50">{album.artist} · {album.tracks.length} tracks</span>
          </Link>)}
        </div>}
    </section>
  </div>;
}
