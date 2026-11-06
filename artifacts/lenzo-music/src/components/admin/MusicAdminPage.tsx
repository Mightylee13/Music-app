import { useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  Activity,
  ArrowDownToLine,
  AudioLines,
  Check,
  ChevronRight,
  CircleAlert,
  CircleHelp,
  Clock3,
  HardDrive,
  LockKeyhole,
  LogOut,
  RefreshCw,
  ShieldCheck,
  Trash2,
  Wrench,
} from 'lucide-react';
import {
  getGetMusicAdminOverviewQueryKey,
  getGetMusicAdminSessionQueryKey,
  useClearMusicAdminDiagnostics,
  useGetMusicAdminOverview,
  useGetMusicAdminSession,
  useLoginMusicAdmin,
  useLogoutMusicAdmin,
} from '@workspace/api-client-react';
import type {
  MusicAdminDiagnostic,
  MusicAdminLoginInput,
  MusicAdminOverview,
  MusicAdminSession,
} from '@workspace/api-client-react';
import {
  clearMusicDiagnosticEvents,
  getMusicDiagnosticEvents,
  subscribeMusicDiagnostics,
} from '../../musicDiagnostics';
import type { MusicDiagnosticEvent } from '../../musicDiagnostics';
import './MusicAdminPage.css';

type SafeLevel = 'info' | 'warning' | 'error';
type SafeBrowserEvent = {
  id: string;
  timestamp: string;
  level: SafeLevel;
  area: string;
  message: string;
};

function isUnauthorized(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { status?: unknown; response?: { status?: unknown } };
  return candidate.status === 401 || candidate.response?.status === 401;
}

function safeArea(area: string): string {
  const value = area.toLowerCase();
  if (value.includes('search')) return 'Search';
  if (value.includes('playback') || value.includes('audio') || value.includes('player')) return 'Playback';
  if (value.includes('cache')) return 'Cache';
  if (value.includes('scrap')) return 'Scraper';
  if (value.includes('network') || value.includes('request') || value.includes('api')) return 'Connection';
  if (value.includes('storage')) return 'Local storage';
  if (value.includes('admin') || value.includes('auth') || value.includes('session')) return 'Access';
  return 'Music app';
}

function safeLevelFor(level: string): SafeLevel {
  if (level === 'error') return 'error';
  if (level === 'warning') return 'warning';
  return 'info';
}

function safeBrowserEvent(event: MusicDiagnosticEvent, index: number): SafeBrowserEvent {
  const level = safeLevelFor(event.level);
  const levelText = level === 'error' ? 'Error' : level === 'warning' ? 'Notice' : 'Update';
  const parsedTime = new Date(event.time);
  return {
    id: String(index),
    timestamp: Number.isNaN(parsedTime.getTime()) ? new Date(0).toISOString() : parsedTime.toISOString(),
    level,
    area: safeArea(event.area),
    message: `${levelText} recorded in ${safeArea(event.area).toLowerCase()}.`,
  };
}

function formatDate(value: string | null | undefined): string {
  if (!value) return 'Not available';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Not available';
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

function formatUptime(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (days) return `${days}d ${hours}h`;
  if (hours) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function formatBytes(bytes: number): string {
  const megabytes = Math.max(0, bytes) / (1024 * 1024);
  return `${megabytes.toFixed(2)} MB`;
}

function isSafeLevel(level: string): SafeLevel {
  return safeLevelFor(level);
}

function ServiceStatus({ status }: { status: string }) {
  const healthy = status === 'healthy';
  return (
    <span className={`admin-status ${healthy ? 'is-healthy' : 'is-degraded'}`}>
      <span className="admin-status-dot" />
      {healthy ? 'Healthy' : 'Degraded'}
    </span>
  );
}

function ToolRow({ name, ready }: { name: string; ready: boolean }) {
  return (
    <div className="admin-tool-row">
      <span className={`admin-tool-icon ${ready ? 'ready' : 'not-ready'}`}>
        {ready ? <Check size={14} /> : <CircleAlert size={14} />}
      </span>
      <span className="admin-tool-name">{name}</span>
      <span className={`admin-tool-state ${ready ? 'ready' : 'not-ready'}`}>{ready ? 'Ready' : 'Unavailable'}</span>
    </div>
  );
}

function DiagnosticRow({
  id,
  timestamp,
  level,
  area,
  message,
  local = false,
}: {
  id: string;
  timestamp: string;
  level: SafeLevel;
  area: string;
  message: string;
  local?: boolean;
}) {
  return (
    <article className="admin-diagnostic-row" key={id}>
      <span className={`admin-level-mark ${level}`} aria-label={level} />
      <div className="admin-diagnostic-copy">
        <div className="admin-diagnostic-heading">
          <span className="admin-diagnostic-area">{area}</span>
          <span className={`admin-level-label ${level}`}>{level}</span>
          {local && <span className="admin-local-tag">This browser</span>}
        </div>
        <p>{message}</p>
      </div>
      <time className="admin-diagnostic-time" dateTime={timestamp}>{formatDate(timestamp)}</time>
    </article>
  );
}

function ErrorPanel({ retry, message }: { retry: () => void; message: string }) {
  return (
    <div className="admin-state-panel" role="alert">
      <span className="admin-state-icon"><CircleAlert size={20} /></span>
      <div>
        <strong>{message}</strong>
        <p>Check the connection, then try again.</p>
      </div>
      <button className="admin-button secondary" onClick={retry} type="button">
        <RefreshCw size={15} /> Retry
      </button>
    </div>
  );
}

export default function MusicAdminPage() {
  const queryClient = useQueryClient();
  const sessionQuery = useGetMusicAdminSession();
  const session = sessionQuery.data as MusicAdminSession | undefined;
  const overviewQuery = useGetMusicAdminOverview({
    query: {
      enabled: session?.authenticated === true,
      queryKey: getGetMusicAdminOverviewQueryKey(),
      retry: false,
      refetchOnWindowFocus: false,
      refetchInterval: 15_000,
    },
  });
  const loginMutation = useLoginMusicAdmin();
  const logoutMutation = useLogoutMusicAdmin();
  const clearMutation = useClearMusicAdminDiagnostics();
  const [password, setPassword] = useState('');
  const [loginError, setLoginError] = useState('');
  const [browserEvents, setBrowserEvents] = useState<MusicDiagnosticEvent[]>([]);
  const [notice, setNotice] = useState('');

  useEffect(() => {
    setBrowserEvents(getMusicDiagnosticEvents());
    return subscribeMusicDiagnostics(() => setBrowserEvents(getMusicDiagnosticEvents()));
  }, []);

  useEffect(() => {
    if (isUnauthorized(overviewQuery.error)) {
      queryClient.setQueryData<MusicAdminSession>(getGetMusicAdminSessionQueryKey(), (current) =>
        current ? { ...current, authenticated: false } : current,
      );
      queryClient.removeQueries({ queryKey: getGetMusicAdminOverviewQueryKey() });
      setNotice('Your admin session expired. Sign in again to continue.');
    }
  }, [overviewQuery.error, queryClient]);

  const safeLocalEvents = useMemo(() => browserEvents.map(safeBrowserEvent), [browserEvents]);
  const serverDiagnostics = (overviewQuery.data as MusicAdminOverview | undefined)?.diagnostics ?? [];
  const authenticated = session?.authenticated === true;

  const signIn = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setLoginError('');
    setNotice('');
    const input: MusicAdminLoginInput = { password };
    try {
      const result = await loginMutation.mutateAsync({ data: input });
      setPassword('');
      queryClient.setQueryData(getGetMusicAdminSessionQueryKey(), result);
      if (result.authenticated) {
        await queryClient.invalidateQueries({ queryKey: getGetMusicAdminOverviewQueryKey() });
      } else {
        setLoginError('Sign-in was not accepted. Check your password and try again.');
      }
    } catch {
      setPassword('');
      setLoginError('Sign-in was not accepted. Check your password and try again.');
    }
  };

  const signOut = async () => {
    try {
      const result = await logoutMutation.mutateAsync();
      queryClient.setQueryData(getGetMusicAdminSessionQueryKey(), result);
      queryClient.removeQueries({ queryKey: getGetMusicAdminOverviewQueryKey() });
      setNotice('');
    } catch {
      setNotice('Unable to sign out right now. Please try again.');
    }
  };

  const refresh = () => {
    void sessionQuery.refetch();
    if (authenticated) void overviewQuery.refetch();
    setBrowserEvents(getMusicDiagnosticEvents());
  };

  const clearServerDiagnostics = async () => {
    if (!window.confirm('Clear the shared server diagnostics? This cannot be undone.')) return;
    try {
      const result = await clearMutation.mutateAsync();
      if (result.cleared) {
        setNotice('Shared server diagnostics cleared.');
        await overviewQuery.refetch();
      } else {
        setNotice('The server did not clear its diagnostics. Try again.');
      }
    } catch (error) {
      if (isUnauthorized(error)) {
        queryClient.setQueryData<MusicAdminSession>(getGetMusicAdminSessionQueryKey(), (current) =>
          current ? { ...current, authenticated: false } : current,
        );
        setNotice('Your admin session expired. Sign in again to continue.');
      } else {
        setNotice('Unable to clear server diagnostics. Try again.');
      }
    }
  };

  const clearLocalDiagnostics = () => {
    if (!window.confirm('Clear diagnostics saved in this browser? Shared server diagnostics will not be changed.')) return;
    clearMusicDiagnosticEvents();
    setBrowserEvents([]);
    setNotice('Browser diagnostics cleared on this device.');
  };

  const exportDiagnostics = () => {
    const safeServer = serverDiagnostics.map((item: MusicAdminDiagnostic) => ({
      source: 'server',
      id: item.id,
      timestamp: item.timestamp,
      level: isSafeLevel(item.level),
      area: item.area,
      message: item.message,
    }));
    const safeBrowser = safeLocalEvents.map((item) => ({
      source: 'browser',
      id: item.id,
      timestamp: item.timestamp,
      level: item.level,
      area: item.area,
      message: item.message,
    }));
    const payload = {
      exportedAt: new Date().toISOString(),
      note: 'Browser entries are redacted safe labels; server entries are sanitized diagnostics.',
      diagnostics: [...safeServer, ...safeBrowser],
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const href = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = href;
    link.download = `lenzo-music-diagnostics-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    URL.revokeObjectURL(href);
  };

  const overview = overviewQuery.data as MusicAdminOverview | undefined;

  if (sessionQuery.isLoading) {
    return (
      <main className="music-admin-page">
        <div className="admin-shell page-enter">
          <div className="admin-topline"><span className="admin-brand-mark"><AudioLines size={18} /></span><span>LENZO / MUSIC</span></div>
          <div className="admin-skeleton-head skeleton" />
          <div className="admin-skeleton-sub skeleton" />
          <div className="admin-skeleton-card skeleton" />
          <div className="admin-skeleton-card short skeleton" />
        </div>
      </main>
    );
  }

  if (sessionQuery.isError) {
    return (
      <main className="music-admin-page">
        <div className="admin-shell page-enter">
          <div className="admin-topline"><span className="admin-brand-mark"><AudioLines size={18} /></span><span>LENZO / MUSIC</span></div>
          <h1 className="admin-title">Admin console</h1>
          <ErrorPanel message="Could not check admin access." retry={() => void sessionQuery.refetch()} />
        </div>
      </main>
    );
  }

  if (!session?.configured) {
    return (
      <main className="music-admin-page">
        <div className="admin-shell page-enter">
          <div className="admin-topline">
            <span className="admin-brand-mark"><AudioLines size={18} /></span>
            <span>LENZO / MUSIC</span><span className="admin-private-label"><LockKeyhole size={12} /> PRIVATE OPERATIONS</span>
          </div>
          <div className="admin-login-layout">
            <div className="admin-login-intro">
              <span className="admin-kicker">OWNER ACCESS / 01</span>
              <h1 className="admin-title">Keep the<br /><em>signal clear.</em></h1>
              <p>One quiet place to check whether search, playback, and their supporting services are ready.</p>
              <div className="admin-login-ornament" aria-hidden="true"><span /><span /><span /><span /><span /><span /><span /></div>
            </div>
            <section className="admin-login-card" aria-labelledby="admin-login-heading">
              {session?.configured !== true ? (
                <div className="admin-setup-note">
                  <span className="admin-setup-icon"><CircleHelp size={19} /></span>
                  <div>
                    <h2>Admin access is not configured</h2>
                    <p>Add <code>LENZO_MUSIC_ADMIN_PASSWORD</code> in workspace Secrets. Use a strong, unique value; it is never shown here.</p>
                  </div>
                </div>
              ) : (
                <>
                  <div className="admin-card-eyebrow"><ShieldCheck size={15} /> OWNER SIGN-IN</div>
                  <h2 id="admin-login-heading">Welcome back.</h2>
                  <p className="admin-form-intro">Enter the private admin password to inspect system health.</p>
                  <form onSubmit={signIn}>
                    <label htmlFor="music-admin-password">Password</label>
                    <input
                      id="music-admin-password"
                      type="password"
                      autoComplete="current-password"
                      value={password}
                      onChange={(event) => setPassword(event.target.value)}
                      required
                      maxLength={256}
                      placeholder="Enter admin password"
                    />
                    {loginError && <p className="admin-inline-error" role="alert">{loginError}</p>}
                    <button className="admin-button primary admin-signin-button" disabled={loginMutation.isPending || !password} type="submit">
                      {loginMutation.isPending ? 'Checking access…' : 'Sign in'} <ChevronRight size={16} />
                    </button>
                  </form>
                </>
              )}
            </section>
          </div>
          <footer className="admin-footer"><span>LENZO MUSIC / INTERNAL</span><span>SAFE DIAGNOSTICS ONLY</span></footer>
        </div>
      </main>
    );
  }

  if (!authenticated) {
    return (
      <main className="music-admin-page">
        <div className="admin-shell page-enter">
          <div className="admin-topline">
            <span className="admin-brand-mark"><AudioLines size={18} /></span>
            <span>LENZO / MUSIC</span><span className="admin-private-label"><LockKeyhole size={12} /> PRIVATE OPERATIONS</span>
          </div>
          <div className="admin-login-layout">
            <div className="admin-login-intro">
              <span className="admin-kicker">OWNER ACCESS / 01</span>
              <h1 className="admin-title">Keep the<br /><em>signal clear.</em></h1>
              <p>One quiet place to check whether search, playback, and their supporting services are ready.</p>
              <div className="admin-login-ornament" aria-hidden="true"><span /><span /><span /><span /><span /><span /><span /></div>
            </div>
            <section className="admin-login-card" aria-labelledby="admin-login-heading">
              <div className="admin-card-eyebrow"><ShieldCheck size={15} /> OWNER SIGN-IN</div>
              <h2 id="admin-login-heading">Welcome back.</h2>
              <p className="admin-form-intro">Enter the private admin password to inspect system health.</p>
              <form onSubmit={signIn}>
                <input type="text" name="username" autoComplete="username" value="owner" tabIndex={-1} aria-hidden="true" hidden readOnly />
                <label htmlFor="music-admin-password">Password</label>
                <input
                  id="music-admin-password"
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  required
                  maxLength={256}
                  placeholder="Enter admin password"
                />
                {loginError && <p className="admin-inline-error" role="alert">{loginError}</p>}
                {notice && <p className="admin-inline-note" role="status">{notice}</p>}
                <button className="admin-button primary admin-signin-button" disabled={loginMutation.isPending || !password} type="submit">
                  {loginMutation.isPending ? 'Checking access…' : 'Sign in'} <ChevronRight size={16} />
                </button>
              </form>
              <div className="admin-private-caption"><LockKeyhole size={13} /> Owner-only diagnostics</div>
            </section>
          </div>
          <footer className="admin-footer"><span>LENZO MUSIC / INTERNAL</span><span>SAFE DIAGNOSTICS ONLY</span></footer>
        </div>
      </main>
    );
  }

  return (
    <main className="music-admin-page">
      <div className="admin-shell page-enter">
        <header className="admin-topline">
          <div className="admin-brand"><span className="admin-brand-mark"><AudioLines size={18} /></span><span>LENZO / MUSIC</span></div>
          <div className="admin-header-actions">
            <span className="admin-private-label"><span className="admin-private-dot" /> PRIVATE ADMIN</span>
            <button className="admin-icon-button" type="button" onClick={refresh} title="Refresh status" aria-label="Refresh status">
              <RefreshCw size={16} className={overviewQuery.isFetching ? 'admin-spinning' : ''} />
            </button>
            <button className="admin-button signout" type="button" onClick={() => void signOut()} disabled={logoutMutation.isPending}>
              <LogOut size={15} /> {logoutMutation.isPending ? 'Signing out' : 'Sign out'}
            </button>
          </div>
        </header>

        <section className="admin-dashboard-heading">
          <div>
            <span className="admin-kicker">OPERATIONS / LIVE VIEW</span>
            <h1 className="admin-title">Music systems<span className="admin-title-period">.</span></h1>
            <p className="admin-subtitle">A clear read on the services behind listening.</p>
          </div>
          <div className="admin-updated">
            <span className="admin-live-pulse" />
            <span>LAST CHECK</span>
            <strong>{overview ? formatDate(overview.service.checkedAt) : 'Waiting for status'}</strong>
          </div>
        </section>

        {notice && <div className="admin-notice" role="status">{notice}<button type="button" onClick={() => setNotice('')} aria-label="Dismiss message">×</button></div>}

        {overviewQuery.isLoading && (
          <div className="admin-dashboard-loading" aria-label="Loading music system status">
            <div className="admin-skeleton-card skeleton" />
            <div className="admin-skeleton-card short skeleton" />
            <div className="admin-skeleton-card skeleton" />
          </div>
        )}
        {overviewQuery.isError && !isUnauthorized(overviewQuery.error) && (
          <ErrorPanel message="System status is temporarily unavailable." retry={() => void overviewQuery.refetch()} />
        )}
        {overview && (
          <>
            <section className="admin-overview-grid" aria-label="Service overview">
              <article className="admin-health-card">
                <div className="admin-section-label"><Activity size={14} /> SERVICE HEALTH</div>
                <div className="admin-health-main">
                  <div>
                    <ServiceStatus status={overview.service.status} />
                    <h2>{overview.service.status === 'healthy' ? 'All systems go.' : 'Needs attention.'}</h2>
                    <p>Music search and playback service</p>
                  </div>
                  <div className="admin-health-orbit" aria-hidden="true"><span /><span /><span /><span /></div>
                </div>
                <div className="admin-health-meta">
                  <div><span>UPTIME</span><strong>{formatUptime(overview.service.uptimeSeconds)}</strong></div>
                  <div><span>CHECKED</span><strong>{formatDate(overview.service.checkedAt)}</strong></div>
                </div>
              </article>
              <article className="admin-tools-card">
                <div className="admin-section-label"><Wrench size={14} /> RUNTIME TOOLS <span className="admin-section-count">04</span></div>
                <ToolRow name="Music scraper" ready={overview.tools.scraper.ready} />
                <ToolRow name="yt-dlp" ready={overview.tools.ytDlp.ready} />
                <ToolRow name="FFmpeg" ready={overview.tools.ffmpeg.ready} />
                <ToolRow name="FFprobe" ready={overview.tools.ffprobe.ready} />
              </article>
            </section>

            <section className="admin-cache-section">
              <div className="admin-section-heading">
                <div><span className="admin-section-label"><HardDrive size={14} /> CACHE & SESSIONS</span><h2>Working memory</h2></div>
                <span className="admin-cache-expiry"><Clock3 size={13} /> NEXT EXPIRY <b>{overview.cache.nextExpiryAt ? formatDate(overview.cache.nextExpiryAt) : 'None scheduled'}</b></span>
              </div>
              <div className="admin-cache-grid">
                <div className="admin-cache-cell"><span className="admin-cache-caption">SUGGESTIONS</span><strong>{overview.cache.suggestionEntries.toLocaleString()}</strong><small>cached entries</small></div>
                <div className="admin-cache-cell"><span className="admin-cache-caption">EXTERNAL AUDIO</span><strong>Disabled</strong><small>Playback uses the YouTube Music scraper only</small></div>
                <div className="admin-cache-cell"><span className="admin-cache-caption">SCRAPER AUDIO</span><strong>{overview.cache.scraperSessionEntries.toLocaleString()}</strong><small>{formatBytes(overview.cache.scraperAudioBytes)} of {formatBytes(overview.cache.scraperAudioMaxBytes)}</small></div>
                <div className="admin-cache-cell"><span className="admin-cache-caption">HLS SESSIONS</span><strong>{overview.cache.hlsSessionEntries.toLocaleString()}</strong><small>{overview.cache.activeHlsSessions} active / {overview.cache.completedHlsSessions} complete / {overview.cache.failedHlsSessions} failed</small></div>
                <div className="admin-cache-cell"><span className="admin-cache-caption">HLS DISK</span><strong>{formatBytes(overview.cache.hlsDiskBytes)}</strong><small>stored media segments</small></div>
              </div>
            </section>
          </>
        )}

        <section className="admin-diagnostics-section">
          <div className="admin-section-heading diagnostics-heading">
            <div><span className="admin-section-label"><Activity size={14} /> SAFE DIAGNOSTICS</span><h2>Recent events <span>{serverDiagnostics.length + safeLocalEvents.length}</span></h2></div>
            <div className="admin-diagnostic-actions">
              <button className="admin-button secondary" type="button" onClick={exportDiagnostics} disabled={!serverDiagnostics.length && !safeLocalEvents.length}>
                <ArrowDownToLine size={15} /> Export safe data
              </button>
              <button className="admin-button danger" type="button" onClick={() => void clearServerDiagnostics()} disabled={clearMutation.isPending || !serverDiagnostics.length}>
                <Trash2 size={14} /> {clearMutation.isPending ? 'Clearing…' : 'Clear server'}
              </button>
              <button className="admin-button danger-outline" type="button" onClick={clearLocalDiagnostics} disabled={!safeLocalEvents.length}>
                <Trash2 size={14} /> Clear this browser
              </button>
            </div>
          </div>
          <p className="admin-privacy-note"><ShieldCheck size={14} /> Local browser events stay in this browser. Server events are shared with the private admin and clear when the API restarts.</p>

          {!overviewQuery.isError && !overviewQuery.isLoading && serverDiagnostics.length === 0 && safeLocalEvents.length === 0 ? (
            <div className="admin-empty-state">
              <span className="admin-empty-glyph"><Activity size={18} /></span>
              <div><strong>No diagnostics to show</strong><p>When something needs attention, a safe event summary will appear here.</p></div>
            </div>
          ) : (
            <div className="admin-diagnostic-list">
              {safeLocalEvents.map((event) => (
                <DiagnosticRow key={`browser-${event.id}`} {...event} local />
              ))}
              {serverDiagnostics.map((event: MusicAdminDiagnostic) => (
                <DiagnosticRow
                  key={`server-${event.id}`}
                  id={event.id}
                  timestamp={event.timestamp}
                  level={isSafeLevel(event.level)}
                  area={event.area}
                  message={event.message}
                />
              ))}
            </div>
          )}
        </section>

        <footer className="admin-footer"><span>LENZO MUSIC / INTERNAL</span><span>OWNER VIEW <span className="admin-footer-separator">·</span> REDACTED DIAGNOSTICS</span></footer>
      </div>
    </main>
  );
}
