import { useEffect, useRef, useState } from 'react';
import { getAudit } from '../api';
import type { AuditEvent } from '../types';
import { LogIcon } from './icons';

const COLOR: Record<string, string> = {
  spawn: '#6ea8fe',
  delegate: '#f59e0b',
  finding: '#10b981',
  tool: '#c084fc',
  message: '#e6e8ec',
  terminal: '#9aa3b2',
};

function detail(e: AuditEvent): string {
  switch (e.type) {
    case 'spawn':
      return `spawned · ${e.model}/${e.effort}/${e.permission} · on “${e.task ?? ''}”`;
    case 'delegate':
      return `delegated: ${(e.brief ?? '').slice(0, 160)}`;
    case 'finding':
      return (e.text ?? '').slice(0, 500) || '(no finding text)';
    case 'tool':
      return `${e.tool}${e.target ? ' → ' + e.target : ''}`;
    case 'message':
      return `“${(e.text ?? '').slice(0, 120)}” → ${(e.reply ?? '').slice(0, 200)}`;
    case 'terminal':
      return 'opened in terminal (claude --resume)';
    default:
      return JSON.stringify(e);
  }
}

function time(ts?: string): string {
  if (!ts) return '';
  try {
    return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch {
    return ts;
  }
}

// Live audit / findings log for a lab: every agent's findings + a trail of
// who did what, where, and which files/tools they touched.
export function AuditPanel({ labId, labName, onClose }: { labId: string; labName: string; onClose: () => void }) {
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [findingsOnly, setFindingsOnly] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let on = true;
    const tick = () =>
      getAudit(labId)
        .then((e) => on && setEvents(e))
        .catch(() => {});
    tick();
    const iv = setInterval(tick, 2000); // live-refresh while a run is in progress
    return () => {
      on = false;
      clearInterval(iv);
    };
  }, [labId]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [events]);

  const shown = findingsOnly ? events.filter((e) => e.type === 'finding') : events;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal audit" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span>
            <LogIcon size="1.1em" /> {labName} — activity &amp; findings <span className="muted">({shown.length})</span>
          </span>
          <button onClick={onClose}>✕</button>
        </div>
        <div className="audit-explain">
          A timeline of everything the agents <strong>in this lab</strong> have done and found — the shared log they read
          to catch up on each other. Each lab has its own.
          <button className={`audit-toggle ${findingsOnly ? 'on' : ''}`} onClick={() => setFindingsOnly((v) => !v)}>
            {findingsOnly ? '✓ Findings only' : 'Findings only'}
          </button>
        </div>
        <div className="audit-list" ref={scrollRef}>
          {shown.length === 0 && (
            <div className="audit-empty">
              {findingsOnly ? 'No findings reported yet.' : 'No activity yet — message an agent to populate the log.'}
            </div>
          )}
          {shown.map((e, i) => (
            <div className="audit-row" key={i}>
              <span className="audit-time">{time(e.ts)}</span>
              <span className="audit-badge" style={{ color: COLOR[e.type] ?? '#9aa3b2', borderColor: COLOR[e.type] ?? '#9aa3b2' }}>
                {e.type}
              </span>
              <span className="audit-role">{e.role ?? e.agentId ?? ''}</span>
              <span className="audit-detail">{detail(e)}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
