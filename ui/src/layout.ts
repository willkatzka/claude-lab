// Auto-layout the DAG with dagre so we never hand-place coordinates
// (essential once recursion + shared nodes create multiple parents).
import dagre from '@dagrejs/dagre';
import type { Graph } from './types';

export const NODE_W = 220;
export const NODE_H = 76;

export function layout(graph: Graph) {
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: 'TB', nodesep: 38, ranksep: 64 });

  graph.nodes.forEach((n) => g.setNode(n.id, { width: NODE_W, height: NODE_H }));
  // Only hierarchy edges drive the layout. 'access' edges are manual cross-links
  // (a directory/log granted to an agent) — feeding them to dagre would distort
  // the tree, so they're rendered separately without affecting ranking.
  graph.edges.filter((e) => e.kind !== 'access').forEach((e) => g.setEdge(e.from, e.to));
  dagre.layout(g);

  const rfNodes = graph.nodes.map((n) => {
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

  const rfEdges = graph.edges.map((e, i) => {
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
