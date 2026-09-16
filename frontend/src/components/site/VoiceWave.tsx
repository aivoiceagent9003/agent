import { useEffect, useRef, type RefObject } from "react";
import { orbBus } from "./orbBus";

// AnswerLabs voice field: a bundle of waveform lines that runs across the whole
// hero and swells as it passes through a glowing orb — the voice going through
// the agent. It paints straight onto the page background (no card, no stage),
// so it has to read on ivory and on the dark theme alike.
//
// The canvas fills its positioned parent. The orb sits at the centre of
// `anchorRef`, a layout placeholder, so it always lands exactly where the grid
// puts the art column. Purely decorative: it never touches the microphone or
// the call transport, it only reads the shared activity bus.

const TAU = Math.PI * 2;
type RGB = readonly [number, number, number];

const rgba = (c: RGB, a: number) => `rgba(${c[0]},${c[1]},${c[2]},${a < 0 ? 0 : a.toFixed(3)})`;

// Forest & Ivory. On ivory the waves are ink-like forest greens; on the dark
// theme they turn to mint light. Brass is one accent line, never the body.
const INK = {
  light: {
    lines: [
      [41, 77, 60],
      [47, 110, 82],
      [82, 140, 105],
    ] as RGB[],
    accent: [161, 124, 67] as RGB,
    alpha: 0.5,
    width: 1.15,
  },
  dark: {
    lines: [
      [121, 214, 172],
      [156, 230, 197],
      [96, 186, 146],
    ] as RGB[],
    accent: [213, 179, 119] as RGB,
    alpha: 0.5,
    width: 1.05,
  },
};

// Light that moves inside the orb. Each blob orbits the centre on its own
// clock, so the glass looks full of slowly turning liquid.
const BLOBS: Array<{
  c: RGB;
  a: number;
  size: number;
  orbit: number;
  speed: number;
  phase: number;
}> = [
  { c: [82, 170, 126], a: 0.7, size: 0.95, orbit: 0.25, speed: -0.21, phase: 1.2 },
  { c: [121, 214, 172], a: 0.9, size: 0.75, orbit: 0.38, speed: 0.43, phase: 0 },
  { c: [236, 246, 232], a: 0.55, size: 0.45, orbit: 0.42, speed: -0.33, phase: 2.1 },
  { c: [213, 179, 119], a: 0.22, size: 0.5, orbit: 0.5, speed: 0.27, phase: 4 },
];

export function VoiceWave({
  anchorRef,
  tone = "auto",
  className = "",
}: {
  anchorRef?: RefObject<HTMLElement | null>;
  tone?: "auto" | "dark";
  className?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const host = canvas?.parentElement;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !host || !ctx) return;

    const motion = matchMedia("(prefers-reduced-motion: reduce)");
    let W = 0;
    let H = 0;
    let dpr = 1;
    let frame = 0;
    let visible = true;
    let hover = 0;
    let hoverTarget = 0;
    let px = 0;
    let py = 0;
    let tx = 0;
    let ty = 0;
    let burst = -1e5;
    const start = performance.now();

    function draw(now: number) {
      frame = 0;
      if (!ctx || !canvas || !host || !W || !H) return;
      const still = motion.matches;
      const t = still ? 4.2 : (now - start) / 1000;
      const dark = tone === "dark" || document.documentElement.classList.contains("dark");
      const ink = dark ? INK.dark : INK.light;

      px += (tx - px) * 0.06;
      py += (ty - py) * 0.06;
      hover += (hoverTarget - hover) * 0.06;
      const ripple = still ? 0 : Math.max(0, 1 - (now - burst) / 1500);
      const voice = still
        ? 0
        : orbBus.ripples.reduce((v, s) => Math.max(v, Math.max(0, 1 - (now - s) / 1400)), 0);
      const energy = Math.min(1.3, hover * 0.3 + ripple * 0.8 + voice * 0.75);
      const breathe = still ? 0.5 : Math.sin(t * 1.1) * 0.5 + 0.5;

      // Orb placement follows the anchor every frame, so font loading or a
      // reflow of the copy can never leave it off-centre.
      const hostRect = host.getBoundingClientRect();
      const anchor = anchorRef?.current?.getBoundingClientRect();
      const side = anchor ? Math.min(anchor.width, anchor.height) : Math.min(W, H) * 0.7;
      const ox = (anchor ? anchor.left - hostRect.left + anchor.width / 2 : W / 2) + px * 10;
      const oy = (anchor ? anchor.top - hostRect.top + anchor.height / 2 : H / 2) + py * 8;
      const r = side * 0.26;

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);

      const R = r * (1 + energy * 0.035 + breathe * 0.012);

      // ── Waveform ────────────────────────────────────────────────────────
      // Amplitude follows a bell centred on the orb: calm at the page edges,
      // full where it meets the orb. The alpha ramp keeps it faint behind the
      // headline so the copy always wins.
      ctx.globalCompositeOperation = dark ? "lighter" : "source-over";
      const lines = W < 640 ? 18 : 26;
      const fine = W < 640 ? 5 : 8;
      const sigma = Math.max(W * 0.34, r * 2.6);
      const amp = r * (0.62 + energy * 0.55 + breathe * 0.08);
      const f1 = TAU / (r * 2.3);
      const f2 = TAU / (r * 1.35);
      const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
      const anchorLeft = anchor ? anchor.left - hostRect.left : 0;
      const s1 = clamp01((anchorLeft - 40) / W);
      const s2 = clamp01(Math.max(s1 * W + 60, ox - r * 1.15) / W);
      const s3 = clamp01(Math.max(s2 * W, ox + r * 1.15) / W);
      // Segment count is the whole cost of the waves, so sample only where it
      // shows: coarse across the faint stretch behind the copy and on the flat
      // tails, fine near the orb, and not at all behind the opaque glass.
      const faintEnd = s1 * W;
      // Lines end once they are inside the glass, so the orb always covers
      // the cut — a straight cut left ends hanging outside the circle.
      const edge2 = R * 0.985 * (R * 0.985);

      for (let i = 0; i < lines; i++) {
        const k = i / (lines - 1);
        // Every line shares one speed. Different speeds let the lines drift out
        // of step over ~20s and tangle into a second, crossing form; with one
        // clock the ribbon keeps the same shape for as long as it runs.
        const phase = k * TAU * 0.42;
        const speed = 1;
        // Middle lines swing widest, outer lines hug the axis — the bundle
        // reads as one braided voice rather than parallel stripes.
        const weight = 0.3 + 0.7 * Math.sin(k * Math.PI);
        const lane = (k - 0.5) * r * 0.42;
        const accent = i % 9 === 4;
        const color = accent ? ink.accent : ink.lines[i % ink.lines.length];
        const a = ink.alpha * (accent ? 0.85 : 0.55 + 0.45 * weight);

        const grad = ctx.createLinearGradient(0, 0, W, 0);
        grad.addColorStop(0, rgba(color, a * 0.03));
        grad.addColorStop(s1, rgba(color, a * (dark ? 0.07 : 0.035)));
        grad.addColorStop(s2, rgba(color, a));
        grad.addColorStop(s3, rgba(color, a));
        grad.addColorStop(1, rgba(color, a * 0.3));

        ctx.beginPath();
        let x = 0;
        let pen = false;
        let prevX = 0;
        let prevY = 0;
        let prevInside = false;
        for (;;) {
          const dx = x - ox;
          const adx = dx < 0 ? -dx : dx;
          const env = Math.exp(-(dx * dx) / (2 * sigma * sigma));
          const e = 0.07 + 0.93 * env;
          // The waist: the ribbon narrows as it reaches the glass, so it feeds
          // into the orb around its centre line, where the inner threads start.
          const n = Math.min(1, Math.max(0, (adx - R) / (R * 1.2)));
          const squeeze = 0.4 + 0.6 * n * n * (3 - 2 * n);
          const wave =
            Math.sin(dx * f1 - t * speed + phase) * 0.62 +
            Math.sin(dx * f2 + t * speed * 0.72 + phase * 1.6) * 0.38;
          const y = oy + squeeze * (e * (amp * weight * wave) + lane * env);
          const dy = y - oy;
          const inside = dx * dx + dy * dy < edge2;
          if (pen) {
            // Entering the glass: draw one segment into it, then lift the pen.
            ctx.lineTo(x, y);
            if (inside) pen = false;
          } else if (!inside) {
            // Leaving the glass: start from the last point inside it, so the
            // line visibly emerges from the orb rather than beside it.
            if (prevInside) {
              ctx.moveTo(prevX, prevY);
              ctx.lineTo(x, y);
            } else ctx.moveTo(x, y);
            pen = true;
          }
          prevX = x;
          prevY = y;
          prevInside = inside;
          if (x >= W) break;
          const step = inside ? fine : x < faintEnd ? 16 : fine + (1 - env) * 10;
          x = Math.min(W, x + step);
        }
        ctx.strokeStyle = grad;
        ctx.lineWidth = ink.width * (accent ? 1.1 : 0.8 + weight * 0.5);
        ctx.stroke();
      }

      // ── Speaking rings ──────────────────────────────────────────────────
      ctx.globalCompositeOperation = "source-over";
      const rings = still ? [] : [...orbBus.ripples, burst];
      for (const stamp of rings) {
        const age = (now - stamp) / 1600;
        if (age < 0 || age > 1) continue;
        ctx.beginPath();
        ctx.arc(ox, oy, r * (1.02 + age * 0.9), 0, TAU);
        ctx.strokeStyle = rgba(
          dark ? [121, 214, 172] : [41, 77, 60],
          (1 - age) * (dark ? 0.4 : 0.3),
        );
        ctx.lineWidth = 1.4;
        ctx.stroke();
      }

      // ── Orb ─────────────────────────────────────────────────────────────

      // Aura: mint light spilling onto the page around the glass.
      const aura = ctx.createRadialGradient(ox, oy, R * 0.8, ox, oy, R * 2);
      aura.addColorStop(0, rgba([121, 214, 172], (dark ? 0.3 : 0.32) + energy * 0.08));
      aura.addColorStop(0.45, rgba([121, 214, 172], dark ? 0.1 : 0.08));
      aura.addColorStop(1, rgba([121, 214, 172], 0));
      ctx.fillStyle = aura;
      ctx.beginPath();
      ctx.arc(ox, oy, R * 2, 0, TAU);
      ctx.fill();

      ctx.save();
      ctx.beginPath();
      ctx.arc(ox, oy, R, 0, TAU);
      ctx.clip();

      const body = ctx.createRadialGradient(ox - R * 0.3, oy - R * 0.35, 0, ox, oy, R);
      body.addColorStop(0, "#43906b");
      body.addColorStop(0.55, "#235740");
      body.addColorStop(1, "#143426");
      ctx.fillStyle = body;
      ctx.fillRect(ox - R, oy - R, R * 2, R * 2);

      ctx.globalCompositeOperation = "screen";
      const swirl = 1 + energy * 0.9;
      for (const b of BLOBS) {
        const bx = ox + Math.cos(t * b.speed * swirl + b.phase) * R * b.orbit;
        const by = oy + Math.sin(t * b.speed * 1.3 * swirl + b.phase) * R * b.orbit * 0.9;
        const g = ctx.createRadialGradient(bx, by, 0, bx, by, R * b.size);
        g.addColorStop(0, rgba(b.c, b.a));
        g.addColorStop(1, rgba(b.c, 0));
        ctx.fillStyle = g;
        ctx.fillRect(ox - R, oy - R, R * 2, R * 2);
      }

      // The waveform carries on through the glass as bright threads.
      ctx.globalCompositeOperation = "lighter";
      for (let j = 0; j < 3; j++) {
        ctx.beginPath();
        for (let x = -R; x <= R; x += 3) {
          const inside = Math.cos((x / R) * (Math.PI / 2));
          const y =
            oy +
            Math.sin(x * f1 * 1.4 - t * (1.5 + j * 0.35) + j * 2.1) *
              R *
              (0.2 + energy * 0.14) *
              inside;
          if (x === -R) ctx.moveTo(ox + x, y);
          else ctx.lineTo(ox + x, y);
        }
        ctx.strokeStyle = rgba([236, 250, 242], 0.5 - j * 0.12);
        ctx.lineWidth = 1.6 - j * 0.3;
        ctx.stroke();
      }

      // Depth: the far edge darkens, the near edge catches a highlight.
      ctx.globalCompositeOperation = "source-over";
      const shade = ctx.createRadialGradient(
        ox - R * 0.25,
        oy - R * 0.3,
        R * 0.5,
        ox,
        oy,
        R * 1.05,
      );
      shade.addColorStop(0, "rgba(8,22,17,0)");
      shade.addColorStop(1, "rgba(8,22,17,0.3)");
      ctx.fillStyle = shade;
      ctx.fillRect(ox - R, oy - R, R * 2, R * 2);

      const spec = ctx.createRadialGradient(
        ox - R * 0.38,
        oy - R * 0.46,
        0,
        ox - R * 0.38,
        oy - R * 0.46,
        R * 0.5,
      );
      spec.addColorStop(0, "rgba(255,253,243,0.45)");
      spec.addColorStop(1, "rgba(255,253,243,0)");
      ctx.fillStyle = spec;
      ctx.fillRect(ox - R, oy - R, R * 2, R * 2);

      // Fresnel: light gathering at the silhouette is what makes it glass
      // rather than a painted ball.
      ctx.globalCompositeOperation = "screen";
      const fresnel = ctx.createRadialGradient(ox, oy, R * 0.7, ox, oy, R);
      fresnel.addColorStop(0, "rgba(156,230,197,0)");
      fresnel.addColorStop(1, "rgba(156,230,197,0.38)");
      ctx.fillStyle = fresnel;
      ctx.fillRect(ox - R, oy - R, R * 2, R * 2);
      ctx.globalCompositeOperation = "source-over";
      ctx.restore();

      ctx.beginPath();
      ctx.arc(ox, oy, R - 0.5, 0, TAU);
      ctx.strokeStyle = rgba(dark ? [156, 230, 197] : [255, 253, 243], dark ? 0.35 : 0.3);
      ctx.lineWidth = 1;
      ctx.stroke();

      if (visible && !document.hidden && !still) frame = requestAnimationFrame(draw);
    }

    const schedule = () => {
      if (!frame && visible && !document.hidden) frame = requestAnimationFrame(draw);
    };

    const resize = () => {
      const rect = host.getBoundingClientRect();
      W = rect.width;
      H = rect.height;
      if (!W || !H) return;
      // Capped by total pixels: a full-width hero at 2x is a lot of canvas for
      // lines this soft.
      dpr = Math.max(1, Math.min(devicePixelRatio || 1, 2, Math.sqrt(2e6 / (W * H))));
      canvas.width = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
      schedule();
    };
    const sizer = new ResizeObserver(resize);
    sizer.observe(host);
    if (anchorRef?.current) sizer.observe(anchorRef.current);

    const intersection = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
      if (visible) schedule();
      else {
        cancelAnimationFrame(frame);
        frame = 0;
      }
    });
    intersection.observe(canvas);

    // Theme changes only matter for the frozen reduced-motion frame; the
    // animated loop reads the theme every frame anyway.
    const theme = new MutationObserver(schedule);
    theme.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });

    const move = (event: PointerEvent) => {
      if (motion.matches) return;
      const rect = host.getBoundingClientRect();
      tx = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      ty = ((event.clientY - rect.top) / rect.height) * 2 - 1;
      const a = anchorRef?.current?.getBoundingClientRect();
      hoverTarget =
        a &&
        event.clientX >= a.left &&
        event.clientX <= a.right &&
        event.clientY >= a.top &&
        event.clientY <= a.bottom
          ? 1
          : 0;
    };
    const leave = () => {
      tx = ty = hoverTarget = 0;
    };
    const pulse = () => {
      burst = performance.now();
      schedule();
    };
    const visibility = () => {
      if (document.hidden) {
        cancelAnimationFrame(frame);
        frame = 0;
      } else schedule();
    };

    const anchorEl = anchorRef?.current;
    host.addEventListener("pointermove", move);
    host.addEventListener("pointerleave", leave);
    anchorEl?.addEventListener("click", pulse);
    document.addEventListener("visibilitychange", visibility);
    motion.addEventListener("change", schedule);

    return () => {
      cancelAnimationFrame(frame);
      sizer.disconnect();
      intersection.disconnect();
      theme.disconnect();
      host.removeEventListener("pointermove", move);
      host.removeEventListener("pointerleave", leave);
      anchorEl?.removeEventListener("click", pulse);
      document.removeEventListener("visibilitychange", visibility);
      motion.removeEventListener("change", schedule);
    };
  }, [anchorRef, tone]);

  return <canvas ref={canvasRef} className={`voice-wave ${className}`} aria-hidden="true" />;
}
