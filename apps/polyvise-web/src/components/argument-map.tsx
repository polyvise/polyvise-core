"use client";

import {
  Background,
  Controls,
  MarkerType,
  MiniMap,
  ReactFlow,
  type Edge,
  type Node
} from "@xyflow/react";
import type { ArgumentEdge, ArgumentNode } from "@polyvise/debate-engine/debate/types";

type ArgumentMapProps = {
  nodes: ArgumentNode[];
  edges: ArgumentEdge[];
};

const sideStyles: Record<ArgumentNode["side"], { border: string; accent: string; background: string }> = {
  pro: {
    border: "rgba(34, 124, 112, 0.48)",
    accent: "#227c70",
    background: "#f3fbf8"
  },
  con: {
    border: "rgba(201, 86, 63, 0.48)",
    accent: "#c9563f",
    background: "#fff6f3"
  },
  neutral: {
    border: "rgba(109, 75, 115, 0.42)",
    accent: "#6d4b73",
    background: "#faf7fb"
  }
};

export function ArgumentMap({ nodes, edges }: ArgumentMapProps) {
  const flowNodes = toFlowNodes(nodes);
  const flowEdges = edges.map(toFlowEdge);

  return (
    <div className="h-[520px] min-h-[420px] overflow-hidden rounded-lg border border-graphite/15 bg-[#fbfaf7]">
      <ReactFlow
        nodes={flowNodes}
        edges={flowEdges}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        minZoom={0.35}
        maxZoom={1.6}
        proOptions={{ hideAttribution: true }}
      >
        <Background color="#d9d3c8" gap={18} />
        <MiniMap pannable zoomable nodeStrokeWidth={3} />
        <Controls />
      </ReactFlow>
    </div>
  );
}

function toFlowNodes(nodes: ArgumentNode[]): Node[] {
  const proNodes = nodes.filter((node) => node.side === "pro");
  const conNodes = nodes.filter((node) => node.side === "con");
  const neutralNodes = nodes.filter((node) => node.side === "neutral" && node.id !== "resolution");
  const resolution = nodes.find((node) => node.id === "resolution") ?? nodes[0];

  const positioned: Array<{ node: ArgumentNode; x: number; y: number }> = [];

  if (resolution) {
    positioned.push({ node: resolution, x: 120, y: 20 });
  }

  proNodes.forEach((node, index) => {
    positioned.push({ node, x: -260, y: 140 + index * 110 });
  });

  conNodes.forEach((node, index) => {
    positioned.push({ node, x: 520, y: 140 + index * 110 });
  });

  neutralNodes.forEach((node, index) => {
    positioned.push({ node, x: 120, y: 180 + index * 105 });
  });

  return positioned.map(({ node, x, y }) => {
    const style = sideStyles[node.side];

    return {
      id: node.id,
      type: "default",
      position: { x, y },
      data: {
        label: (
          <div className="space-y-1.5 p-3 text-left">
            <div className="flex items-center justify-between gap-2">
              <span
                className="h-2.5 w-2.5 shrink-0 rounded-full"
                style={{ backgroundColor: style.accent }}
                aria-hidden="true"
              />
              <span className="truncate text-[11px] font-semibold uppercase tracking-[0.08em] text-graphite/60">
                {node.kind}
              </span>
            </div>
            <div className="text-sm font-semibold leading-snug text-ink">{node.label}</div>
            <div className="line-clamp-3 text-xs leading-relaxed text-graphite/75">{node.detail}</div>
          </div>
        )
      },
      style: {
        background: style.background,
        borderColor: style.border,
        width: node.id === "resolution" ? 310 : 230
      }
    };
  });
}

function toFlowEdge(edge: ArgumentEdge): Edge {
  const relationColor =
    edge.relation === "challenges" ? "#c9563f" : edge.relation === "qualifies" ? "#c38326" : "#227c70";

  return {
    id: edge.id,
    source: edge.source,
    target: edge.target,
    animated: edge.relation === "qualifies",
    label: edge.relation,
    markerEnd: {
      type: MarkerType.ArrowClosed,
      color: relationColor
    },
    style: {
      stroke: relationColor,
      strokeWidth: 2
    },
    labelStyle: {
      fill: "#2e3135",
      fontSize: 11,
      fontWeight: 600
    },
    labelBgStyle: {
      fill: "#fffdfa",
      fillOpacity: 0.86
    }
  };
}
