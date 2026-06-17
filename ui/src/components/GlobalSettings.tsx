import { useEffect, useState } from 'react';
import { getAppSettings, getThemes, saveAppSettings } from '../api';
import {
  EFFORT_OPTIONS,
  MODEL_OPTIONS,
  PERMISSION_OPTIONS,
  type RoleSetting,
  type ThemeInfo,
} from '../types';

// App-wide defaults for new labs: the hierarchy + the Claude settings
// (model / effort / permission) each role spawns with. Per-lab ⚙ can override.
export function GlobalSettings({ onClose }: { onClose: () => void }) {
  const [themes, setThemes] = useState<ThemeInfo[]>([]);
  const [theme, setTheme] = useState('research');
  const [rows, setRows] = useState<RoleSetting[]>([]);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    Promise.all([getThemes(), getAppSettings()]).then(([ts, s]) => {
      setThemes(ts);
      setTheme(s.defaultTheme);
      setRows(s.defaultPresets);
    });
  }, []);

  const sel = themes.find((t) => t.id === theme);
  const update = (i: number, key: keyof RoleSetting, val: string) => {
    setRows((r) => r.map((s, idx) => (idx === i ? { ...s, [key]: val } : s)));
    setSaved(false);
  };
  const save = async () => {
    setSaving(true);
    await saveAppSettings({ defaultTheme: theme, defaultPresets: rows });
    setSaving(false);
    setSaved(true);
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span>⚙ Settings — defaults for new labs</span>
          <button onClick={onClose}>✕</button>
        </div>
        <div className="modal-sub">
          The hierarchy and Claude settings every new lab starts with. A specific lab’s ⚙ can still override these.
        </div>

        <div className="newlab">
          <label>
            Default hierarchy
            <select
              value={theme}
              onChange={(e) => {
                setTheme(e.target.value);
                setSaved(false);
              }}
            >
              {themes.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name} ({t.container})
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="settings-table">
          <div className="st-row st-head">
            <span>Role</span>
            <span>Model</span>
            <span>Effort</span>
            <span>Permission</span>
          </div>
          {sel?.roles.map((title, i) => (
            <div className="st-row" key={i}>
              <span className="st-role">
                <span className="rank">{i === 0 ? '★ lead' : `#${i + 1}`}</span>
                {title}
              </span>
              <select value={rows[i]?.model} onChange={(e) => update(i, 'model', e.target.value)}>
                {MODEL_OPTIONS.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
              <select value={rows[i]?.effort} onChange={(e) => update(i, 'effort', e.target.value)}>
                {EFFORT_OPTIONS.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
              <select value={rows[i]?.permissionMode} onChange={(e) => update(i, 'permissionMode', e.target.value)}>
                {PERMISSION_OPTIONS.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </div>
          ))}
        </div>

        <div className="modal-foot">
          {saved && <span className="saved">Saved ✓</span>}
          <button className="primary" onClick={save} disabled={saving}>
            {saving ? 'Saving…' : 'Save defaults'}
          </button>
        </div>
      </div>
    </div>
  );
}
