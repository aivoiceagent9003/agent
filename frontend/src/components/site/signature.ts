// Which "living voice" signature is shown. Persisted so the choice sticks, with
// a tiny subscribe so the switcher and the canvas stay in sync at runtime.
export type Variant = "bloom" | "orb" | "spectrum" | "ribbon";

const KEY = "vocera_signature";
let current: Variant = "bloom";
if (typeof window !== "undefined") {
  const saved = window.localStorage.getItem(KEY);
  if (saved === "bloom" || saved === "orb" || saved === "spectrum" || saved === "ribbon") current = saved;
}

const subs = new Set<() => void>();

export function getSignature(): Variant {
  return current;
}
export function setSignature(v: Variant) {
  current = v;
  if (typeof window !== "undefined") window.localStorage.setItem(KEY, v);
  subs.forEach((f) => f());
}
export function subscribeSignature(fn: () => void) {
  subs.add(fn);
  return () => {
    subs.delete(fn);
  };
}
