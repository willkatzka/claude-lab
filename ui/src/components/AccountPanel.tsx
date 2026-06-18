import { useEffect, useState } from 'react';
import { getAccount } from '../api';
import type { AccountData, RateWindow } from '../types';

function resetLabel(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function Limit({ label, w }: { label: string; w?: RateWindow | null }) {
  if (!w) return null;
  const v = Math.max(0, Math.min(100, w.utilization ?? 0));
  return (
    <div className="limit">
      <div className="limit-head">
        <span>{label}</span>
        <span className="muted">
          {v}% · resets {resetLabel(w.resets_at)}
        </span>
      </div>
      <div className="limit-bar">
        <div className="limit-fill" style={{ width: `${v}%` }} />
      </div>
    </div>
  );
}

// Account + plan-usage panel (mirrors the Claude Code /usage view), so you
// always know which account is running and how much headroom remains.
export function AccountPanel() {
  const [data, setData] = useState<AccountData | null>(null);
  useEffect(() => {
    let on = true;
    const load = () =>
      getAccount()
        .then((d) => on && setData(d))
        .catch(() => {});
    load();
    // Poll so the usage meters stay live as quota is consumed. The bridge caches
    // for 30s, so 60s keeps it fresh without an extra ping query every refresh.
    const id = setInterval(load, 60_000);
    return () => {
      on = false;
      clearInterval(id);
    };
  }, []);

  if (!data) return <div className="account muted">…account</div>;
  const { account: a, usage: u } = data;
  const rl = u?.rate_limits;
  return (
    <div className="account">
      <div className="acc-id">
        <span className="acc-email" title={`${a.organization ?? ''}`}>
          {a.email ?? 'unknown account'}
        </span>
        {a.subscriptionType && <span className="acc-sub">{a.subscriptionType}</span>}
      </div>
      {u?.rate_limits_available && rl ? (
        <>
          <Limit label="5-hour limit" w={rl.five_hour} />
          <Limit label="Weekly · all models" w={rl.seven_day} />
        </>
      ) : (
        <div className="acc-note">Plan limits unavailable (API key / 3P provider)</div>
      )}
    </div>
  );
}
