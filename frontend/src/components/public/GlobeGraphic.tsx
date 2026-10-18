import { cn } from "@/lib/cn";

/* Stylized landmass bitmap (34 cols x 15 rows) — decorative, not cartography. */
export const LAND = [
  "...................................",
  "........######.....................",
  "....############...................",
  "..#############......########......",
  "..############....###############..",
  "....#########....################..",
  ".....########......###########.....",
  "......######........#########......",
  ".......####..........########......",
  "........##............######.......",
  ".........##............####........",
  "..........#.............##.........",
  "...................................",
  "...................................",
  "...................................",
];

const R = 92;
const C = 100;

function dotRows() {
  const rows = LAND.length;
  const cols = LAND[0].length;
  const dots: { x: number; y: number; land: boolean }[] = [];
  for (let r = 0; r < rows; r += 1) {
    const y = C - R + (r / (rows - 1)) * R * 2;
    const half = Math.sqrt(Math.max(0, R * R - (y - C) * (y - C)));
    for (let c = 0; c < cols; c += 1) {
      if (half < 4) continue;
      const x = C - half + (c / (cols - 1)) * half * 2;
      dots.push({ x, y, land: LAND[r][c] === "#" });
    }
  }
  return dots;
}

const DOTS = dotRows();

/* Five "served regions" joined by thin dashed arcs. */
const NODES = [
  { x: 68, y: 74 },
  { x: 128, y: 64 },
  { x: 118, y: 110 },
  { x: 82, y: 118 },
  { x: 150, y: 92 },
];

const ARCS = [
  `M${NODES[0].x} ${NODES[0].y} Q 98 30 ${NODES[1].x} ${NODES[1].y}`,
  `M${NODES[0].x} ${NODES[0].y} Q 70 100 ${NODES[3].x} ${NODES[3].y}`,
  `M${NODES[1].x} ${NODES[1].y} Q 128 88 ${NODES[2].x} ${NODES[2].y}`,
  `M${NODES[1].x} ${NODES[1].y} Q 146 74 ${NODES[4].x} ${NODES[4].y}`,
  `M${NODES[3].x} ${NODES[3].y} Q 104 122 ${NODES[2].x} ${NODES[2].y}`,
];

type GlobeGraphicProps = {
  className?: string;
  label?: string;
};

/**
 * World-dots globe with five gently pulsing location nodes joined by thin
 * dashed arcs. Token colors only; the pulse resolves to a static state under
 * prefers-reduced-motion via the global media query.
 */
export function GlobeGraphic({ className, label = "ISP CENTRIC is accessible anywhere in the world" }: GlobeGraphicProps) {
  return (
    <svg
      viewBox="0 0 200 200"
      role="img"
      aria-label={label}
      className={cn("h-auto w-full", className)}
    >
      <circle cx={C} cy={C} r={R} className="globe-ring" />
      <ellipse cx={C} cy={C} rx={R} ry={R / 3.2} className="globe-ring" />
      <ellipse cx={C} cy={C} rx={R / 3.2} ry={R} className="globe-ring" />
      {DOTS.map((dot, index) => (
        <circle
          key={index}
          cx={dot.x}
          cy={dot.y}
          r={dot.land ? 1.5 : 1.05}
          className={dot.land ? "globe-land" : "globe-dot"}
        />
      ))}
      {ARCS.map((d) => (
        <path key={d} d={d} className="globe-arc" />
      ))}
      {NODES.map((node, index) => (
        <circle
          key={`${node.x}-${node.y}`}
          cx={node.x}
          cy={node.y}
          r={4}
          className={index % 2 === 0 ? "network-node" : "network-node-soft"}
          style={{ animationDelay: `${index * 0.6}s` }}
        />
      ))}
    </svg>
  );
}
