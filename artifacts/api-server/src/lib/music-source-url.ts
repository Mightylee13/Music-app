const YOUTUBE_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "youtu.be",
  "www.youtu.be",
]);

export function youtubeVideoIdFromSourceUrl(sourceUrl: string | undefined | null): string | null {
  if (!sourceUrl) return null;
  try {
    const parsed = new URL(sourceUrl);
    if (
      parsed.protocol !== "https:"
      || parsed.username
      || parsed.password
      || (parsed.port && parsed.port !== "443")
      || !YOUTUBE_HOSTS.has(parsed.hostname.toLowerCase())
    ) return null;

    const videoId = parsed.hostname.toLowerCase().endsWith("youtu.be")
      ? parsed.pathname.split("/").filter(Boolean)[0]
      : parsed.pathname === "/watch"
        ? parsed.searchParams.get("v")
        : null;
    return videoId && /^[A-Za-z0-9_-]{11}$/.test(videoId) ? videoId : null;
  } catch {
    return null;
  }
}
