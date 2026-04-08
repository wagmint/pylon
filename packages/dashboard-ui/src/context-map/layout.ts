import dagre from "dagre";
import type { Node, Edge } from "@xyflow/react";

const NODE_WIDTH: Record<string, number> = {
  goal: 180,
  task: 150,
  session: 110,
};

const NODE_HEIGHT: Record<string, number> = {
  goal: 50,
  task: 60,
  session: 40,
};

export function layoutGraph(
  nodes: Node[],
  edges: Edge[]
): { nodes: Node[]; edges: Edge[] } {
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: "TB", ranksep: 60, nodesep: 40 });

  for (const node of nodes) {
    const nodeType = node.type ?? "task";
    g.setNode(node.id, {
      width: NODE_WIDTH[nodeType] ?? 150,
      height: NODE_HEIGHT[nodeType] ?? 50,
    });
  }

  for (const edge of edges) {
    g.setEdge(edge.source, edge.target);
  }

  dagre.layout(g);

  const layoutedNodes = nodes.map((node) => {
    const nodeType = node.type ?? "task";
    const pos = g.node(node.id);
    return {
      ...node,
      position: {
        x: pos.x - (NODE_WIDTH[nodeType] ?? 150) / 2,
        y: pos.y - (NODE_HEIGHT[nodeType] ?? 50) / 2,
      },
    };
  });

  return { nodes: layoutedNodes, edges };
}
