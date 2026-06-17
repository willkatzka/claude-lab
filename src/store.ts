// The shared graph data model (from the project brief). The eventual React Flow
// UI consumes exactly this shape. Persisted to data/graph.json after every
// mutation so the graph survives a crash/restart.

import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

export type NodeType = 'agent' | 'task';
export type Status = 'running' | 'waiting' | 'done';
export type EdgeKind = 'delegates' | 'assigned';

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
      try {
        const g = JSON.parse(readFileSync(file, 'utf8'));
        s.nodes = g.nodes ?? [];
        s.edges = g.edges ?? [];
        s.seq = s.nodes.reduce(
          (m, n) => Math.max(m, parseInt(String(n.id).split('-')[1] ?? '0', 10) || 0),
          0,
        );
      } catch {
        /* corrupt/partial — start empty */
      }
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
    const dir = dirname(this.file);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(this.file, JSON.stringify({ nodes: this.nodes, edges: this.edges }, null, 2));
  }
}
