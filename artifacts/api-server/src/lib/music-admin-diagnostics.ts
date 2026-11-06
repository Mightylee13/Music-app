import { randomUUID } from "node:crypto";
import type { RequestHandler } from "express";

export type MusicAdminDiagnostic = {
  id: string;
  timestamp: string;
  level: "info" | "warning" | "error";
  area: string;
  message: string;
};

const MAX_SERVER_DIAGNOSTICS = 200;
const serverDiagnostics: MusicAdminDiagnostic[] = [];

export function recordMusicAdminDiagnostic(
  level: MusicAdminDiagnostic["level"],
  area: string,
  message: string,
): void {
  serverDiagnostics.unshift({
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    level,
    area,
    message,
  });
  serverDiagnostics.length = Math.min(serverDiagnostics.length, MAX_SERVER_DIAGNOSTICS);
}

export function getMusicAdminDiagnostics(): MusicAdminDiagnostic[] {
  return serverDiagnostics.map((event) => ({ ...event }));
}

export function clearMusicAdminDiagnostics(): void {
  serverDiagnostics.length = 0;
}

function safeFailureForPath(path: string): { area: string; message: string } {
  const normalized = path.toLowerCase();
  if (normalized.startsWith("/music/admin")) {
    return { area: "Admin", message: "An admin request returned a server error." };
  }
  if (normalized.includes("/playback")) {
    return { area: "Playback", message: "A playback request returned a server error." };
  }
  if (normalized.includes("/suggest")) {
    return { area: "Suggestions", message: "A suggestion request returned a server error." };
  }
  if (normalized.includes("/lyrics")) {
    return { area: "Lyrics", message: "A lyrics request returned a server error." };
  }
  if (normalized.includes("/search") || normalized.includes("/album")) {
    return { area: "Search", message: "A music search request returned a server error." };
  }
  return { area: "Music service", message: "A music API request returned a server error." };
}

export const collectMusicBackendDiagnostics: RequestHandler = (request, response, next) => {
  if (request.path.toLowerCase().startsWith("/music/admin")) {
    next();
    return;
  }

  response.once("finish", () => {
    if (response.statusCode < 500) return;
    const safeEvent = safeFailureForPath(request.path);
    recordMusicAdminDiagnostic("error", safeEvent.area, safeEvent.message);
  });
  next();
};
