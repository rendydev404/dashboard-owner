// Hub SSE sederhana di memori (1 proses).
import type { ServerEvent } from "@iklan/shared";

type Listener = (e: ServerEvent) => void;
const listeners = new Set<Listener>();

export function subscribe(fn: Listener) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
export function emit(e: ServerEvent) {
  for (const fn of listeners) {
    try { fn(e); } catch { /* listener rusak diabaikan */ }
  }
}
export const listenerCount = () => listeners.size;
