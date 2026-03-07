"use client";

import { useState, useRef, useCallback } from "react";
import {
  ArrowRight,
  ArrowLeft,
  List,
  Network,
  X,
  Filter,
  Server,
} from "lucide-react";
import {
  SERVICE_REGISTRY,
  getServiceDependencies,
  getServiceDependents,
  type ServiceConfig,
  type AppGroup,
} from "@/lib/releases/services";
import {
  Badge,
  Card,
  CardContent,
  Separator,
  Skeleton,
} from "@tesserix/web";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ViewMode = "list" | "graph";
type GroupFilter = "all" | AppGroup;

interface GraphNode {
  service: ServiceConfig;
  layer: number;
  indexInLayer: number;
  x: number;
  y: number;
}

interface GraphEdge {
  sourceId: string;
  targetId: string;
  sourceName: string;
  targetName: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const GROUP_COLORS: Record<AppGroup, { border: string; bg: string; text: string; nodeFill: string; nodeStroke: string }> = {
  platform: {
    border: "border-zinc-600",
    bg: "bg-zinc-800/40",
    text: "text-zinc-300",
    nodeFill: "#27272a",
    nodeStroke: "#71717a",
  },
  mark8ly: {
    border: "border-blue-800",
    bg: "bg-blue-950/30",
    text: "text-blue-300",
    nodeFill: "#1e3a5f",
    nodeStroke: "#3b82f6",
  },
};

const NODE_W = 160;
const NODE_H = 40;
const LAYER_GAP = 220;
const NODE_GAP = 60;
const GRAPH_PADDING = 40;

// ---------------------------------------------------------------------------
// Graph layout algorithm
// ---------------------------------------------------------------------------

function computeGraphLayout(services: ServiceConfig[]): {
  nodes: GraphNode[];
  edges: GraphEdge[];
} {
  // Build a name->service map for quick lookup
  const byName = new Map<string, ServiceConfig>(services.map((s) => [s.name, s]));

  // Compute layers using topological depth
  const layers = new Map<string, number>();
  const visited = new Set<string>();

  function assignLayer(name: string, depth: number): void {
    const current = layers.get(name) ?? -1;
    if (depth <= current) return; // already assigned a deeper layer
    layers.set(name, depth);
    visited.add(name);
    const svc = byName.get(name);
    if (!svc) return;
    for (const dep of svc.invokes) {
      if (byName.has(dep)) {
        assignLayer(dep, depth + 1);
      }
    }
  }

  // Start from services that are not invoked by anyone (roots of the graph)
  const invoked = new Set<string>(services.flatMap((s) => s.invokes));
  const roots = services.filter((s) => !invoked.has(s.name));

  for (const root of roots) {
    assignLayer(root.name, 0);
  }

  // Any service not yet visited (isolated or unreachable) goes to layer 0
  for (const svc of services) {
    if (!visited.has(svc.name)) {
      layers.set(svc.name, 0);
    }
  }

  // Group by layer
  const layerGroups = new Map<number, ServiceConfig[]>();
  for (const [name, layer] of layers.entries()) {
    if (!layerGroups.has(layer)) layerGroups.set(layer, []);
    layerGroups.get(layer)!.push(byName.get(name)!);
  }

  // Sort layers
  const sortedLayers = Array.from(layerGroups.keys()).sort((a, b) => a - b);

  // Position nodes
  const nodes: GraphNode[] = [];
  for (const layerIdx of sortedLayers) {
    const layerServices = layerGroups.get(layerIdx)!;
    // Sort within layer: platform first, then alphabetical
    layerServices.sort((a, b) => {
      if (a.appGroup !== b.appGroup) return a.appGroup === "platform" ? -1 : 1;
      return a.displayName.localeCompare(b.displayName);
    });

    layerServices.forEach((svc, idx) => {
      nodes.push({
        service: svc,
        layer: layerIdx,
        indexInLayer: idx,
        x: GRAPH_PADDING + layerIdx * LAYER_GAP,
        y: GRAPH_PADDING + idx * (NODE_H + NODE_GAP),
      });
    });
  }

  // Build edges (only for services in our filtered set)
  const edges: GraphEdge[] = [];
  const nodeNames = new Set(nodes.map((n) => n.service.name));
  for (const node of nodes) {
    for (const target of node.service.invokes) {
      if (nodeNames.has(target)) {
        edges.push({
          sourceId: node.service.name,
          targetId: target,
          sourceName: node.service.name,
          targetName: target,
        });
      }
    }
  }

  return { nodes, edges };
}

// ---------------------------------------------------------------------------
// SVG cubic bezier path between two nodes
// ---------------------------------------------------------------------------

function edgePath(
  sx: number,
  sy: number,
  tx: number,
  ty: number,
  nodeW: number,
  nodeH: number
): string {
  const x1 = sx + nodeW;
  const y1 = sy + nodeH / 2;
  const x2 = tx;
  const y2 = ty + nodeH / 2;
  const cx1 = x1 + (x2 - x1) * 0.5;
  const cy1 = y1;
  const cx2 = x1 + (x2 - x1) * 0.5;
  const cy2 = y2;
  return `M ${x1} ${y1} C ${cx1} ${cy1}, ${cx2} ${cy2}, ${x2} ${y2}`;
}

// ---------------------------------------------------------------------------
// Graph View
// ---------------------------------------------------------------------------

interface GraphViewProps {
  services: ServiceConfig[];
}

function GraphView({ services }: GraphViewProps) {
  const [hovered, setHovered] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  const { nodes, edges } = computeGraphLayout(services);

  const maxX = Math.max(...nodes.map((n) => n.x)) + NODE_W + GRAPH_PADDING;
  const maxY = Math.max(...nodes.map((n) => n.y)) + NODE_H + GRAPH_PADDING;
  const viewBox = `0 0 ${maxX} ${maxY}`;

  const active = hovered ?? selected;

  const connectedSet = useCallback(
    (name: string) => {
      const outbound = new Set(services.find((s) => s.name === name)?.invokes ?? []);
      const inbound = new Set(services.filter((s) => s.invokes.includes(name)).map((s) => s.name));
      return { outbound, inbound };
    },
    [services]
  );

  const isEdgeHighlighted = (edge: GraphEdge) => {
    if (!active) return false;
    return edge.sourceId === active || edge.targetId === active;
  };

  const isNodeDimmed = (name: string) => {
    if (!active) return false;
    if (name === active) return false;
    const { outbound, inbound } = connectedSet(active);
    return !outbound.has(name) && !inbound.has(name);
  };

  const selectedService = selected ? services.find((s) => s.name === selected) : null;
  const selectedDeps = selected ? getServiceDependencies(selected).filter((d) => services.some((s) => s.name === d.name)) : [];
  const selectedDependents = selected ? getServiceDependents(selected).filter((d) => services.some((s) => s.name === d.name)) : [];

  return (
    <div className="flex gap-4">
      <div className="flex-1 min-w-0 overflow-auto rounded-lg border border-border bg-muted/10">
        <svg
          ref={svgRef}
          viewBox={viewBox}
          width={maxX}
          height={maxY}
          className="block"
          style={{ minWidth: maxX, minHeight: maxY }}
        >
          {/* Render edges first (below nodes) */}
          <g>
            {edges.map((edge) => {
              const src = nodes.find((n) => n.service.name === edge.sourceId);
              const tgt = nodes.find((n) => n.service.name === edge.targetId);
              if (!src || !tgt) return null;
              const highlighted = isEdgeHighlighted(edge);
              const dimmed = active && !highlighted;
              return (
                <path
                  key={`${edge.sourceId}->${edge.targetId}`}
                  d={edgePath(src.x, src.y, tgt.x, tgt.y, NODE_W, NODE_H)}
                  fill="none"
                  stroke={highlighted ? "#3b82f6" : "#52525b"}
                  strokeWidth={highlighted ? 2 : 1}
                  strokeOpacity={dimmed ? 0.15 : 1}
                  markerEnd={`url(#arrow-${highlighted ? "blue" : "gray"})`}
                  className="transition-all duration-150"
                />
              );
            })}
          </g>

          {/* Arrow markers */}
          <defs>
            <marker
              id="arrow-gray"
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="6"
              markerHeight="6"
              orient="auto-start-reverse"
            >
              <path d="M 0 0 L 10 5 L 0 10 z" fill="#52525b" />
            </marker>
            <marker
              id="arrow-blue"
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="6"
              markerHeight="6"
              orient="auto-start-reverse"
            >
              <path d="M 0 0 L 10 5 L 0 10 z" fill="#3b82f6" />
            </marker>
          </defs>

          {/* Render nodes */}
          {nodes.map((node) => {
            const colors = GROUP_COLORS[node.service.appGroup];
            const isActive = active === node.service.name;
            const dimmed = isNodeDimmed(node.service.name);
            return (
              <g
                key={node.service.name}
                transform={`translate(${node.x}, ${node.y})`}
                className="cursor-pointer"
                onMouseEnter={() => setHovered(node.service.name)}
                onMouseLeave={() => setHovered(null)}
                onClick={() =>
                  setSelected((prev) =>
                    prev === node.service.name ? null : node.service.name
                  )
                }
                style={{ opacity: dimmed ? 0.25 : 1, transition: "opacity 0.15s" }}
              >
                <rect
                  width={NODE_W}
                  height={NODE_H}
                  rx={6}
                  fill={colors.nodeFill}
                  stroke={isActive ? "#3b82f6" : colors.nodeStroke}
                  strokeWidth={isActive ? 2 : 1}
                />
                <text
                  x={NODE_W / 2}
                  y={NODE_H / 2}
                  dominantBaseline="middle"
                  textAnchor="middle"
                  fontSize={11}
                  fill={isActive ? "#93c5fd" : "#d4d4d8"}
                  fontFamily="ui-sans-serif, system-ui, sans-serif"
                  fontWeight={isActive ? 600 : 400}
                >
                  {node.service.displayName.length > 18
                    ? node.service.displayName.slice(0, 16) + "…"
                    : node.service.displayName}
                </text>
              </g>
            );
          })}
        </svg>
      </div>

      {/* Side panel */}
      {selectedService && (
        <div className="w-64 shrink-0 space-y-3">
          <Card>
            <CardContent className="p-4 space-y-3">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="font-semibold text-sm">{selectedService.displayName}</p>
                  <p className="text-xs text-muted-foreground font-mono">{selectedService.name}</p>
                </div>
                <button
                  onClick={() => setSelected(null)}
                  className="text-muted-foreground hover:text-foreground transition-colors shrink-0"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>

              <div className="flex gap-1.5 flex-wrap">
                <Badge
                  variant="outline"
                  className={`text-xs ${GROUP_COLORS[selectedService.appGroup].text} ${GROUP_COLORS[selectedService.appGroup].border}`}
                >
                  {selectedService.appGroup}
                </Badge>
                <Badge variant="outline" className="text-xs">
                  {selectedService.type}
                </Badge>
                <Badge variant="outline" className="text-xs font-mono">
                  {selectedService.lang}
                </Badge>
              </div>

              <Separator />

              {selectedDeps.length > 0 && (
                <div className="space-y-1.5">
                  <p className="text-xs font-medium text-muted-foreground flex items-center gap-1">
                    <ArrowRight className="h-3 w-3" />
                    Calls ({selectedDeps.length})
                  </p>
                  <div className="flex flex-col gap-1">
                    {selectedDeps.map((dep) => (
                      <button
                        key={dep.name}
                        onClick={() => setSelected(dep.name)}
                        className="text-left text-xs px-2 py-1 rounded border border-border hover:bg-muted/50 transition-colors font-mono text-muted-foreground hover:text-foreground"
                      >
                        {dep.displayName}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {selectedDependents.length > 0 && (
                <div className="space-y-1.5">
                  <p className="text-xs font-medium text-muted-foreground flex items-center gap-1">
                    <ArrowLeft className="h-3 w-3" />
                    Called by ({selectedDependents.length})
                  </p>
                  <div className="flex flex-col gap-1">
                    {selectedDependents.map((dep) => (
                      <button
                        key={dep.name}
                        onClick={() => setSelected(dep.name)}
                        className="text-left text-xs px-2 py-1 rounded border border-border hover:bg-muted/50 transition-colors font-mono text-muted-foreground hover:text-foreground"
                      >
                        {dep.displayName}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {selectedDeps.length === 0 && selectedDependents.length === 0 && (
                <p className="text-xs text-muted-foreground">No connections in current view.</p>
              )}
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// List View — single service row
// ---------------------------------------------------------------------------

interface ListRowProps {
  service: ServiceConfig;
  allServices: ServiceConfig[];
  highlighted: string | null;
  onHighlight: (name: string | null) => void;
  onChipClick: (name: string) => void;
  rowRef: (el: HTMLDivElement | null) => void;
}

function ListRow({ service, allServices, highlighted, onHighlight, onChipClick, rowRef }: ListRowProps) {
  const deps = getServiceDependencies(service.name).filter((d) =>
    allServices.some((s) => s.name === d.name)
  );
  const dependents = getServiceDependents(service.name).filter((d) =>
    allServices.some((s) => s.name === d.name)
  );

  const colors = GROUP_COLORS[service.appGroup];
  const isHighlighted = highlighted === service.name;

  return (
    <div
      ref={rowRef}
      className={[
        "grid grid-cols-[1fr_auto_1fr] items-center gap-3 px-4 py-3 rounded-lg border transition-colors duration-200",
        isHighlighted
          ? "border-blue-500/60 bg-blue-950/20"
          : `${colors.border} ${colors.bg}`,
      ].join(" ")}
      onMouseEnter={() => onHighlight(service.name)}
      onMouseLeave={() => onHighlight(null)}
    >
      {/* Inbound (left) */}
      <div className="flex items-center gap-1.5 flex-wrap justify-end">
        {dependents.length === 0 ? (
          <span className="text-xs text-muted-foreground/40 italic">—</span>
        ) : (
          dependents.map((dep) => (
            <button
              key={dep.name}
              onClick={() => onChipClick(dep.name)}
              className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full border border-zinc-700 bg-zinc-800/60 text-zinc-300 hover:border-blue-500 hover:text-blue-300 transition-colors"
            >
              <ArrowRight className="h-3 w-3 text-zinc-500" />
              {dep.displayName}
            </button>
          ))
        )}
      </div>

      {/* Center: service name */}
      <div className="text-center shrink-0 min-w-[140px]">
        <p className={`text-sm font-semibold ${colors.text}`}>{service.displayName}</p>
        <p className="text-xs text-muted-foreground font-mono">{service.name}</p>
      </div>

      {/* Outbound (right) */}
      <div className="flex items-center gap-1.5 flex-wrap">
        {deps.length === 0 ? (
          <span className="text-xs text-muted-foreground/40 italic">—</span>
        ) : (
          deps.map((dep) => (
            <button
              key={dep.name}
              onClick={() => onChipClick(dep.name)}
              className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full border border-zinc-700 bg-zinc-800/60 text-zinc-300 hover:border-blue-500 hover:text-blue-300 transition-colors"
            >
              {dep.displayName}
              <ArrowRight className="h-3 w-3 text-zinc-500" />
            </button>
          ))
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// List View container
// ---------------------------------------------------------------------------

interface ListViewProps {
  services: ServiceConfig[];
}

function ListView({ services }: ListViewProps) {
  const [highlighted, setHighlighted] = useState<string | null>(null);
  const rowRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  const handleChipClick = useCallback((name: string) => {
    const el = rowRefs.current.get(name);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      setHighlighted(name);
      setTimeout(() => setHighlighted(null), 2000);
    }
  }, []);

  const setRowRef = useCallback(
    (name: string) => (el: HTMLDivElement | null) => {
      if (el) {
        rowRefs.current.set(name, el);
      } else {
        rowRefs.current.delete(name);
      }
    },
    []
  );

  if (services.length === 0) {
    return (
      <div className="py-12 text-center space-y-2">
        <Server className="h-8 w-8 text-muted-foreground mx-auto" />
        <p className="text-muted-foreground text-sm">No services match the current filters.</p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {/* Column headers */}
      <div className="grid grid-cols-[1fr_auto_1fr] gap-3 px-4 pb-1">
        <p className="text-xs font-medium text-muted-foreground text-right flex items-center justify-end gap-1">
          <ArrowRight className="h-3 w-3" />
          Called by
        </p>
        <p className="text-xs font-medium text-muted-foreground text-center min-w-[140px]">
          Service
        </p>
        <p className="text-xs font-medium text-muted-foreground flex items-center gap-1">
          Calls
          <ArrowRight className="h-3 w-3" />
        </p>
      </div>

      <div className="space-y-1.5">
        {services.map((svc) => (
          <ListRow
            key={svc.name}
            service={svc}
            allServices={services}
            highlighted={highlighted}
            onHighlight={setHighlighted}
            onChipClick={handleChipClick}
            rowRef={setRowRef(svc.name)}
          />
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Stats bar
// ---------------------------------------------------------------------------

function StatsBar({ services }: { services: ServiceConfig[] }) {
  const connectionCount = services.reduce((acc, s) => {
    return acc + s.invokes.filter((dep) => services.some((sv) => sv.name === dep)).length;
  }, 0);

  const platformCount = services.filter((s) => s.appGroup === "platform").length;
  const mark8lyCount = services.filter((s) => s.appGroup === "mark8ly").length;

  return (
    <div className="flex items-center gap-4 text-xs text-muted-foreground">
      <span>
        <span className="font-semibold text-foreground">{services.length}</span> services
      </span>
      <span className="text-border">|</span>
      <span>
        <span className="font-semibold text-foreground">{connectionCount}</span> connections
      </span>
      <span className="text-border">|</span>
      <span>
        <span className="font-semibold text-zinc-300">{platformCount}</span>{" "}
        <span className="text-zinc-500">platform</span>
      </span>
      <span className="text-border">|</span>
      <span>
        <span className="font-semibold text-blue-300">{mark8lyCount}</span>{" "}
        <span className="text-blue-500">mark8ly</span>
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main DependencyGraph component
// ---------------------------------------------------------------------------

export function DependencyGraph() {
  const [viewMode, setViewMode] = useState<ViewMode>("list");
  const [groupFilter, setGroupFilter] = useState<GroupFilter>("all");
  const [hideIsolated, setHideIsolated] = useState(false);

  // Filter services
  const filteredServices = SERVICE_REGISTRY.filter((svc) => {
    if (groupFilter !== "all" && svc.appGroup !== groupFilter) return false;
    if (hideIsolated) {
      const hasOutbound = svc.invokes.length > 0;
      const hasInbound = SERVICE_REGISTRY.some((s) => s.invokes.includes(svc.name));
      if (!hasOutbound && !hasInbound) return false;
    }
    return true;
  });

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <Card>
        <CardContent className="p-4">
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <StatsBar services={filteredServices} />

            <div className="flex items-center gap-3 flex-wrap">
              {/* Group filter */}
              <div className="flex items-center gap-1.5">
                <Filter className="h-3.5 w-3.5 text-muted-foreground" />
                <div className="flex rounded-md border border-border overflow-hidden">
                  {(["all", "platform", "mark8ly"] as const).map((group) => (
                    <button
                      key={group}
                      onClick={() => setGroupFilter(group)}
                      className={[
                        "px-3 py-1 text-xs font-medium transition-colors border-r border-border last:border-r-0",
                        groupFilter === group
                          ? "bg-primary text-primary-foreground"
                          : "text-muted-foreground hover:text-foreground hover:bg-muted/50",
                      ].join(" ")}
                    >
                      {group === "all" ? "All" : group === "platform" ? "Platform" : "mark8ly"}
                    </button>
                  ))}
                </div>
              </div>

              {/* Hide isolated checkbox */}
              <label className="flex items-center gap-1.5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={hideIsolated}
                  onChange={(e) => setHideIsolated(e.target.checked)}
                  className="h-3.5 w-3.5 accent-primary"
                />
                <span className="text-xs text-muted-foreground">Hide isolated</span>
              </label>

              <Separator orientation="vertical" className="h-5" />

              {/* View mode toggle */}
              <div className="flex rounded-md border border-border overflow-hidden">
                <button
                  onClick={() => setViewMode("list")}
                  className={[
                    "flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium transition-colors border-r border-border",
                    viewMode === "list"
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:text-foreground hover:bg-muted/50",
                  ].join(" ")}
                >
                  <List className="h-3.5 w-3.5" />
                  List
                </button>
                <button
                  onClick={() => setViewMode("graph")}
                  className={[
                    "flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium transition-colors",
                    viewMode === "graph"
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:text-foreground hover:bg-muted/50",
                  ].join(" ")}
                >
                  <Network className="h-3.5 w-3.5" />
                  Graph
                </button>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Legend */}
      <div className="flex items-center gap-4 px-1">
        <div className="flex items-center gap-1.5">
          <div className="h-3 w-3 rounded-sm border border-zinc-600 bg-zinc-800/40" />
          <span className="text-xs text-muted-foreground">Platform</span>
        </div>
        <div className="flex items-center gap-1.5">
          <div className="h-3 w-3 rounded-sm border border-blue-800 bg-blue-950/30" />
          <span className="text-xs text-muted-foreground">mark8ly</span>
        </div>
        {viewMode === "list" && (
          <>
            <Separator orientation="vertical" className="h-4" />
            <p className="text-xs text-muted-foreground">
              Click a chip to scroll to that service. Hover a row to inspect connections.
            </p>
          </>
        )}
        {viewMode === "graph" && (
          <>
            <Separator orientation="vertical" className="h-4" />
            <p className="text-xs text-muted-foreground">
              Hover to highlight connections. Click a node to open detail panel.
            </p>
          </>
        )}
      </div>

      {/* Content */}
      {viewMode === "list" ? (
        <ListView services={filteredServices} />
      ) : (
        <GraphView services={filteredServices} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Skeleton
// ---------------------------------------------------------------------------

export function DependencyGraphSkeleton() {
  return (
    <div className="space-y-4">
      <Skeleton className="h-16 w-full" />
      <div className="space-y-2">
        {Array.from({ length: 8 }).map((_, i) => (
          <Skeleton key={i} className="h-14 w-full" />
        ))}
      </div>
    </div>
  );
}
