// Shared visual activity channel. The page's sculpture reads this without
// changing voice transport or call state. Legacy renderers use the same signal.
export const orbBus = {
  activityTarget: 0.18,
  ripples: [] as number[],
};

// Spike the orb and emit a voice ripple — call on each conversation turn.
export function orbPulse() {
  orbBus.activityTarget = 0.95;
  const now = typeof performance !== "undefined" ? performance.now() : Date.now();
  // Keep this bounded even if reduced motion pauses the visual renderer.
  orbBus.ripples = [...orbBus.ripples.filter(stamp => now - stamp < 2600), now].slice(-12);
}
