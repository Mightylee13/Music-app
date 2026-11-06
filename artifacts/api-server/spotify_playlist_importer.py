# spotify_playlist.py
# Reads any public Spotify playlist from a URL.
# Methods:
#   pathfinder -> anonymous web-player session, paginated in 100-track pages
#   embed      -> public embed scrape fallback, capped at ~100 tracks
#   auto       -> pathfinder, then embed fallback; no credentials required

import re
import sys
import json
import time
import argparse
from typing import List, Dict, Optional

import requests
from curl_cffi import requests as curl_requests

EMBED_URL = "https://open.spotify.com/embed/playlist/{pid}"
TOKEN_EMBED_URL = "https://open.spotify.com/embed/track/4uLU6hMCjMI75M1A2tKUQC"
PATHFINDER_URL = "https://api-partner.spotify.com/pathfinder/v1/query"
PATHFINDER_PLAYLIST_HASH = "86dde7b9d9356e2369414647cf6950cfed96e778e129cfdfc99aea6c1613b3b0"
SPOTIFY_APP_VERSION = "1.3.3.52.gba294495"
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"

ID_RE = re.compile(r"(?:playlist[/:])([A-Za-z0-9]{22})")


# ---------- URL parsing ----------

def extract_playlist_id(url: str) -> str:
    m = ID_RE.search(url)
    if not m:
        raise ValueError(f"No playlist ID found in: {url}")
    return m.group(1)


# ---------- Anonymous paginated web-player API ----------

def _pathfinder_token(session) -> str:
    """Read the anonymous session the public Spotify embed uses."""
    page = session.get(
        TOKEN_EMBED_URL,
        headers={"Accept-Language": "en-US,en;q=0.9"},
        timeout=25,
    )
    page.raise_for_status()
    match = _NEXT_RE.search(page.text)
    if not match:
        raise RuntimeError("Spotify embed did not expose its anonymous session.")
    state = json.loads(match.group(1))
    session_data = (
        state.get("props", {})
        .get("pageProps", {})
        .get("state", {})
        .get("settings", {})
        .get("session", {})
    )
    token = session_data.get("accessToken")
    if not token or session_data.get("isAnonymous") is not True:
        raise RuntimeError("Spotify did not provide a usable public-playlist session.")
    return token


def _pathfinder_playlist_page(session, pid: str, offset: int, limit: int,
                              token: str) -> tuple[Dict, str]:
    variables = {
        "uri": f"spotify:playlist:{pid}",
        "offset": offset,
        "limit": limit,
        "enableWatchFeedEntrypoint": False,
        "includeEpisodeContentRatingsV2": False,
    }
    params = {
        "operationName": "fetchPlaylist",
        "variables": json.dumps(variables, separators=(",", ":")),
        # This persisted-query hash is the public web-player playlist query.
        # Protocol reference: omkarcloud/spotify-scraper (MIT).
        "extensions": json.dumps(
            {"persistedQuery": {"version": 1, "sha256Hash": PATHFINDER_PLAYLIST_HASH}},
            separators=(",", ":"),
        ),
    }
    headers = {
        "accept": "application/json",
        "accept-language": "en-US,en;q=0.9",
        "authorization": f"Bearer {token}",
        "app-platform": "WebPlayer",
        "spotify-app-version": SPOTIFY_APP_VERSION,
        "origin": "https://open.spotify.com",
        "referer": "https://open.spotify.com/",
    }

    for attempt in range(3):
        response = session.get(PATHFINDER_URL, params=params, headers=headers, timeout=30)
        if response.status_code == 401:
            if attempt:
                response.raise_for_status()
            token = _pathfinder_token(session)
            headers["authorization"] = f"Bearer {token}"
            continue
        if response.status_code == 429:
            retry_after = response.headers.get("Retry-After")
            time.sleep(min(float(retry_after) if retry_after else 2 ** attempt, 15))
            continue
        response.raise_for_status()
        body = response.json()
        errors = body.get("errors") or []
        if errors:
            message = "; ".join(
                str(error.get("message") or "Spotify playlist query failed")
                for error in errors if isinstance(error, dict)
            )
            raise RuntimeError(message or "Spotify playlist query failed.")
        entity = (body.get("data") or {}).get("playlistV2")
        if not isinstance(entity, dict):
            raise RuntimeError("Spotify returned no public playlist data.")
        return entity, token

    raise RuntimeError("Spotify rate-limited playlist import after retries.")


def _normalize_pathfinder_track(row: dict) -> Optional[Dict]:
    wrapper = row.get("itemV2") or row.get("itemV3") or row.get("item") or {}
    if not isinstance(wrapper, dict):
        return None
    track = wrapper.get("data") or wrapper
    if not isinstance(track, dict) or track.get("__typename") not in (None, "Track"):
        return None

    artist_items = (track.get("artists") or {}).get("items") or []
    artists = ", ".join(
        name for name in (
            (artist.get("profile") or {}).get("name")
            for artist in artist_items if isinstance(artist, dict)
        ) if name
    )
    album = track.get("albumOfTrack") or {}
    album_artists = (album.get("artists") or {}).get("items") or []
    if not artists:
        artists = ", ".join(
            name for name in (
                (artist.get("profile") or {}).get("name")
                for artist in album_artists if isinstance(artist, dict)
            ) if name
        )
    if not artists:
        return None

    uri = track.get("uri")
    track_id = uri.rsplit(":", 1)[-1] if isinstance(uri, str) else ""
    duration = (track.get("trackDuration") or {}).get("totalMilliseconds")
    cover_sources = (album.get("coverArt") or {}).get("sources") or []
    thumbnail = next(
        (image.get("url") for image in cover_sources
         if isinstance(image, dict) and image.get("url")),
        None,
    )
    return {
        "title": track.get("name"),
        "artist": artists,
        "album": album.get("name"),
        "duration_ms": duration if isinstance(duration, int) and duration >= 0 else None,
        "uri": uri if isinstance(uri, str) else None,
        "url": f"https://open.spotify.com/track/{track_id}" if track_id else None,
        "thumbnail_url": thumbnail,
    }


def fetch_via_pathfinder(pid: str, max_tracks: int = 200) -> Dict:
    """Fetch public playlist items in 100-track pages with no user credentials."""
    session = curl_requests.Session(impersonate="chrome")
    try:
        token = _pathfinder_token(session)
        offset = 0
        tracks: List[Dict] = []
        metadata: Dict = {}
        playlist_total = 0

        while len(tracks) < max_tracks:
            page_limit = min(100, max_tracks - len(tracks))
            entity, token = _pathfinder_playlist_page(
                session, pid, offset, page_limit, token
            )
            content = entity.get("content") or {}
            rows = content.get("items") or []
            if not metadata:
                owner = (entity.get("ownerV2") or {}).get("data") or {}
                metadata = {
                    "name": entity.get("name"),
                    "owner": owner.get("name") or owner.get("display_name"),
                    "description": entity.get("description"),
                }
                playlist_total = content.get("totalCount") or 0

            for row in rows:
                if isinstance(row, dict):
                    track = _normalize_pathfinder_track(row)
                    if track and track["title"]:
                        tracks.append(track)
                        if len(tracks) >= max_tracks:
                            break

            offset += len(rows)
            if not rows or (playlist_total and offset >= playlist_total):
                break
            if len(rows) < page_limit:
                break
            time.sleep(0.15)

        if not tracks:
            raise RuntimeError("This playlist has no importable songs or is not public.")
        return {
            "source": "anon",
            "id": pid,
            **metadata,
            "total": len(tracks),
            "tracks": tracks,
        }
    finally:
        session.close()


# ---------- Embed scrape fallback (capped at ~100) ----------

_NEXT_RE = re.compile(
    r'<script[^>]+id="__NEXT_DATA__"[^>]*>(.*?)</script>',
    re.S,
)


def fetch_via_embed(pid: str, max_tracks: int = 200) -> Dict:
    r = requests.get(
        EMBED_URL.format(pid=pid),
        headers={"User-Agent": UA, "Accept-Language": "en-US,en;q=0.9"},
        timeout=20,
    )
    r.raise_for_status()

    m = _NEXT_RE.search(r.text)
    if not m:
        raise RuntimeError("Embed page layout changed - __NEXT_DATA__ not found")

    data = json.loads(m.group(1))
    try:
        entity = data["props"]["pageProps"]["state"]["data"]["entity"]
    except KeyError:
        raise RuntimeError("Unexpected embed JSON schema")

    raw = entity.get("trackList") or []
    tracks = []
    for t in raw[:max_tracks]:
        image = t.get("image") or t.get("imageUrl") or t.get("thumbnail")
        if isinstance(image, dict):
            image = image.get("url")
        tracks.append({
            "title": t.get("title"),
            "artist": t.get("subtitle"),
            "album": None,
            "duration_ms": t.get("duration"),
            "uri": t.get("uri"),
            "url": None,
            "thumbnail_url": image if isinstance(image, str) else None,
        })

    return {
        "source": "embed",
        "id": pid,
        "name": entity.get("name"),
        "owner": (entity.get("subtitle") or "").strip() or None,
        "description": entity.get("description"),
        "total": len(tracks),
        "tracks": tracks,
    }


# ---------- Output ----------

def fmt_duration(ms: Optional[int]) -> str:
    if not ms:
        return "--:--"
    s = ms // 1000
    return f"{s // 60}:{s % 60:02d}"


def print_table(result: Dict) -> None:
    print(f"\n{result['name']}  (by {result['owner'] or 'unknown'})")
    print(f"Source: {result['source']}   Tracks: {result['total']}\n")
    print(f"{'#':>4}  {'TITLE':<45} {'ARTIST':<40} {'LEN':>5}")
    print("-" * 100)
    for i, t in enumerate(result["tracks"], 1):
        title = (t["title"] or "")[:44]
        artist = (t["artist"] or "")[:39]
        print(f"{i:>4}  {title:<45} {artist:<40} {fmt_duration(t['duration_ms']):>5}")
    print()


def write_csv(result: Dict, path: str) -> None:
    import csv
    with open(path, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["index", "title", "artist", "album", "duration", "uri", "url"])
        for i, t in enumerate(result["tracks"], 1):
            w.writerow([i, t["title"], t["artist"], t["album"],
                        fmt_duration(t["duration_ms"]), t["uri"], t["url"]])
    print(f"Wrote {len(result['tracks'])} rows to {path}")


# ---------- CLI ----------

def main() -> int:
    ap = argparse.ArgumentParser(description="Read a public Spotify playlist (up to N tracks).")
    ap.add_argument("url", help="Spotify playlist URL or URI")
    ap.add_argument("--method", choices=["auto", "anon", "pathfinder", "embed"],
                    default="auto",
                    help="auto = anonymous paginated web-player, then embed fallback")
    ap.add_argument("--max-tracks", type=int, default=200,
                    help="stop after N tracks (default 200)")
    ap.add_argument("--json", action="store_true", help="Print raw JSON")
    ap.add_argument("--csv", metavar="FILE", help="Also write CSV to FILE")
    args = ap.parse_args()

    try:
        pid = extract_playlist_id(args.url)
    except ValueError as e:
        print(f"Error: {e}", file=sys.stderr)
        return 2

    order: List[str] = []
    if args.method == "auto":
        order = ["pathfinder", "embed"]
    else:
        order = [args.method]

    result = None
    for method in order:
        try:
            if method in ("anon", "pathfinder"):
                result = fetch_via_pathfinder(pid, args.max_tracks)
            elif method == "embed":
                result = fetch_via_embed(pid, args.max_tracks)
            break
        except Exception as e:
            print(f"[{method}] failed: {e}", file=sys.stderr)
            continue

    if result is None:
        print("All methods failed.", file=sys.stderr)
        return 1

    if args.json:
        print(json.dumps(result, indent=2, ensure_ascii=False))
    else:
        print_table(result)

    if args.csv:
        write_csv(result, args.csv)

    return 0


if __name__ == "__main__":
    sys.exit(main())
