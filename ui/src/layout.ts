// Auto-layout the DAG with dagre so we never hand-place coordinates
// (essential once recursion + shared nodes create multiple parents).
import dagre from '@dagrejs/dagre';
import type { Graph, GraphNode, Edge } from './types';

export const NODE_W = 220;
export const NODE_H = 76;

// Transform the real graph for rendering given its groups (folders): collapsed
// groups hide their members behind one folder node; edges crossing a group
// boundary reroute to/from the folder; expanded groups show the folder as the
// parent of the members. The folder is always the group's single connection
// point to the rest of the tree.
export function applyGroups(graph: Graph): { nodes: GraphNode[]; edges: Edge[] } {
  const groups = graph.groups ?? [];
  if (!groups.length) return { nodes: graph.nodes, edges: graph.edges };
  const exists = new Set(graph.nodes.map((n) => n.id));
  const memberToGroup = new Map<string, (typeof groups)[number]>();
  for (const grp of groups) for (const m of grp.members) if (exists.has(m)) memberToGroup.set(m, grp);

  // hierarchy parent of each node (assigned/delegates edge into it)
  const parentOf = new Map<string, string>();
  for (const e of graph.edges) if (e.kind !== 'access') parentOf.set(e.to, e.from);

  const nodes: GraphNode[] = [];
  for (const n of graph.nodes) {
    const grp = memberToGroup.get(n.id);
    if (!grp || !grp.collapsed) nodes.push(n); // ungrouped, or expanded member
  }
  for (const grp of groups) {
    nodes.push({ id: grp.id, type: 'group', title: grp.label, description: '', status: 'done', sessionId: null, collapsed: grp.collapsed, count: grp.members.length });
  }

  const seen = new Set<string>();
  const edges: Edge[] = [];
  const add = (from: string, to: string, kind: Edge['kind']) => {
    if (from === to) return;
    const k = `${from}|${to}|${kind}`;
    if (seen.has(k)) return;
    seen.add(k);
    edges.push({ from, to, kind });
  };
  for (const e of graph.edges) {
    const gf = memberToGroup.get(e.from);
    const gt = memberToGroup.get(e.to);
    if (gf && gt && gf.id === gt.id) {
      if (!gf.collapsed) add(e.from, e.to, e.kind); // internal edge, only when expanded
      continue;
    }
    add(gf ? gf.id : e.from, gt ? gt.id : e.to, e.kind); // map member endpoints to their folder
  }
  // Expanded groups: folder → each root member (members whose parent isn't in the group).
  for (const grp of groups) {
    if (grp.collapsed) continue;
    for (const m of grp.members) {
      if (!exists.has(m)) continue;
      const p = parentOf.get(m);
      if (!p || memberToGroup.get(p)?.id !== grp.id) add(grp.id, m, 'assigned');
    }
  }
  return { nodes, edges };
}

export function layout(graph: Graph) {
  const { nodes: tNodes, edges: tEdges } = applyGroups(graph);
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: 'TB', nodesep: 38, ranksep: 64 });

  tNodes.forEach((n) => g.setNode(n.id, { width: NODE_W, height: NODE_H }));
  // Only hierarchy edges drive the layout. 'access' edges are manual cross-links
  // (a directory/log granted to an agent) — feeding them to dagre would distort
  // the tree, so they're rendered separately without affecting ranking.
  tEdges.filter((e) => e.kind !== 'access').forEach((e) => g.setEdge(e.from, e.to));
  dagre.layout(g);

  const rfNodes = tNodes.map((n) => {
    const p = g.node(n.id);
    return {
      id: n.id,
      type: n.type, // 'agent' | 'task'
      position: { x: (p?.x ?? 0) - NODE_W / 2, y: (p?.y ?? 0) - NODE_H / 2 },
      data: { node: n },
    };
  });

  // Pick which side of each node the edge leaves/enters from, based on the
  // relative positions of the two nodes — so a line attaches to the facing side
  // (top/bottom/left/right) instead of always the bottom. Handle ids match the
  // per-side handles on the nodes: `s-<side>` (source) and `t-<side>` (target).
  const facingSides = (from: string, to: string) => {
    const a = g.node(from);
    const b = g.node(to);
    if (!a || !b) return { src: 'bottom', tgt: 'top' };
    const dx = (b.x ?? 0) - (a.x ?? 0);
    const dy = (b.y ?? 0) - (a.y ?? 0);
    if (Math.abs(dy) >= Math.abs(dx)) {
      return dy >= 0 ? { src: 'bottom', tgt: 'top' } : { src: 'top', tgt: 'bottom' };
    }
    return dx >= 0 ? { src: 'right', tgt: 'left' } : { src: 'left', tgt: 'right' };
  };

  const rfEdges = tEdges.map((e, i) => {
    const { src, tgt } = facingSides(e.from, e.to);
    return {
      id: `e${i}-${e.kind}-${e.from}-${e.to}`,
      source: e.from,
      target: e.to,
      sourceHandle: `s-${src}`,
      targetHandle: `t-${tgt}`,
      animated: e.kind === 'delegates' || e.kind === 'access',
      // 'access' grants render as a distinct accent-blue dotted cross-link.
      style:
        e.kind === 'access'
          ? { stroke: '#6ea8fe', strokeWidth: 1.5, strokeDasharray: '2 3' }
          : e.kind === 'delegates'
            ? { strokeDasharray: '5 4' }
            : undefined,
      data: { kind: e.kind },
      deletable: e.kind === 'access', // only manual grants can be removed in the canvas
    };
  });

  return { rfNodes, rfEdges };
}
