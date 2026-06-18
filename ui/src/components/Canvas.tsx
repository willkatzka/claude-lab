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
import { layout } from '../layout';
import { AgentNode, TaskNode, DirectoryNode, LogNode } from './nodes';
import { agentRole, type Graph, type GraphNode } from '../types';

const nodeTypes = { agent: AgentNode, task: TaskNode, directory: DirectoryNode, log: LogNode };

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

  // Merge the latest graph into node state: keep MANUALLY-DRAGGED positions,
  // re-place everything else via dagre (centered over connections), and refresh
  // each node's data (status, handlers).
  useEffect(() => {
    setNodes((prev) => {
      const prevById = new Map(prev.map((n) => [n.id, n]));
      return rfNodes.map((rn) => {
        const existing = prevById.get(rn.id);
        const pinned = draggedRef.current.has(rn.id) && existing;
        return {
          ...rn,
          position: pinned ? existing.position : rn.position,
          data: {
            ...rn.data,
            onSpawn,
            onTerminal,
            onRename,
            onSetName,
            onPick,
            roleLabel:
              (rn.data as { node: GraphNode }).node.type === 'agent'
                ? agentRole((rn.data as { node: GraphNode }).node, graph.nodes)
                : undefined,
            chatActive: rn.id === activeChatId,
            chatOpen: openChatIds.includes(rn.id),
          },
        } as Node;
      });
    });
  }, [rfNodes, onSpawn, onTerminal, onRename, onSetName, onPick, activeChatId, openChatIds]);

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
      edges={rfEdges as unknown as Edge[]}
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
