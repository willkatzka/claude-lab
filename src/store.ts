// The shared graph data model (from the project brief). The eventual React Flow
// UI consumes exactly this shape. Persisted to data/graph.json after every
// mutation so the graph survives a crash/restart.

import { writeFileSync, readFileSync, mkdirSync, existsSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';

// Atomic graph write: serialize to a unique temp file, then rename over the
// target. rename(2) is atomic on the same filesystem, so a concurrent reader
// always sees either the complete old file or the complete new one — never a
// truncated/empty file. (writeFileSync truncates-then-writes, which a reader in
// another process can catch mid-write and mis-read as corrupt → data loss.)
let writeSeq = 0;
export function atomicWriteJSON(file: string, data: unknown): void {
  const dir = dirname(file);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${++writeSeq}`;
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, file);
}

// Read + parse a graph file, retrying a few times on a transient parse failure
// (e.g. a read that raced a non-atomic write). If it still won't parse, THROW —
// callers must abort their mutation rather than overwrite good data with empty.
export function readGraphFile(file: string): { nodes?: GraphNode[]; edges?: Edge[] } {
  let lastErr: unknown;
  for (let i = 0; i < 4; i++) {
    try {
      const raw = readFileSync(file, 'utf8');
      if (raw.trim()) return JSON.parse(raw);
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(`graph file unreadable (${file}): ${lastErr instanceof Error ? lastErr.message : 'empty'}`);
}

// 'directory' is the root unit (the lab's working folder); 'log' is a shared
// markdown findings file living in that folder; 'agent' and 'task' as before.
export type NodeType = 'agent' | 'task' | 'directory' | 'log';
export type Status = 'running' | 'waiting' | 'done';
// 'access' = a manual grant: a directory or log connected to an agent, giving
// that agent filesystem access to the folder / read access to the log.
export type EdgeKind = 'delegates' | 'assigned' | 'access';

export interface GraphNode {
  id: string;
  type: NodeType;
  title: string; // a few words
  description: string; // short brief
  status: Status;
  sessionId: string | null; // agent nodes only; the resumable Claude session
  role?: string; // agent nodes: theme role id, e.g. "baseball:0"
  rank?: number; // agent nodes: 0 = lead (top of hierarchy)
  result?: string; // agent nodes: final text produced
  model?: string; // agent nodes: per-agent model override (else the role's default)
  effort?: string; // agent nodes: per-agent effort override (else the role's default)
  permission?: string; // agent nodes: per-agent permission override (else the role's default)
  name?: string; // agent nodes: a custom label shown after the role ("Role: Name")
  path?: string; // directory: folder path; log: markdown file path
  color?: string; // optional custom accent color (hex) for the node box
}

export interface Edge {
  from: string; // delegator (agent) or task
  to: string; // delegate (agent) or task
  kind: EdgeKind; // "delegates" (agent→task) | "assigned" (task→agent)
}

export class Store {
  nodes: GraphNode[] = [];
  edges: Edge[] = [];
  private seq = 0;

  constructor(private file = join(process.cwd(), 'data', 'graph.json')) {}

  // Hydrate from an existing graph file so new nodes can be appended (continuing
  // the id sequence) — used for interactive delegation from the UI.
  static open(file: string): Store {
    const s = new Store(file);
    if (existsSync(file)) {
      const g = readGraphFile(file); // throws on unreadable — never silently empties
      s.nodes = g.nodes ?? [];
      s.edges = g.edges ?? [];
      s.seq = s.nodes.reduce(
        (m, n) => Math.max(m, parseInt(String(n.id).split('-')[1] ?? '0', 10) || 0),
        0,
      );
    }
    return s;
  }

  private id(prefix: string) {
    return `${prefix}-${++this.seq}`;
  }

  addAgent(role: string, title: string, description: string, rank: number): GraphNode {
    const n: GraphNode = {
      id: this.id('agent'),
      type: 'agent',
      title,
      description,
      status: 'running',
      sessionId: null,
      role,
      rank,
    };
    this.nodes.push(n);
    this.persist();
    return n;
  }

  addTask(title: string, description: string): GraphNode {
    const n: GraphNode = {
      id: this.id('task'),
      type: 'task',
      title,
      description,
      status: 'running',
      sessionId: null,
    };
    this.nodes.push(n);
    this.persist();
    return n;
  }

  // The root unit: the lab's working folder.
  addDirectory(title: string, description: string, path: string): GraphNode {
    const n: GraphNode = { id: this.id('dir'), type: 'directory', title, description, status: 'waiting', sessionId: null, path };
    this.nodes.push(n);
    this.persist();
    return n;
  }

  // A shared markdown findings log living in the project folder.
  addLog(title: string, description: string, path: string): GraphNode {
    const n: GraphNode = { id: this.id('log'), type: 'log', title, description, status: 'waiting', sessionId: null, path };
    this.nodes.push(n);
    this.persist();
    return n;
  }

  addEdge(from: string, to: string, kind: EdgeKind) {
    this.edges.push({ from, to, kind });
    this.persist();
  }

  get(id: string): GraphNode {
    const n = this.nodes.find((x) => x.id === id);
    if (!n) throw new Error(`no node ${id}`);
    return n;
  }

  persist() {
    atomicWriteJSON(this.file, { nodes: this.nodes, edges: this.edges });
  }
}
