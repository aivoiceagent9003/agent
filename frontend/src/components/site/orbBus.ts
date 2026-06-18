// orbBus — a tiny shared channel so any screen can make the one global orb
// react (a call starts, a reply lands). The OrbField reads this every frame;
// activity decays back to its calm idle on its own.
export const orbBus = {
  activityTarget: 0.18,
  ripples: [] as number[],
};

// Spike the orb and emit a voice ripple — call on each conversation turn.
export function orbPulse() {
  orbBus.activityTarget = 0.95;
  orbBus.ripples.push(typeof performance !== "undefined" ? performance.now() : Date.now());
}
