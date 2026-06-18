import { useEffect, useState } from 'react';
import { Handle, Position } from '@xyflow/react';
import type { GraphNode } from '../types';
import { FolderIcon, LogIcon, TaskIcon } from './icons';

const STATUS_COLOR: Record<string, string> = {
  running: '#f59e0b',
  waiting: '#3b82f6',
  done: '#10b981',
};

const LEAF_RANK = 4; // themes have 5 tiers (0..4)

type Side = 'top' | 'right' | 'bottom' | 'left';
const POS: Record<Side, Position> = {
  top: Position.Top,
  right: Position.Right,
  bottom: Position.Bottom,
  left: Position.Left,
};

// Track which edge of a node the cursor is nearest, so the ＋ can pop out on that
// side (and connections can be drawn from any side, not only the bottom).
function useHoverSide() {
  const [side, setSide] = useState<Side>('bottom');
  const onMouseMove = (e: React.MouseEvent) => {
    const r = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    const d: Record<Side, number> = { top: y, bottom: r.height - y, left: x, right: r.width - x };
    const nearest = (Object.keys(d) as Side[]).reduce((a, b) => (d[b] < d[a] ? b : a), 'bottom' as Side);
    if (nearest !== side) setSide(nearest);
  };
  return { side, onMouseMove };
}

// A source + target handle on every side, so an edge can attach to whichever side
// faces its neighbor (layout picks the handle ids by geometry) and the user can
// draw a connection from any side.
const SIDES: Side[] = ['top', 'right', 'bottom', 'left'];
function SideHandles() {
  return (
    <>
      {SIDES.map((s) => (
        <span key={s}>
          <Handle id={`t-${s}`} type="target" position={POS[s]} />
          <Handle id={`s-${s}`} type="source" position={POS[s]} />
        </span>
      ))}
    </>
  );
}

export interface NodeData {
  node: GraphNode;
  onSpawn?: (n: GraphNode) => void;
  onTerminal?: (n: GraphNode) => void;
  onRename?: (id: string, title: string) => void;
  onSetName?: (id: string, name: string) => void;
  onSpawnSide?: (n: GraphNode, side: Side) => void; // spawn a sub-agent off the clicked side
  onPick?: (n: GraphNode, kind: PickKind, side: Side, name?: string) => void; // + picker
  onEdit?: (id: string, patch: { title?: string; name?: string; color?: string }) => void; // edit name/color
  roleLabel?: string; // positional label ("Main Agent" / "Sub Agent 1a")
  chatActive?: boolean; // this agent's chat is the open main chat (green)
  chatOpen?: boolean; // this agent's chat is open as a secondary panel (blue)
}

export type PickKind = 'agent' | 'log' | 'dir-attach' | 'dir-new';

// The "+" popover. On a directory: Agent / Log. On an agent: Sub-agent / Attach
// folder / New folder / Log (folders & logs attach to that agent as grants).
function PickerMenu({
  node,
  variant,
  side = 'bottom',
  canSubAgent = true,
  onPick,
  onSubAgent,
}: {
  node: GraphNode;
  variant: 'directory' | 'agent';
  side?: Side;
  canSubAgent?: boolean;
  onPick?: (n: GraphNode, kind: PickKind, side: Side, name?: string) => void;
  onSubAgent?: (n: GraphNode, side: Side) => void;
}) {
  const [open, setOpen] = useState(false);
  const [naming, setNaming] = useState<null | 'log' | 'dir-new'>(null);
  const [val, setVal] = useState('');
  const close = () => {
    setOpen(false);
    setNaming(null);
    setVal('');
  };
  const submit = () => {
    const t = val.trim();
    if (!t || !naming) return;
    onPick?.(node, naming, side, t);
    close();
  };
  return (
    <div className={`picker-wrap side-${side}`}>
      <button
        className="spawn-btn"
        title="Add"
        onClick={(e) => {
          e.stopPropagation();
          open ? close() : setOpen(true);
        }}
      >
        ＋
      </button>
      {open && (
        <div className="picker-menu" onMouseDown={(e) => e.stopPropagation()}>
          {naming ? (
            <input
              className="picker-name"
              autoFocus
              placeholder={naming === 'log' ? 'Log name (e.g. Risk Scoring Review)' : 'New folder name'}
              value={val}
              onChange={(e) => setVal(e.target.value)}
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submit();
                if (e.key === 'Escape') close();
              }}
            />
          ) : variant === 'directory' ? (
            <>
              <button onClick={(e) => { e.stopPropagation(); onPick?.(node, 'agent', side); close(); }}>⬡ Agent</button>
              <button onClick={(e) => { e.stopPropagation(); setNaming('log'); }}><LogIcon size="1.05em" /> Log…</button>
              <button className="picker-soon" disabled>＋ More soon</button>
            </>
          ) : (
            <>
              {canSubAgent && <button onClick={(e) => { e.stopPropagation(); onSubAgent?.(node, side); close(); }}>⬡ Sub-agent</button>}
              <button onClick={(e) => { e.stopPropagation(); onPick?.(node, 'dir-attach', side); close(); }}><FolderIcon size="1.05em" /> Attach folder…</button>
              <button onClick={(e) => { e.stopPropagation(); setNaming('dir-new'); }}><FolderIcon size="1.05em" /> New folder…</button>
              <button onClick={(e) => { e.stopPropagation(); setNaming('log'); }}><LogIcon size="1.05em" /> Log…</button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// Theme-matched node colors for the Edit popover.
const SWATCHES = ['#2b3550', '#3b5b8c', '#1f6f5c', '#5a4a8c', '#8c6a2b', '#8c3b4a', '#3a4150'];

// Per-node Edit control: a pencil button → popover to rename and recolor the box.
function EditControl({ node, onEdit }: { node: GraphNode; onEdit?: (id: string, patch: { title?: string; name?: string; color?: string }) => void }) {
  const [open, setOpen] = useState(false);
  const isAgent = node.type === 'agent';
  const [label, setLabel] = useState(isAgent ? node.name ?? '' : node.title);
  useEffect(() => setLabel(isAgent ? node.name ?? '' : node.title), [node.name, node.title, isAgent]);
  const saveLabel = () => onEdit?.(node.id, isAgent ? { name: label.trim() } : { title: label.trim() });
  return (
    <>
      <button className="edit-btn" title="Edit name & color" onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }}>
        ✎
      </button>
      {open && (
        <div className="edit-pop" onMouseDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}>
          <input
            className="edit-title"
            autoFocus
            placeholder={isAgent ? 'Agent name' : 'Title'}
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { saveLabel(); setOpen(false); }
              if (e.key === 'Escape') setOpen(false);
            }}
          />
          <div className="edit-swatches">
            {SWATCHES.map((c) => (
              <button key={c} className={`swatch${node.color === c ? ' on' : ''}`} style={{ background: c }} title={c} onClick={(e) => { e.stopPropagation(); onEdit?.(node.id, { color: c }); }} />
            ))}
            <button className={`swatch clear${!node.color ? ' on' : ''}`} title="Default color" onClick={(e) => { e.stopPropagation(); onEdit?.(node.id, { color: '' }); }}>
              ↺
            </button>
          </div>
          <div className="edit-actions">
            <button onClick={(e) => { e.stopPropagation(); saveLabel(); setOpen(false); }}>Save</button>
          </div>
        </div>
      )}
    </>
  );
}

// Click-to-edit custom name for an agent (shown after the role as "Role: Name").
// Empty shows a faint "+ name" affordance.
function EditableName({ node, onSetName }: { node: GraphNode; onSetName?: (id: string, name: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(node.name ?? '');
  useEffect(() => setVal(node.name ?? ''), [node.name]);

  const commit = () => {
    setEditing(false);
    const t = val.trim();
    if (t !== (node.name ?? '')) onSetName?.(node.id, t);
  };

  if (editing) {
    return (
      <input
        className="node-edit name"
        value={val}
        autoFocus
        placeholder="name…"
        onChange={(e) => setVal(e.target.value)}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit();
          if (e.key === 'Escape') {
            setVal(node.name ?? '');
            setEditing(false);
          }
        }}
      />
    );
  }
  return (
    <span
      className={node.name ? 'agent-name' : 'agent-name empty'}
      title="Click to name this agent"
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        setEditing(true);
      }}
    >
      {node.name ? `: ${node.name}` : '＋ name'}
    </span>
  );
}

// Click-to-edit title used by task nodes. Stops propagation so editing doesn't
// trigger React Flow drag/select.
function EditableTitle({ node, onRename, className }: { node: GraphNode; onRename?: (id: string, title: string) => void; className: string }) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(node.title);
  useEffect(() => setVal(node.title), [node.title]);

  const commit = () => {
    setEditing(false);
    const t = val.trim();
    if (t && t !== node.title) onRename?.(node.id, t);
    else setVal(node.title);
  };

  if (editing) {
    return (
      <input
        className="node-edit"
        value={val}
        autoFocus
        onChange={(e) => setVal(e.target.value)}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit();
          if (e.key === 'Escape') {
            setVal(node.title);
            setEditing(false);
          }
        }}
      />
    );
  }
  return (
    <span
      className={className}
      title="Click to edit"
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        setEditing(true);
      }}
    >
      {node.title}
    </span>
  );
}

function SpawnButton({ title, onClick, side = 'bottom' }: { title: string; onClick: (e: React.MouseEvent) => void; side?: Side }) {
  return (
    <button className={`spawn-btn side-${side}`} title={title} onClick={onClick}>
      ＋
    </button>
  );
}

export function AgentNode({ data }: { data: NodeData }) {
  const n = data.node;
  const canSpawn = n.rank != null && n.rank < LEAF_RANK;
  const live = !!n.sessionId && !n.sessionId.startsWith('mock-');
  const chatClass = data.chatActive ? ' chat-active' : data.chatOpen ? ' chat-open' : '';
  const { side, onMouseMove } = useHoverSide();
  return (
    <div className={`node agent${chatClass}`} onMouseMove={onMouseMove} style={n.color ? { background: n.color } : undefined}>
      <SideHandles />
      {live && (
        <button
          className="term-btn"
          title="Open this agent in a terminal (claude --resume)"
          onClick={(e) => {
            e.stopPropagation();
            data.onTerminal?.(n);
          }}
        >
          ⌬
        </button>
      )}
      <EditControl node={n} onEdit={data.onEdit} />
      <PickerMenu node={n} variant="agent" side={side} canSubAgent={canSpawn} onPick={data.onPick} onSubAgent={data.onSpawnSide} />
      <div className="node-head">
        <span className="dot" style={{ background: STATUS_COLOR[n.status] ?? '#999' }} />
        <span className="role">{data.roleLabel ?? n.title}</span>
        <EditableName node={n} onSetName={data.onSetName} />
      </div>
      <div className="node-sub">{n.status}</div>
    </div>
  );
}

export function TaskNode({ data }: { data: NodeData }) {
  const n = data.node;
  const { side, onMouseMove } = useHoverSide();
  return (
    <div className="node task" onMouseMove={onMouseMove} style={n.color ? { background: n.color } : undefined}>
      <SideHandles />
      <EditControl node={n} onEdit={data.onEdit} />
      <SpawnButton
        title="Add another agent to this project"
        side={side}
        onClick={(e) => {
          e.stopPropagation();
          data.onSpawnSide?.(n, side);
        }}
      />
      <div className="node-head">
        <span className="task-ico"><TaskIcon /></span>
        <EditableTitle node={n} onRename={data.onRename} className="ttitle" />
      </div>
    </div>
  );
}

// The project directory — the root unit of a lab. Its "+" opens a typed picker
// (Agent / Log / …). Shows the folder name + path.
export function DirectoryNode({ data }: { data: NodeData }) {
  const n = data.node;
  const { side, onMouseMove } = useHoverSide();
  return (
    <div className="node directory" onMouseMove={onMouseMove} style={n.color ? { background: n.color } : undefined}>
      <SideHandles />
      <EditControl node={n} onEdit={data.onEdit} />
      <PickerMenu node={n} variant="directory" side={side} onPick={data.onPick} />
      <div className="node-head">
        <span className="dir-ico"><FolderIcon /></span>
        <span className="role">{n.title}</span>
      </div>
      <div className="node-sub mono">{n.path || 'no folder set'}</div>
    </div>
  );
}

// A shared markdown findings log living in the project folder (fed to read_log).
export function LogNode({ data }: { data: NodeData }) {
  const n = data.node;
  const { onMouseMove } = useHoverSide();
  return (
    <div className="node log" onMouseMove={onMouseMove} style={n.color ? { background: n.color } : undefined}>
      <SideHandles />
      <EditControl node={n} onEdit={data.onEdit} />
      <div className="node-head">
        <span className="log-ico"><LogIcon /></span>
        <span className="role">{n.title}</span>
      </div>
      <div className="node-sub">shared log</div>
    </div>
  );
}
