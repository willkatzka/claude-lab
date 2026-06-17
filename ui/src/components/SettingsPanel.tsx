import { useEffect, useState } from 'react';
import { deleteLab, getSettings, getThemes, saveSettings, setLabTheme } from '../api';
import {
  EFFORT_OPTIONS,
  MODEL_OPTIONS,
  PERMISSION_OPTIONS,
  type LabSettings,
  type RoleSetting,
  type ThemeInfo,
} from '../types';

// Per-lab, per-role presets. Each lab (organization) configures its 5 roles
// with their own model / effort / permission — bespoke per lab.
export function SettingsPanel({
  labId,
  labName,
  onClose,
  onDeleted,
}: {
  labId: string;
  labName: string;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const [data, setData] = useState<LabSettings | null>(null);
  const [rows, setRows] = useState<RoleSetting[]>([]);
  const [themes, setThemes] = useState<ThemeInfo[]>([]);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    getSettings(labId).then((d) => {
      setData(d);
      setRows(d.roleSettings);
    });
  }, [labId]);
  useEffect(() => {
    getThemes().then(setThemes).catch(() => {});
  }, []);

  // Switch this lab's hierarchy — relabels existing agents to the new roles.
  const changeTheme = async (theme: string) => {
    await setLabTheme(labId, theme);
    const d = await getSettings(labId);
    setData(d);
    setRows(d.roleSettings);
  };

  const update = (i: number, key: keyof RoleSetting, val: string) => {
    setRows((r) => r.map((s, idx) => (idx === i ? { ...s, [key]: val } : s)));
    setSaved(false);
  };

  const save = async () => {
    setSaving(true);
    await saveSettings(labId, rows);
    setSaving(false);
    setSaved(true);
  };

  const remove = async () => {
    if (!window.confirm(`Delete “${labName}”? This removes the lab, its graph, and its audit log. (Underlying Claude sessions are kept.)`)) {
      return;
    }
    await deleteLab(labId);
    onDeleted();
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span>
            ⚙ Settings — {labName} <span className="muted">({data?.themeName})</span>
          </span>
          <button onClick={onClose}>✕</button>
        </div>
        <div className="modal-sub">
          Per-role presets for this {data?.container?.toLowerCase() ?? 'lab'}. Each role spawns with its own
          model, reasoning effort, and permission level — set them however this {data?.container?.toLowerCase() ?? 'lab'} needs.
        </div>
        {data && themes.length > 0 && (
          <div className="settings-hierarchy">
            <span>Hierarchy</span>
            <select value={data.theme} onChange={(e) => changeTheme(e.target.value)}>
              {themes.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
            <span className="muted">changing this relabels the roles below</span>
          </div>
        )}

        {!data ? (
          <div className="modal-loading">Loading…</div>
        ) : (
          <div className="settings-table">
            <div className="st-row st-head">
              <span>Role</span>
              <span>Model</span>
              <span>Effort</span>
              <span>Permission</span>
            </div>
            {data.roles.map((title, i) => (
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
                <select
                  value={rows[i]?.permissionMode}
                  onChange={(e) => update(i, 'permissionMode', e.target.value)}
                >
                  {PERMISSION_OPTIONS.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              </div>
            ))}
          </div>
        )}

        <div className="modal-foot">
          <button className="danger" onClick={remove}>
            Delete lab
          </button>
          <span className="foot-spacer" />
          {saved && <span className="saved">Saved ✓</span>}
          <button className="primary" onClick={save} disabled={saving || !data}>
            {saving ? 'Saving…' : 'Save presets'}
          </button>
        </div>
      </div>
    </div>
  );
}
