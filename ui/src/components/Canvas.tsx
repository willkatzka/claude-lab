import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  applyNodeChanges,
  useReactFlow,
  useNodesInitialized,
  type Node,
  type Edge,
  type NodeChange,
  type Connection,
} from '@xyflow/react';
import { layout, NODE_W, NODE_H } from '../layout';
import { AgentNode, TaskNode, DirectoryNode, LogNode } from './nodes';
import { agentRole, type Graph, type GraphNode } from '../types';

const nodeTypes = { agent: AgentNode, task: TaskNode, directory: DirectoryNode, log: LogNode };

type Side = 'top' | 'right' | 'bottom' | 'left';
// Offset a child from its parent in the clicked direction (a comfortable gap).
const sideOffset = (side: Side) => {
  switch (side) {
    case 'top':
      return { x: 0, y: -(NODE_H + 90) };
    case 'left':
      return { x: -(NODE_W + 90), y: 0 };
    case 'right':
      return { x: NODE_W + 90, y: 0 };
    default:
      return { x: 0, y: NODE_H + 90 };
  }
};
// Which sides of two boxes face each other, given their centers — for routing an
// edge's handles (s-<side> on source, t-<side> on target).
const facing = (a: { x: number; y: number }, b: { x: number; y: number }) => {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  if (Math.abs(dy) >= Math.abs(dx)) return dy >= 0 ? { s: 'bottom', t: 'top' } : { s: 'top', t: 'bottom' };
  return dx >= 0 ? { s: 'right', t: 'left' } : { s: 'left', t: 'right' };
};

// Re-fit the view once custom nodes have been measured (and whenever the node
// count changes — i.e. a new node was spawned). Status-only updates don't refit.
function FitOnReady({ count }: { count: number }) {
  const initialized = useNodesInitialized();
  const { fitView } = useReactFlow();
  const fitted = useRef(-1);
  useEffect(() => {
    // Fit once when first ready, and only again when the node COUNT changes
    // (a node was added/removed) — never on routine status polls. This keeps
    // the user's manual zoom/pan from being reset every 2s.
    if (initialized && fitted.current !== count) {
      fitted.current = count;
      fitView({ padding: 0.2, maxZoom: 1, duration: 200 });
    }
  }, [initialized, count, fitView]);
  return null;
}

export function Canvas({
  graph,
  onAgentClick,
  onSpawn,
  onTerminal,
  onRename,
  onSetName,
  onPick,
  onConnectGrant,
  onDisconnectGrant,
  onNodeContextMenu,
  activeChatId,
  openChatIds,
}: {
  graph: Graph;
  onAgentClick: (n: GraphNode) => void;
  onSpawn: (n: GraphNode) => void;
  onTerminal: (n: GraphNode) => void;
  onRename: (id: string, title: string) => void;
  onSetName: (id: string, name: string) => void;
  onPick: (n: GraphNode, kind: 'agent' | 'log') => void;
  onConnectGrant: (from: string, to: string) => void;
  onDisconnectGrant: (from: string, to: string) => void;
  onNodeContextMenu: (n: GraphNode, x: number, y: number) => void;
  activeChatId: string | null;
  openChatIds: string[];
}) {
  const { rfNodes, rfEdges } = useMemo(() => layout(graph), [graph]);
  const [nodes, setNodes] = useState<Node[]>([]);
  // Nodes the user has manually dragged — only these stay pinned. Everything
  // else follows dagre's fresh layout, so a parent re-centers over the
  // barycenter of its children as the tree grows (instead of drifting off to
  // the side because it was placed before its siblings existed).
  const draggedRef = useRef<Set<string>>(new Set());
  // Node ids we've already placed (so we can detect a freshly-spawned one).
  const knownIds = useRef<Set<string>>(new Set());
  // A directional spawn in flight: the next new child of `parentId` is placed on
  // `side` and pinned there (so it appears off the edge the ＋ was clicked).
  const pendingSpawn = useRef<{ parentId: string; side: Side } | null>(null);

  // The ＋ handlers record the clicked side, then delegate to the real spawn.
  const onSpawnSide = useCallback(
    (n: GraphNode, side: Side) => {
      pendingSpawn.current = { parentId: n.id, side };
      onSpawn(n);
    },
    [onSpawn],
  );
  const handlePick = useCallback(
    (n: GraphNode, kind: 'agent' | 'log', side: Side) => {
      pendingSpawn.current = { parentId: n.id, side };
      onPick(n, kind);
    },
    [onPick],
  );

  // Merge the latest graph into node state: keep MANUALLY-DRAGGED positions and
  // directionally-spawned ones; re-place everything else via dagre; refresh each
  // node's data (status, handlers).
  useEffect(() => {
    setNodes((prev) => {
      const prevById = new Map(prev.map((n) => [n.id, n]));
      // If a directional spawn just landed, find the new child of that parent and
      // place it off the clicked side of the parent's current position.
      let placedId: string | null = null;
      let placedPos: { x: number; y: number } | null = null;
      const pend = pendingSpawn.current;
      if (pend) {
        const parent = prevById.get(pend.parentId);
        const child = rfNodes.find(
          (rn) => !knownIds.current.has(rn.id) && graph.edges.some((e) => e.to === rn.id && e.from === pend.parentId),
        );
        if (parent && child) {
          const off = sideOffset(pend.side);
          placedId = child.id;
          placedPos = { x: parent.position.x + off.x, y: parent.position.y + off.y };
          draggedRef.current.add(child.id); // pin it
          pendingSpawn.current = null;
        }
      }
      const next = rfNodes.map((rn) => {
        const existing = prevById.get(rn.id);
        const pinned = draggedRef.current.has(rn.id) && existing;
        return {
          ...rn,
          position: rn.id === placedId && placedPos ? placedPos : pinned ? existing.position : rn.position,
          data: {
            ...rn.data,
            onSpawnSide,
            onTerminal,
            onRename,
            onSetName,
            onPick: handlePick,
            roleLabel:
              (rn.data as { node: GraphNode }).node.type === 'agent'
                ? agentRole((rn.data as { node: GraphNode }).node, graph.nodes)
                : undefined,
            chatActive: rn.id === activeChatId,
            chatOpen: openChatIds.includes(rn.id),
          },
        } as Node;
      });
      rfNodes.forEach((rn) => knownIds.current.add(rn.id));
      return next;
    });
  }, [rfNodes, onSpawnSide, onTerminal, onRename, onSetName, handlePick, graph.edges, graph.nodes, activeChatId, openChatIds]);

  // Edge handles: the auto-laid tree uses bottom→top (stable, never flips). Only
  // manually-arranged nodes (dragged / directionally-spawned) and access grants
  // route by geometry, so a directional child's line leaves the clicked side.
  const edges = useMemo(() => {
    const center = (id: string) => {
      const p = nodes.find((n) => n.id === id)?.position;
      return p ? { x: p.x + NODE_W / 2, y: p.y + NODE_H / 2 } : null;
    };
    return rfEdges.map((e) => {
      const kind = (e.data as { kind?: string } | undefined)?.kind;
      const geom = kind === 'access' || draggedRef.current.has(e.source) || draggedRef.current.has(e.target);
      let sh = 's-bottom';
      let th = 't-top';
      const a = center(e.source);
      const b = center(e.target);
      if (geom && a && b) {
        const f = facing(a, b);
        sh = `s-${f.s}`;
        th = `t-${f.t}`;
      }
      return { ...e, sourceHandle: sh, targetHandle: th };
    });
  }, [rfEdges, nodes]);

  const onNodesChange = useCallback(
    (changes: NodeChange[]) => setNodes((nds) => applyNodeChanges(changes, nds)),
    [],
  );

  // Once a node is dragged, pin it (its manual position wins over dagre).
  const onNodeDragStop = useCallback((_: unknown, node: Node) => {
    draggedRef.current.add(node.id);
  }, []);

  // Dragging a handle from a directory/log to an agent (or vice-versa) grants
  // access; the backend normalizes direction and validates the pair.
  const onConnect = useCallback(
    (c: Connection) => {
      if (c.source && c.target && c.source !== c.target) onConnectGrant(c.source, c.target);
    },
    [onConnectGrant],
  );
  // Deleting a selected access edge revokes the grant (only access edges are deletable).
  const onEdgesDelete = useCallback(
    (eds: Edge[]) => {
      for (const e of eds) {
        if ((e.data as { kind?: string } | undefined)?.kind === 'access' && e.source && e.target) {
          onDisconnectGrant(e.source, e.target);
        }
      }
    },
    [onDisconnectGrant],
  );

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges as unknown as Edge[]}
      nodeTypes={nodeTypes}
      onNodesChange={onNodesChange}
      onNodeDragStop={onNodeDragStop}
      onConnect={onConnect}
      onEdgesDelete={onEdgesDelete}
      fitView
      fitViewOptions={{ padding: 0.2, maxZoom: 1 }}
      proOptions={{ hideAttribution: true }}
      onNodeClick={(_, node) => {
        const n = (node.data as { node: GraphNode }).node;
        if (n.type === 'agent') onAgentClick(n);
      }}
      onNodeContextMenu={(e, node) => {
        e.preventDefault();
        onNodeContextMenu((node.data as { node: GraphNode }).node, e.clientX, e.clientY);
      }}
    >
      <Background />
      <Controls />
      <FitOnReady count={graph.nodes.length} />
    </ReactFlow>
  );
}
