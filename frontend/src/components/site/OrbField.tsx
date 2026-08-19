import { useEffect, useRef } from "react";
import { orbBus } from "./orbBus";

// The "living voice" signature. Several renderers share one canvas, all breathing
// + scroll-expanding + reactive (orbBus):
//   bloom    — morphing concentric voice rings
//   orb      — the voice orb
//   spectrum — radial equalizer (Siri-style), bars pulse with speech
//   ribbon   — a flowing live waveform
//
// Which one renders is decided by the route in __root.tsx and passed in. It used
// to come from a localStorage store with a floating switcher, which meant the
// marketing page's identity depended on whatever a visitor last clicked.
export type Variant = "bloom" | "orb" | "spectrum" | "ribbon";

type Harmonic = { k: number; a: number; p: number; s: number };
type Layer = {
  scale: number;
  spread: number;
  alpha: number;
  hsl: [number, number, number];
  harm: Harmonic[];
  depth: number;
};

const LAYERS: Layer[] = [
  {
    scale: 1.06,
    spread: 1.4,
    alpha: 0.16,
    hsl: [262, 82, 66],
    depth: 1.0,
    harm: [
      { k: 2, a: 0.07, p: 0.0, s: 0.5 },
      { k: 3, a: 0.05, p: 1.2, s: -0.7 },
      { k: 5, a: 0.03, p: 2.1, s: 0.9 },
    ],
  },
  {
    scale: 0.92,
    spread: 1.1,
    alpha: 0.16,
    hsl: [205, 88, 62],
    depth: 0.7,
    harm: [
      { k: 3, a: 0.06, p: 0.8, s: -0.6 },
      { k: 4, a: 0.045, p: 2.0, s: 0.8 },
      { k: 6, a: 0.025, p: 0.3, s: -1.0 },
    ],
  },
  {
    scale: 0.74,
    spread: 0.8,
    alpha: 0.15,
    hsl: [18, 92, 67],
    depth: 0.45,
    harm: [
      { k: 2, a: 0.08, p: 1.6, s: 0.7 },
      { k: 5, a: 0.04, p: 0.5, s: -0.9 },
    ],
  },
];

export function OrbField({ variant }: { variant: Variant }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pointer = useRef({ x: 0, y: 0, tx: 0, ty: 0 });
  const activity = useRef(0.18);
  // Held in a ref so the animation loop reads it without the prop change tearing
  // down and restarting the canvas.
  const variantRef = useRef<Variant>(variant);
  variantRef.current = variant;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d", { alpha: true });
    if (!ctx) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    let W = 0,
      H = 0,
      cx = 0,
      cy = 0,
      baseR = 0;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    function resize() {
      W = canvas!.width = Math.floor(window.innerWidth * dpr);
      H = canvas!.height = Math.floor(window.innerHeight * dpr);
      cx = W / 2;
      cy = H * 0.42;
      baseR = Math.min(W, H) * 0.24;
    }
    resize();
    window.addEventListener("resize", resize);

    function onMove(e: MouseEvent) {
      pointer.current.tx = (e.clientX / window.innerWidth - 0.5) * 2;
      pointer.current.ty = (e.clientY / window.innerHeight - 0.5) * 2;
    }
    window.addEventListener("mousemove", onMove);

    let scrollTarget = 0,
      disp = 0;
    function onScroll() {
      const max = document.documentElement.scrollHeight - window.innerHeight;
      scrollTarget = max > 0 ? Math.min(1, Math.max(0, window.scrollY / max)) : 0;
    }
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();

    const bars = Array.from({ length: 84 }, () => Math.random());

    // particle sphere (orb)
    const PN = window.innerWidth < 768 ? 1100 : 1700;
    const GA = Math.PI * (3 - Math.sqrt(5));
    type Pt = { x: number; y: number; z: number; hue: number; spread: number };
    const pts: Pt[] = [];
    for (let i = 0; i < PN; i++) {
      const y = 1 - (i / (PN - 1)) * 2;
      const r = Math.sqrt(Math.max(0, 1 - y * y));
      const th = i * GA;
      const tt = (y + 1) / 2;
      pts.push({
        x: Math.cos(th) * r,
        y,
        z: Math.sin(th) * r,
        hue: 250 + Math.sin(th) * 38 + tt * 30 + (Math.random() - 0.5) * 20,
        spread: 0.4 + Math.random() * 1.3,
      });
    }

    function coreGlow(disp: number, a: number) {
      const g = ctx!.createRadialGradient(cx, cy, 0, cx, cy, baseR * 2.1 * (1 + disp));
      g.addColorStop(0, `hsla(262, 80%, 70%, ${0.06 + a * 0.05})`);
      g.addColorStop(1, "hsla(262, 80%, 70%, 0)");
      ctx!.fillStyle = g;
      ctx!.fillRect(0, 0, W, H);
    }

    function ripples(now: number, disp: number) {
      orbBus.ripples = orbBus.ripples.filter((s) => now - s < 2600);
      for (const s of orbBus.ripples) {
        const age = (now - s) / 2600;
        ctx!.beginPath();
        ctx!.arc(cx, cy, baseR * (0.85 + age * 1.9) * (1 + disp), 0, Math.PI * 2);
        ctx!.strokeStyle = `hsla(${262 - age * 40}, 85%, 62%, ${(1 - age) * 0.16})`;
        ctx!.lineWidth = 1.5 * dpr;
        ctx!.stroke();
      }
    }

    // ── bloom ────────────────────────────────────────────────────────────────
    function blob(L: Layer, t: number, amp: number, R: number, ox: number, oy: number) {
      ctx!.beginPath();
      for (let i = 0; i <= 140; i++) {
        const th = (i / 140) * Math.PI * 2;
        let r = 1;
        for (const h of L.harm) r += h.a * amp * Math.sin(h.k * th + h.p + t * h.s);
        const rr = R * r;
        const x = cx + ox + Math.cos(th) * rr;
        const y = cy + oy + Math.sin(th) * rr;
        if (i === 0) ctx!.moveTo(x, y);
        else ctx!.lineTo(x, y);
      }
      ctx!.closePath();
    }
    function drawBloom(t: number, a: number, disp: number, breathe: number, now: number) {
      coreGlow(disp, a);
      ripples(now, disp);
      for (const L of LAYERS) {
        const amp = (1 + a * 1.4) * breathe;
        const R = baseR * L.scale * (1 + disp * L.spread);
        const ox = pointer.current.x * 16 * dpr * L.depth;
        const oy = pointer.current.y * 12 * dpr * L.depth;
        blob(L, t, amp, R, ox, oy);
        const grad = ctx!.createRadialGradient(
          cx + ox,
          cy + oy,
          R * 0.15,
          cx + ox,
          cy + oy,
          R * 1.25,
        );
        const [h, s, l] = L.hsl;
        grad.addColorStop(
          0,
          `hsla(${h}, ${s}%, ${l}%, ${(L.alpha + a * 0.06) * (1 - disp * 0.3)})`,
        );
        grad.addColorStop(1, `hsla(${h}, ${s}%, ${l}%, 0)`);
        ctx!.fillStyle = grad;
        ctx!.fill();
      }
      const mid = LAYERS[1];
      blob(
        mid,
        t,
        (1 + a * 1.4) * breathe,
        baseR * mid.scale * (1 + disp * mid.spread),
        pointer.current.x * 16 * dpr * mid.depth,
        pointer.current.y * 12 * dpr * mid.depth,
      );
      ctx!.strokeStyle = `hsla(258, 78%, 60%, ${(0.22 + a * 0.12) * (1 - disp * 0.5)})`;
      ctx!.lineWidth = 1.4 * dpr;
      ctx!.stroke();
    }

    // ── particle orb ───────────────────────────────────────────────────────────
    function drawOrb(t: number, a: number, disp: number, breathe: number, now: number) {
      coreGlow(disp, a);
      ripples(now, disp);
      const ay = t * 0.1 + pointer.current.x * 0.4;
      const ax = Math.sin(t * 0.08) * 0.1 + pointer.current.y * 0.25;
      const cosY = Math.cos(ay),
        sinY = Math.sin(ay),
        cosX = Math.cos(ax),
        sinX = Math.sin(ax);
      for (const p of pts) {
        const x = p.x * cosY - p.z * sinY;
        let z = p.x * sinY + p.z * cosY;
        let y = p.y;
        const y2 = y * cosX - z * sinX;
        z = y * sinX + z * cosX;
        y = y2;
        const radius = baseR * breathe * (1 + disp * (0.8 + p.spread));
        const sx = cx + x * radius;
        const sy = cy + y * radius;
        const depth = (z + 1) / 2;
        const size = (0.6 + depth * 1.9) * dpr * (1 - disp * 0.15);
        const alpha = (0.16 + depth * 0.5) * (1 - disp * 0.25);
        const light = 52 + depth * 17;
        ctx!.fillStyle = `hsla(${p.hue + a * 14}, 80%, ${light}%, ${alpha})`;
        ctx!.fillRect(sx - size / 2, sy - size / 2, size, size);
      }
    }

    // ── radial spectrum ────────────────────────────────────────────────────────
    function drawSpectrum(t: number, a: number, disp: number, breathe: number, now: number) {
      coreGlow(disp, a);
      ripples(now, disp);
      const NB = bars.length;
      const r0 = baseR * 0.52 * breathe * (1 + disp * 0.8);
      const maxLen = baseR * 0.52 * (1 + disp * 0.6);
      ctx!.lineCap = "round";
      const bw = Math.max(2, ((2 * Math.PI * r0) / NB) * 0.46);
      for (let i = 0; i < NB; i++) {
        const th = (i / NB) * Math.PI * 2;
        const seed = bars[i];
        const s =
          Math.sin(th * 3 + t * 1.7) +
          Math.sin(th * 6 - t * 1.2 + seed * 6.28) +
          Math.sin(t * 2.4 + seed * 9);
        let amp = Math.max(0.16, 0.45 + 0.18 * s);
        amp *= 0.55 + a * 1.1;
        const len = maxLen * Math.min(1.35, amp);
        const c = Math.cos(th),
          sn = Math.sin(th);
        const hue = 255 - Math.min(1, len / maxLen) * (255 - 22);
        ctx!.strokeStyle = `hsla(${hue}, 82%, 62%, ${0.55 * (1 - disp * 0.4)})`;
        ctx!.lineWidth = bw;
        ctx!.beginPath();
        ctx!.moveTo(cx + c * r0, cy + sn * r0);
        ctx!.lineTo(cx + c * (r0 + len), cy + sn * (r0 + len));
        ctx!.stroke();
      }
      ctx!.beginPath();
      ctx!.arc(cx, cy, r0, 0, Math.PI * 2);
      ctx!.strokeStyle = `hsla(258, 70%, 60%, ${0.25 * (1 - disp * 0.4)})`;
      ctx!.lineWidth = 1.2 * dpr;
      ctx!.stroke();
    }

    // ── live waveform ribbon ─────────────────────────────────────────────────────
    const WAVES = [
      { f: 1.2, ph: 0.0, sp: 1.5, hue: 262, al: 0.55, k: 0.8 },
      { f: 1.8, ph: 1.5, sp: -1.1, hue: 208, al: 0.45, k: 0.55 },
      { f: 2.6, ph: 0.7, sp: 0.9, hue: 18, al: 0.4, k: 0.4 },
    ];
    function drawRibbon(t: number, a: number, _disp: number, breathe: number) {
      const span = W * 0.92;
      const x0 = cx - span / 2;
      const amp0 = baseR * 0.55 * breathe * (0.55 + a * 1.2);
      ctx!.lineCap = "round";
      ctx!.lineJoin = "round";
      for (const L of WAVES) {
        ctx!.beginPath();
        for (let i = 0; i <= 180; i++) {
          const x = x0 + (i / 180) * span;
          const nx = (x - cx) / (span / 2);
          const env = Math.exp(-nx * nx * 1.1);
          const y =
            cy +
            Math.sin(nx * Math.PI * L.f * 3 + t * L.sp + L.ph) * amp0 * L.k * env +
            Math.sin(nx * Math.PI * L.f * 7 - t * L.sp * 0.7) * amp0 * L.k * 0.4 * env;
          if (i === 0) ctx!.moveTo(x, y);
          else ctx!.lineTo(x, y);
        }
        ctx!.strokeStyle = `hsla(${L.hue}, 82%, 62%, ${L.al})`;
        ctx!.lineWidth = 2.4 * dpr;
        ctx!.stroke();
      }
    }

    let raf = 0;
    const t0 = performance.now();

    function frame(now: number) {
      const t = (now - t0) / 1000;
      orbBus.activityTarget += (0.18 - orbBus.activityTarget) * 0.006;
      activity.current += (orbBus.activityTarget - activity.current) * 0.05;
      pointer.current.x += (pointer.current.tx - pointer.current.x) * 0.03;
      pointer.current.y += (pointer.current.ty - pointer.current.y) * 0.03;
      disp += (scrollTarget - disp) * 0.07;
      const a = activity.current;
      const breathe = 1 + 0.02 * Math.sin(t * 1.4) + a * 0.06 * Math.sin(t * 5);

      ctx!.clearRect(0, 0, W, H);
      ctx!.globalCompositeOperation = "source-over";

      const v = variantRef.current;
      if (v === "orb") drawOrb(t, a, disp, breathe, now);
      else if (v === "spectrum") drawSpectrum(t, a, disp, breathe, now);
      else if (v === "ribbon") drawRibbon(t, a, disp, breathe);
      else drawBloom(t, a, disp, breathe, now);

      if (!reduce) raf = requestAnimationFrame(frame);
    }
    raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("scroll", onScroll);
    };
  }, []);

  return (
    <div aria-hidden className="pointer-events-none fixed inset-0 -z-10 overflow-hidden">
      <div
        className="absolute -top-[14%] left-[8%] w-[48vw] h-[48vw] rounded-full blur-[150px] opacity-50 animate-aurora"
        style={{ background: "radial-gradient(circle, #d7ccff, transparent 65%)" }}
      />
      <div
        className="absolute top-[26%] right-[4%] w-[44vw] h-[44vw] rounded-full blur-[160px] opacity-40 animate-aurora [animation-delay:-7s]"
        style={{ background: "radial-gradient(circle, #c8e6ff, transparent 65%)" }}
      />
      <canvas
        ref={canvasRef}
        className="absolute inset-0 w-full h-full"
        style={{ opacity: 0.95 }}
      />
      <div
        className="absolute inset-0"
        style={{
          background:
            "radial-gradient(100% 85% at 50% 40%, transparent 50%, var(--color-background) 100%)",
        }}
      />
    </div>
  );
}
