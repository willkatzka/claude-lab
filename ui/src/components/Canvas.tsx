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
} from '@xyflow/react';
import { layout } from '../layout';
import { AgentNode, TaskNode } from './nodes';
import { agentRole, type Graph, type GraphNode } from '../types';

const nodeTypes = { agent: AgentNode, task: TaskNode };

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
  onNodeContextMenu: (n: GraphNode, x: number, y: number) => void;
  activeChatId: string | null;
  openChatIds: string[];
}) {
  const { rfNodes, rfEdges } = useMemo(() => layout(graph), [graph]);
  const [nodes, setNodes] = useState<Node[]>([]);

  // Merge the latest graph into node state: KEEP user-dragged positions for
  // nodes we already have, auto-place newly-spawned nodes via dagre, and refresh
  // each node's data (status, handlers). This is what lets a drag "stick" across
  // the 2s polling refresh.
  useEffect(() => {
    setNodes((prev) => {
      const prevById = new Map(prev.map((n) => [n.id, n]));
      return rfNodes.map((rn) => {
        const existing = prevById.get(rn.id);
        return {
          ...rn,
          position: existing ? existing.position : rn.position,
          data: {
            ...rn.data,
            onSpawn,
            onTerminal,
            onRename,
            onSetName,
            roleLabel: agentRole((rn.data as { node: GraphNode }).node, graph.nodes),
            chatActive: rn.id === activeChatId,
            chatOpen: openChatIds.includes(rn.id),
          },
        } as Node;
      });
    });
  }, [rfNodes, onSpawn, onTerminal, onRename, onSetName, activeChatId, openChatIds]);

  const onNodesChange = useCallback(
    (changes: NodeChange[]) => setNodes((nds) => applyNodeChanges(changes, nds)),
    [],
  );

  return (
    <ReactFlow
      nodes={nodes}
      edges={rfEdges as unknown as Edge[]}
      nodeTypes={nodeTypes}
      onNodesChange={onNodesChange}
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
