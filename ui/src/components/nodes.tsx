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

export interface NodeData {
  node: GraphNode;
  onSpawn?: (n: GraphNode) => void;
  onTerminal?: (n: GraphNode) => void;
  onRename?: (id: string, title: string) => void;
  onSetName?: (id: string, name: string) => void;
  onPick?: (n: GraphNode, kind: 'agent' | 'log') => void; // directory + picker
  roleLabel?: string; // positional label ("Main Agent" / "Sub Agent 1a")
  chatActive?: boolean; // this agent's chat is the open main chat (green)
  chatOpen?: boolean; // this agent's chat is open as a secondary panel (blue)
}

// The directory "+" : a small popover to add a typed child (Agent / Log / …).
function PickerMenu({ node, onPick }: { node: GraphNode; onPick?: (n: GraphNode, kind: 'agent' | 'log') => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="picker-wrap">
      <button
        className="spawn-btn"
        title="Add to this directory"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
        }}
      >
        ＋
      </button>
      {open && (
        <div className="picker-menu" onMouseDown={(e) => e.stopPropagation()}>
          <button
            onClick={(e) => {
              e.stopPropagation();
              setOpen(false);
              onPick?.(node, 'agent');
            }}
          >
            ⬡ Agent
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              setOpen(false);
              onPick?.(node, 'log');
            }}
          >
            <LogIcon size="1.05em" /> Log
          </button>
          <button className="picker-soon" disabled>
            ＋ More soon
          </button>
        </div>
      )}
    </div>
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

function SpawnButton({ title, onClick }: { title: string; onClick: (e: React.MouseEvent) => void }) {
  return (
    <button className="spawn-btn" title={title} onClick={onClick}>
      ＋
    </button>
  );
}

export function AgentNode({ data }: { data: NodeData }) {
  const n = data.node;
  const canSpawn = n.rank != null && n.rank < LEAF_RANK;
  const live = !!n.sessionId && !n.sessionId.startsWith('mock-');
  const chatClass = data.chatActive ? ' chat-active' : data.chatOpen ? ' chat-open' : '';
  return (
    <div className={`node agent${chatClass}`}>
      <Handle type="target" position={Position.Top} />
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
      {canSpawn && (
        <SpawnButton
          title="Spawn an agent below this one"
          onClick={(e) => {
            e.stopPropagation();
            data.onSpawn?.(n);
          }}
        />
      )}
      <div className="node-head">
        <span className="dot" style={{ background: STATUS_COLOR[n.status] ?? '#999' }} />
        <span className="role">{data.roleLabel ?? n.title}</span>
        <EditableName node={n} onSetName={data.onSetName} />
      </div>
      <div className="node-sub">{n.status}</div>
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}

export function TaskNode({ data }: { data: NodeData }) {
  const n = data.node;
  return (
    <div className="node task">
      <Handle type="target" position={Position.Top} />
      <SpawnButton
        title="Add another agent to this project"
        onClick={(e) => {
          e.stopPropagation();
          data.onSpawn?.(n);
        }}
      />
      <div className="node-head">
        <span className="task-ico"><TaskIcon /></span>
        <EditableTitle node={n} onRename={data.onRename} className="ttitle" />
      </div>
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}

// The project directory — the root unit of a lab. Its "+" opens a typed picker
// (Agent / Log / …). Shows the folder name + path.
export function DirectoryNode({ data }: { data: NodeData }) {
  const n = data.node;
  return (
    <div className="node directory">
      <PickerMenu node={n} onPick={data.onPick} />
      <div className="node-head">
        <span className="dir-ico"><FolderIcon /></span>
        <span className="role">{n.title}</span>
      </div>
      <div className="node-sub mono">{n.path || 'no folder set'}</div>
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}

// A shared markdown findings log living in the project folder (fed to read_log).
export function LogNode({ data }: { data: NodeData }) {
  const n = data.node;
  return (
    <div className="node log">
      <Handle type="target" position={Position.Top} />
      <div className="node-head">
        <span className="log-ico"><LogIcon /></span>
        <span className="role">{n.title}</span>
      </div>
      <div className="node-sub">shared log</div>
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}
