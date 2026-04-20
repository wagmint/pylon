"use client";

import { useCallback, useMemo } from "react";
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  useNodesState,
  useEdgesState,
  type Node,
  type Edge,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { ContextMap } from "../context-map/types";
import { layoutGraph } from "../context-map/layout";
import { ContextNodeGoal } from "./ContextNodeGoal";
import { ContextNodeTask } from "./ContextNodeTask";
import { ContextNodeSession } from "./ContextNodeSession";

interface ContextMapGraphProps {
  contextMap: ContextMap;
  selectedTaskId: string | null;
  onSelectTask: (taskId: string | null) => void;
}

const nodeTypes = {
  goal: ContextNodeGoal,
  task: ContextNodeTask,
  session: ContextNodeSession,
};

function buildFlowElements(contextMap: ContextMap, selectedTaskId: string | null) {
  const rawNodes: Node[] = contextMap.nodes.map((n) => ({
    id: n.id,
    type: n.type,
    position: { x: 0, y: 0 },
    data: {
      label: n.label,
      status: n.status,
      sessionCount: n.sessionCount ?? 0,
      agentType: n.agentType,
      agentStatus: n.agentStatus,
      selected: n.id === selectedTaskId,
    },
  }));

  const rawEdges: Edge[] = contextMap.edges.map((e) => ({
    id: e.id,
    source: e.source,
    target: e.target,
    style: { stroke: "#333", strokeDasharray: e.type === "parent" ? "4 3" : undefined },
    animated: false,
  }));

  return layoutGraph(rawNodes, rawEdges);
}

export function ContextMapGraph({
  contextMap,
  selectedTaskId,
  onSelectTask,
}: ContextMapGraphProps) {
  const { nodes: layoutedNodes, edges: layoutedEdges } = useMemo(
    () => buildFlowElements(contextMap, selectedTaskId),
    [contextMap, selectedTaskId]
  );

  const [nodes, , onNodesChange] = useNodesState(layoutedNodes);
  const [edges, , onEdgesChange] = useEdgesState(layoutedEdges);

  const onNodeClick = useCallback(
    (_: React.MouseEvent, node: Node) => {
      if (node.type === "task") {
        onSelectTask(node.id === selectedTaskId ? null : node.id);
      }
    },
    [onSelectTask, selectedTaskId]
  );

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      onNodeClick={onNodeClick}
      nodeTypes={nodeTypes}
      fitView
      minZoom={0.3}
      maxZoom={1.5}
      proOptions={{ hideAttribution: true }}
      className="bg-dash-bg"
    >
      <Background variant={BackgroundVariant.Dots} gap={16} size={0.5} color="#1e1e24" />
    </ReactFlow>
  );
}
