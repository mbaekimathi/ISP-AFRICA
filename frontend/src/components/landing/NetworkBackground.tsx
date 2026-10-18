type NetworkBackgroundProps = {
  intensity?: "hero" | "subtle";
};

const nodes = [
  { cx: 80, cy: 120, soft: false, delay: "0s" },
  { cx: 220, cy: 80, soft: true, delay: "0.6s" },
  { cx: 360, cy: 160, soft: false, delay: "1.2s" },
  { cx: 520, cy: 70, soft: true, delay: "0.3s" },
  { cx: 690, cy: 150, soft: false, delay: "1s" },
  { cx: 860, cy: 90, soft: true, delay: "1.6s" },
  { cx: 1040, cy: 180, soft: false, delay: "0.8s" },
  { cx: 180, cy: 320, soft: true, delay: "1.4s" },
  { cx: 420, cy: 380, soft: false, delay: "0.2s" },
  { cx: 640, cy: 330, soft: true, delay: "1.1s" },
  { cx: 900, cy: 390, soft: false, delay: "0.5s" },
  { cx: 1120, cy: 300, soft: true, delay: "1.8s" },
];

const lines = [
  "M80 120 L220 80 L360 160 L520 70",
  "M520 70 L690 150 L860 90 L1040 180",
  "M220 80 L180 320 L420 380",
  "M360 160 L420 380 L640 330 L690 150",
  "M860 90 L900 390 L1120 300 L1040 180",
  "M640 330 L900 390",
];

export function NetworkBackground({ intensity = "hero" }: NetworkBackgroundProps) {
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden="true">
      <div className={intensity === "hero" ? "absolute inset-0 network-glow" : "absolute inset-0 network-glow opacity-50"} />
      <div className="absolute inset-0 network-grid opacity-80" />
      <svg
        className={`network-mesh absolute inset-0 h-full w-full${intensity === "hero" ? "" : " opacity-50"}`}
        viewBox="0 0 1200 520"
        preserveAspectRatio="xMidYMid slice"
      >
        {lines.map((d) => (
          <path key={d} d={d} className="network-line" />
        ))}
        {nodes.map((node) => (
          <circle
            key={`${node.cx}-${node.cy}`}
            cx={node.cx}
            cy={node.cy}
            r={intensity === "hero" ? 4.5 : 3.5}
            className={node.soft ? "network-node-soft" : "network-node"}
            style={{ animationDelay: node.delay }}
          />
        ))}
      </svg>
    </div>
  );
}
