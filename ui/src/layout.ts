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

  const rfEdges = graph.edges.map((e, i) => ({
    id: `e${i}-${e.kind}-${e.from}-${e.to}`,
    source: e.from,
    target: e.to,
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
  }));

  return { rfNodes, rfEdges };
}
