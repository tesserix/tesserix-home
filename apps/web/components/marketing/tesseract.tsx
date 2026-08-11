"use client";

import { useEffect, useRef } from "react";

interface TesseractProps {
  className?: string;
}

interface ProjectedPoint {
  x: number;
  y: number;
  d: number;
}

export function Tesseract({ className }: TesseractProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    let W = 0;
    let H = 0;
    let resizeTimeout: ReturnType<typeof setTimeout> | undefined;
    let reduced = window.matchMedia("(prefers-reduced-motion: reduce)")
      .matches;
    let isVisible = true;
    let animationId: number | null = null;

    function size(): void {
      if (!canvas || !ctx) return;
      W = canvas.clientWidth;
      H = canvas.clientHeight;
      canvas.width = W * dpr;
      canvas.height = H * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    size();

    function handleResize(): void {
      clearTimeout(resizeTimeout);
      resizeTimeout = setTimeout(() => {
        size();
        // A reduced-motion viewer never re-enters the rAF loop, so a resize
        // (rotation, window drag) would otherwise leave the canvas showing a
        // frame drawn at the old size until something else redraws it.
        if (reduced) frame(16000);
      }, 150);
    }

    window.addEventListener("resize", handleResize);

    // Vertices of 4D unit hypercube
    const verts: Array<[number, number, number, number]> = [];
    for (let i = 0; i < 16; i++) {
      verts.push([
        i & 1 ? 1 : -1,
        i & 2 ? 1 : -1,
        i & 4 ? 1 : -1,
        i & 8 ? 1 : -1,
      ]);
    }

    // Edges connect vertices differing by exactly one bit
    const edges: Array<[number, number]> = [];
    for (let a = 0; a < 16; a++) {
      for (let b = a + 1; b < 16; b++) {
        const x = a ^ b;
        if ((x & (x - 1)) === 0) {
          edges.push([a, b]);
        }
      }
    }

    function rot(
      v: [number, number, number, number],
      i: number,
      j: number,
      ang: number
    ): [number, number, number, number] {
      const c = Math.cos(ang);
      const s = Math.sin(ang);
      const out: [number, number, number, number] = [...v];
      out[i] = v[i] * c - v[j] * s;
      out[j] = v[i] * s + v[j] * c;
      return out;
    }

    function frame(t: number): void {
      if (!ctx || !canvas) return;
      ctx.clearRect(0, 0, W, H);
      const time = t / 1000;
      const cx = W / 2;
      const cy = H / 2;
      const scale = Math.min(W, H) * 0.135;

      const proj: ProjectedPoint[] = verts.map((v) => {
        let p = rot(v, 0, 3, time * 0.22);
        p = rot(p, 1, 2, time * 0.15);
        p = rot(p, 0, 2, 0.4 + time * 0.04);

        const wd = 3.4 / (3.4 - p[3]);
        const x3 = p[0] * wd;
        const y3 = p[1] * wd;
        const z3 = p[2] * wd;

        const zd = 4.6 / (4.6 - z3);

        return {
          x: cx + x3 * zd * scale,
          y: cy + y3 * zd * scale,
          d: (wd + zd) / 2,
        };
      });

      ctx.lineCap = "round";

      // Draw edges: depth decides everything
      for (let e = 0; e < edges.length; e++) {
        const p1 = proj[edges[e][0]];
        const p2 = proj[edges[e][1]];
        const depth = (p1.d + p2.d) / 2;
        const tt = Math.max(0, Math.min(1, (depth - 0.78) / 0.67));

        if (tt > 0.72) {
          const ct = (tt - 0.72) / 0.28;
          ctx.strokeStyle = `rgba(31, 63, 212, ${(0.45 + ct * 0.4).toFixed(3)})`;
          ctx.lineWidth = 1.6 + ct * 1.2;
        } else {
          ctx.strokeStyle = `rgba(11, 14, 20, ${(0.18 + tt * 0.5).toFixed(3)})`;
          ctx.lineWidth = 0.8 + tt * 1.5;
        }

        ctx.beginPath();
        ctx.moveTo(p1.x, p1.y);
        ctx.lineTo(p2.x, p2.y);
        ctx.stroke();
      }

      // Draw vertices
      for (let v2 = 0; v2 < proj.length; v2++) {
        const pv = proj[v2];
        const vt = Math.max(0.25, Math.min(1, (pv.d - 0.78) / 0.67));
        ctx.globalAlpha = Math.min(1, vt + 0.1);
        ctx.fillStyle = vt > 0.72 ? "#1f3fd4" : "#0b0e14";
        ctx.beginPath();
        ctx.arc(pv.x, pv.y, 1.2 + 2.2 * vt, 0, 6.2832);
        ctx.fill();
      }

      ctx.globalAlpha = 1;
    }

    function run(t: number): void {
      frame(t || 0);
      animationId = requestAnimationFrame(run);
    }

    function startAnimation(): void {
      if (reduced || animationId !== null) return;
      animationId = requestAnimationFrame(run);
    }

    function stopAnimation(): void {
      if (animationId !== null) {
        cancelAnimationFrame(animationId);
        animationId = null;
      }
    }

    if (reduced) {
      frame(16000);
    } else {
      startAnimation();
    }

    // Pause the rAF loop while the canvas is off-screen — it's decorative,
    // so there's no reason to keep animating it once it scrolls out of view.
    const intersectionObserver = new IntersectionObserver(([entry]) => {
      isVisible = entry.isIntersecting;
      if (isVisible) {
        if (reduced) {
          frame(16000);
        } else {
          startAnimation();
        }
      } else {
        stopAnimation();
      }
    });
    intersectionObserver.observe(canvas);

    // Switch modes live if the OS-level reduced-motion setting changes
    // mid-session, rather than requiring a reload to take effect.
    const motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    function handleMotionChange(event: MediaQueryListEvent): void {
      reduced = event.matches;
      if (reduced) {
        stopAnimation();
        frame(16000);
      } else if (isVisible) {
        startAnimation();
      }
    }
    motionQuery.addEventListener("change", handleMotionChange);

    return () => {
      stopAnimation();
      intersectionObserver.disconnect();
      motionQuery.removeEventListener("change", handleMotionChange);
      clearTimeout(resizeTimeout);
      window.removeEventListener("resize", handleResize);
    };
  }, []);

  return (
    <canvas ref={canvasRef} aria-hidden="true" className={className} />
  );
}
