const STORAGE_KEY = 'lenzo.music.diagnostics.v1';
const MAX_DIAGNOSTIC_EVENTS = 250;

export type MusicDiagnosticLevel = 'info' | 'warning' | 'error';
export type MusicDiagnosticEvent = {
  id: string;
  time: string;
  level: MusicDiagnosticLevel;
  area: string;
  message: string;
  details?: Record<string, string | number | boolean | null>;
};

const subscribers = new Set<() => void>();

function redactText(value: string): string {
  return value
    .replace(/https?:\/\/[^\s"'<>]+/gi, '[URL redacted]')
    .replace(/\b(api[_ -]?key|access[_ -]?token|session[_ -]?token|authorization)\b["']?\s*[:=]\s*["']?[^"'\s,;]+/gi, '$1=[redacted]')
    .slice(0, 500);
}

function safeDetails(details?: Record<string, unknown>): MusicDiagnosticEvent['details'] {
  if (!details) return undefined;
  const safe: NonNullable<MusicDiagnosticEvent['details']> = {};
  for (const [key, value] of Object.entries(details)) {
    if (/token|api.?key|authorization|cookie|url|uri/i.test(key)) continue;
    if (typeof value === 'string') safe[key] = redactText(value).slice(0, 180);
    else if (typeof value === 'number' || typeof value === 'boolean' || value === null) safe[key] = value;
  }
  return Object.keys(safe).length ? safe : undefined;
}

export function getMusicDiagnosticEvents(): MusicDiagnosticEvent[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is MusicDiagnosticEvent =>
      !!item && typeof item === 'object'
      && typeof item.id === 'string'
      && typeof item.time === 'string'
      && typeof item.level === 'string'
      && typeof item.area === 'string'
      && typeof item.message === 'string',
    ).slice(0, MAX_DIAGNOSTIC_EVENTS);
  } catch {
    return [];
  }
}

export function recordMusicDiagnostic(
  level: MusicDiagnosticLevel,
  area: string,
  message: string,
  details?: Record<string, unknown>,
): void {
  if (typeof window === 'undefined') return;
  const id = typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const entry: MusicDiagnosticEvent = {
    id,
    time: new Date().toISOString(),
    level,
    area: redactText(area).slice(0, 40),
    message: redactText(message),
    details: safeDetails(details),
  };
  const next = [entry, ...getMusicDiagnosticEvents()].slice(0, MAX_DIAGNOSTIC_EVENTS);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Keep the UI responsive if the browser's local storage is unavailable or full.
  }
  subscribers.forEach((subscriber) => subscriber());
}

export function clearMusicDiagnosticEvents(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // The diagnostics dialog still refreshes if storage is unavailable.
  }
  subscribers.forEach((subscriber) => subscriber());
}

export function subscribeMusicDiagnostics(subscriber: () => void): () => void {
  subscribers.add(subscriber);
  const onStorage = (event: StorageEvent) => {
    if (event.key === STORAGE_KEY) subscriber();
  };
  window.addEventListener('storage', onStorage);
  return () => {
    subscribers.delete(subscriber);
    window.removeEventListener('storage', onStorage);
  };
}
