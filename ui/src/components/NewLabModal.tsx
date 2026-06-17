import { useState } from 'react';
import { canPickFolder, createLab, pickFolder } from '../api';

// Create a new lab: name + charge + working directory. The hierarchy and Claude
// settings come from the global defaults (Settings menu) — no per-lab picker.
export function NewLabModal({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const [name, setName] = useState('');
  const [task, setTask] = useState('');
  const [cwd, setCwd] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const create = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    setError('');
    try {
      const { id } = await createLab(name.trim(), {
        cwd: cwd.trim() || undefined,
        charge: task.trim() || undefined,
      });
      onCreated(id);
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e) || 'Could not create lab (check the working directory).');
      setBusy(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span>＋ New Lab</span>
          <button onClick={onClose}>✕</button>
        </div>
        <div className="newlab">
          <label>
            Name
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Q3 Growth Plan" autoFocus />
          </label>
          <label>
            Charge / task
            <textarea
              value={task}
              onChange={(e) => setTask(e.target.value)}
              rows={3}
              placeholder="What should the lead tackle? (optional)"
            />
          </label>
          <label>
            Working directory (repo / folder) — optional
            <div className="dir-row">
              <input value={cwd} onChange={(e) => setCwd(e.target.value)} placeholder="/Users/you/path/to/repo" />
              {canPickFolder() && (
                <button
                  type="button"
                  className="dir-btn"
                  onClick={async () => {
                    const p = await pickFolder();
                    if (p) setCwd(p);
                  }}
                >
                  Choose…
                </button>
              )}
            </div>
          </label>
          <div className="newlab-hint">Hierarchy &amp; Claude settings come from Settings (⌘,). </div>
          {error && <div className="newlab-error">{error}</div>}
        </div>
        <div className="modal-foot">
          <button className="primary" disabled={!name.trim() || busy} onClick={create}>
            {busy ? 'Deploying…' : 'Deploy Lab'}
          </button>
        </div>
      </div>
    </div>
  );
}
