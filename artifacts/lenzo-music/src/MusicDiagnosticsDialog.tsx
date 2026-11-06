import { useEffect, useState } from 'react';
import { Bug, Clipboard, Download, Trash2, X } from 'lucide-react';
import {
  clearMusicDiagnosticEvents,
  getMusicDiagnosticEvents,
  subscribeMusicDiagnostics,
  type MusicDiagnosticEvent,
} from './musicDiagnostics';

function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

export function MusicDiagnosticsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [events, setEvents] = useState<MusicDiagnosticEvent[]>(getMusicDiagnosticEvents);
  const [copyMessage, setCopyMessage] = useState('');

  useEffect(() => {
    if (!open) return;
    setEvents(getMusicDiagnosticEvents());
    return subscribeMusicDiagnostics(() => setEvents(getMusicDiagnosticEvents()));
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  const report = JSON.stringify({
    app: 'Lenzo Music',
    exportedAt: new Date().toISOString(),
    eventCount: events.length,
    events,
  }, null, 2);
  const errors = events.filter((event) => event.level === 'error').length;
  const warnings = events.filter((event) => event.level === 'warning').length;

  const copyReport = async () => {
    try {
      await navigator.clipboard.writeText(report);
      setCopyMessage('Report copied.');
    } catch {
      setCopyMessage('Copy was blocked by the browser. Download the report instead.');
    }
  };

  const downloadReport = () => {
    const blob = new Blob([report], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `lenzo-music-diagnostics-${new Date().toISOString().slice(0, 10)}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  return <div className="fixed inset-0 z-[70] flex items-end justify-center bg-black/75 p-0 backdrop-blur-sm sm:items-center sm:p-5" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section role="dialog" aria-modal="true" aria-labelledby="music-diagnostics-title" data-testid="panel-music-diagnostics" className="flex max-h-[92dvh] w-full max-w-2xl flex-col overflow-hidden rounded-t-2xl border border-white/10 bg-[#141619] shadow-2xl sm:rounded-2xl">
      <header className="flex items-start justify-between gap-4 border-b border-white/[.08] px-5 py-4 sm:px-6">
        <div className="flex items-center gap-3">
          <span className="grid h-10 w-10 place-items-center rounded-xl bg-lime-300/10 text-lime-200"><Bug size={20} /></span>
          <div><h2 id="music-diagnostics-title" className="font-display text-lg font-bold">Music diagnostics</h2><p className="mt-1 text-[11px] text-white/55">{events.length} events · {errors} errors · {warnings} warnings</p></div>
        </div>
        <button type="button" onClick={onClose} aria-label="Close diagnostics" className="grid h-9 w-9 place-items-center rounded-full text-white/65 hover:bg-white/10"><X size={18} /></button>
      </header>
      <div className="border-b border-white/[.07] bg-white/[.025] px-5 py-3 text-[11px] leading-relaxed text-white/60 sm:px-6">
        Logs stay in this browser. They include search terms and track names; stream URLs and credential-like values are redacted. Export this report and attach it when asking for help.
      </div>
      <div className="flex flex-wrap items-center gap-2 border-b border-white/[.07] px-5 py-3 sm:px-6">
        <button type="button" onClick={() => void copyReport()} className="inline-flex items-center gap-2 rounded-full bg-white/10 px-3 py-2 text-[11px] font-semibold hover:bg-white/15"><Clipboard size={14} /> Copy report</button>
        <button type="button" onClick={downloadReport} className="inline-flex items-center gap-2 rounded-full bg-lime-300 px-3 py-2 text-[11px] font-bold text-[#171912] hover:bg-lime-200"><Download size={14} /> Download JSON</button>
        <button type="button" onClick={() => { clearMusicDiagnosticEvents(); setCopyMessage(''); }} disabled={!events.length} className="inline-flex items-center gap-2 rounded-full px-3 py-2 text-[11px] font-semibold text-white/55 hover:bg-white/10 disabled:opacity-35"><Trash2 size={14} /> Clear</button>
        {copyMessage && <span role="status" className="text-[10px] text-lime-200">{copyMessage}</span>}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4 sm:px-6">
        {!events.length ? <div className="grid min-h-40 place-items-center text-center"><div><Bug className="mx-auto text-white/25" size={26} /><p className="mt-3 text-sm font-semibold">No activity recorded yet</p><p className="mt-1 max-w-sm text-[11px] leading-relaxed text-white/50">Search and playback requests, retries, and errors will appear here.</p></div></div> :
          <ol className="space-y-2">
            {events.map((event) => <li key={event.id} data-testid={`diagnostic-event-${event.level}`} className="rounded-xl border border-white/[.07] bg-black/15 p-3">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className={`rounded-full px-2 py-0.5 text-[9px] font-bold uppercase tracking-wide ${event.level === 'error' ? 'bg-red-300/10 text-red-200' : event.level === 'warning' ? 'bg-amber-200/10 text-amber-100' : 'bg-white/10 text-white/55'}`}>{event.level}</span>
                <span className="text-[10px] font-semibold text-lime-100/80">{event.area}</span>
                <time className="ml-auto text-[9px] text-white/40">{formatTime(event.time)}</time>
              </div>
              <p className="mt-2 break-words text-[11px] leading-relaxed text-white/80">{event.message}</p>
              {event.details && <details className="mt-2 text-[10px] text-white/55"><summary className="cursor-pointer select-none">Details</summary><pre className="mt-2 whitespace-pre-wrap break-words rounded-lg bg-black/25 p-2">{JSON.stringify(event.details, null, 2)}</pre></details>}
            </li>)}
          </ol>}
      </div>
    </section>
  </div>;
}
