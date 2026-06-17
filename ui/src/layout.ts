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
  graph.edges.forEach((e) => g.setEdge(e.from, e.to));
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
    id: `e${i}`,
    source: e.from,
    target: e.to,
    animated: e.kind === 'delegates',
    style: e.kind === 'delegates' ? { strokeDasharray: '5 4' } : undefined,
  }));

  return { rfNodes, rfEdges };
}
