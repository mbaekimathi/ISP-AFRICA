import { useEffect, useRef } from "react";
import { LAND } from "@/components/public/GlobeGraphic";
import { cn } from "@/lib/cn";

type Vec = { x: number; y: number; z: number };

type Theme = {
  ocean: string;
  land: string;
  node: string;
  nodeSoft: string;
};

const TILT = -0.38;
const CAMERA = 3.4;

/* Sample "online client" regions — simulated, never real subscriber data. */
const ONLINE: { lat: number; lon: number; soft: boolean }[] = [
  { lat: -1.3, lon: 36.8, soft: false }, // Nairobi
  { lat: 51.5, lon: -0.1, soft: true }, // London
  { lat: -23.5, lon: -46.6, soft: false }, // São Paulo
  { lat: 19.1, lon: 72.9, soft: true }, // Mumbai
  { lat: -33.9, lon: 151.2, soft: false }, // Sydney
  { lat: 43.7, lon: -79.4, soft: true }, // Toronto
];

const ARCS: [number, number][] = [
  [0, 1],
  [0, 3],
  [1, 5],
  [3, 4],
];

function toVec(lat: number, lon: number, radius = 1): Vec {
  const phi = (lat * Math.PI) / 180;
  const theta = (lon * Math.PI) / 180;
  return {
    x: radius * Math.cos(phi) * Math.cos(theta),
    y: radius * Math.sin(phi),
    z: radius * Math.cos(phi) * Math.sin(theta),
  };
}

function rotate(v: Vec, spin: number): Vec {
  const cosS = Math.cos(spin);
  const sinS = Math.sin(spin);
  const x = v.x * cosS - v.z * sinS;
  const z = v.x * sinS + v.z * cosS;
  const cosT = Math.cos(TILT);
  const sinT = Math.sin(TILT);
  return { x, y: v.y * cosT - z * sinT, z: v.y * sinT + z * cosT };
}

function project(v: Vec, size: number): { x: number; y: number; s: number } {
  const scale = CAMERA / (CAMERA - v.z);
  return {
    x: size / 2 + v.x * scale * size * 0.36,
    y: size / 2 + v.y * scale * size * 0.36,
    s: scale,
  };
}

/* Landmass bitmap -> lat/lon points on the unit sphere. */
const DOTS: Vec[] = LAND.flatMap((row, r) => {
  const lat = 66 - (r / (LAND.length - 1)) * 132;
  return row
    .split("")
    .map((cell, c) =>
      cell === "#" ? toVec(lat, -170 + (c / (row.length - 1)) * 340) : null,
    )
    .filter((v): v is Vec => v !== null);
});

const ONLINE_VECS = ONLINE.map((o) => ({ ...o, vec: toVec(o.lat, o.lon) }));

function rgb(value: string, fallback: string): string {
  const parts = value.trim().split(/\s+/);
  return parts.length === 3 ? parts.join(",") : fallback;
}

function readTheme(el: HTMLElement): Theme {
  const styles = getComputedStyle(el);
  return {
    ocean: rgb(styles.getPropertyValue("--foreground-rgb"), "148,163,184"),
    land: rgb(styles.getPropertyValue("--primary-rgb"), "56,189,248"),
    node: rgb(styles.getPropertyValue("--primary-rgb"), "56,189,248"),
    nodeSoft: rgb(styles.getPropertyValue("--accent-rgb"), "245,158,11"),
  };
}

function paint(
  ctx: CanvasRenderingContext2D,
  size: number,
  spin: number,
  t: number,
  theme: Theme,
) {
  ctx.clearRect(0, 0, size, size);

  /* Sphere outline */
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size * 0.36, 0, Math.PI * 2);
  ctx.strokeStyle = `rgba(${theme.land},0.28)`;
  ctx.lineWidth = 1;
  ctx.stroke();

  /* Great-circle arcs between online nodes, lifted off the surface */
  ctx.setLineDash([3, 7]);
  ctx.strokeStyle = `rgba(${theme.land},0.32)`;
  for (const [a, b] of ARCS) {
    const va = ONLINE_VECS[a].vec;
    const vb = ONLINE_VECS[b].vec;
    ctx.beginPath();
    let started = false;
    for (let i = 0; i <= 24; i += 1) {
      const f = i / 24;
      const lift = 1 + Math.sin(f * Math.PI) * 0.16;
      const v = rotate(
        {
          x: (va.x + (vb.x - va.x) * f) * lift,
          y: (va.y + (vb.y - va.y) * f) * lift,
          z: (va.z + (vb.z - va.z) * f) * lift,
        },
        spin,
      );
      if (v.z < -0.15) {
        started = false;
        continue;
      }
      const p = project(v, size);
      if (!started) {
        ctx.moveTo(p.x, p.y);
        started = true;
      } else {
        ctx.lineTo(p.x, p.y);
      }
    }
    ctx.stroke();
  }
  ctx.setLineDash([]);

  /* Land dots — depth-shaded so the sphere reads as 3D */
  for (const dot of DOTS) {
    const v = rotate(dot, spin);
    const depth = (v.z + 1) / 2;
    if (v.z < -0.55) continue;
    const p = project(v, size);
    const front = Math.max(0, Math.min(1, depth * 1.15));
    ctx.fillStyle =
      v.z > 0
        ? `rgba(${theme.land},${0.2 + front * 0.55})`
        : `rgba(${theme.ocean},${0.05 + front * 0.12})`;
    ctx.beginPath();
    ctx.arc(p.x, p.y, (v.z > 0 ? 1.6 : 1.2) * p.s * (size / 420), 0, Math.PI * 2);
    ctx.fill();
  }

  /* Online client nodes — glow + expanding pulse ring */
  for (const node of ONLINE_VECS) {
    const v = rotate(node.vec, spin);
    if (v.z < -0.1) continue;
    const p = project(v, size);
    const color = node.soft ? theme.nodeSoft : theme.node;
    const fade = Math.max(0, Math.min(1, v.z + 0.4));

    const ring = ((t / 1400 + ONLINE.indexOf(node) * 0.31) % 1);
    ctx.fillStyle = `rgba(${color},${0.22 * (1 - ring) * fade})`;
    ctx.beginPath();
    ctx.arc(p.x, p.y, (6 + ring * 16) * (size / 420), 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = `rgba(${color},${0.25 * fade})`;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 9 * p.s * (size / 420), 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = `rgba(${color},${0.95 * fade})`;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 3.4 * p.s * (size / 420), 0, Math.PI * 2);
    ctx.fill();
  }
}

/**
 * Canvas-rendered 3D globe: real spherical projection of the land dot map,
 * rotating continuously with simulated "online client" nodes and arcs.
 * Static single frame under prefers-reduced-motion; pauses offscreen.
 */
export function RotatingGlobe({ className }: { className?: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const host = hostRef.current;
    if (!canvas || !host) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let theme = readTheme(document.documentElement);
    let size = 0;
    let visible = false;
    let raf = 0;
    let frame = 0;

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");

    const draw = (t: number, force = false) => {
      frame += 1;
      if (!size || (!force && frame % 2 === 0)) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      paint(ctx, size, t * 0.00016, t, theme);
    };

    const loop = (t: number) => {
      draw(t);
      raf = requestAnimationFrame(loop);
    };

    const sync = () => {
      cancelAnimationFrame(raf);
      if (reduced.matches) {
        draw(2200, true);
      } else if (visible && size > 0) {
        raf = requestAnimationFrame(loop);
      }
    };

    const resize = new ResizeObserver(([entry]) => {
      size = Math.min(entry.contentRect.width, 720);
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = size * dpr;
      canvas.height = size * dpr;
      canvas.style.width = `${size}px`;
      canvas.style.height = `${size}px`;
      draw(2200, true);
      sync();
    });
    resize.observe(host);

    const observer = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
      sync();
    });
    observer.observe(host);

    const themeWatch = new MutationObserver(() => {
      theme = readTheme(document.documentElement);
      draw(performance.now(), true);
    });
    themeWatch.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "data-theme", "style"],
    });

    const motionChange = () => sync();
    reduced.addEventListener("change", motionChange);

    return () => {
      cancelAnimationFrame(raf);
      resize.disconnect();
      observer.disconnect();
      themeWatch.disconnect();
      reduced.removeEventListener("change", motionChange);
    };
  }, []);

  return (
    <div ref={hostRef} className={cn("mx-auto aspect-square w-full", className)}>
      <canvas
        ref={canvasRef}
        role="img"
        aria-label="Rotating globe showing online ISP CENTRIC client regions worldwide"
      />
    </div>
  );
}
