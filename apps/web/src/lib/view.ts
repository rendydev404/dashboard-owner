// State tampilan (tab, akun, periode) disimpan di URL supaya bisa dibagikan, dan diingat per perangkat.
import { useSyncExternalStore } from "react";
import { presetRange, clampRange, isDateKey, PRESETS, type Preset, type RangePreset } from "@iklan/shared";

export const TABS = ["ringkasan", "kampanye", "jam", "produk", "labarugi", "chat", "pengaturan"] as const;
export type Tab = (typeof TABS)[number];

export const SUBS = ["all", "fb", "lynk"] as const;
export type Sub = (typeof SUBS)[number];
export interface View { tab: Tab; sub: Sub; acc: string; preset: RangePreset; from: string; to: string }

const LS = "iklan-view";
let today = "";
let state: View = { tab: "ringkasan", sub: "all", acc: "all", preset: "7d", from: "", to: "" };
const subs = new Set<() => void>();

function readUrl(): Partial<View> {
  const u = new URL(location.href);
  const tab = u.hash.slice(1) as Tab;
  const p = u.searchParams.get("p");
  const out: Partial<View> = {};
  if ((TABS as readonly string[]).includes(tab)) out.tab = tab;
  if (u.searchParams.get("acc")) out.acc = u.searchParams.get("acc")!;
  const sub = u.searchParams.get("s") as Sub;
  if ((SUBS as readonly string[]).includes(sub)) out.sub = sub;
  if (p && (PRESETS as readonly string[]).includes(p)) out.preset = p as Preset;
  else if (isDateKey(u.searchParams.get("from")) && isDateKey(u.searchParams.get("to"))) {
    out.preset = "custom"; out.from = u.searchParams.get("from")!; out.to = u.searchParams.get("to")!;
  }
  return out;
}

function writeUrl() {
  const u = new URL(location.href);
  u.search = "";
  u.searchParams.set("acc", state.acc);
  if (state.sub !== "all") u.searchParams.set("s", state.sub);
  if (state.preset !== "custom") u.searchParams.set("p", state.preset);
  else { u.searchParams.set("from", state.from); u.searchParams.set("to", state.to); }
  u.hash = state.tab;
  history.replaceState(null, "", u);
  try { localStorage.setItem(LS, JSON.stringify({ acc: state.acc, preset: state.preset === "custom" ? "7d" : state.preset })); } catch { /* abaikan */ }
}

function resolve(v: View): View {
  if (v.preset !== "custom") {
    const [from, to] = presetRange(v.preset, today);
    return { ...v, from, to };
  }
  const [from, to] = clampRange(v.from, v.to, today);
  return { ...v, from, to };
}

/** Dipanggil sekali setelah bootstrap (tahu tanggal server & daftar akun). */
export function initView(serverToday: string, validAcc: (a: string) => boolean) {
  today = serverToday;
  let saved: Partial<View> = {};
  try { saved = JSON.parse(localStorage.getItem(LS) || "{}"); } catch { /* abaikan */ }
  const merged = { ...state, ...saved, ...readUrl() };
  if (!validAcc(merged.acc)) merged.acc = "all";
  state = resolve(merged);
  writeUrl();
  subs.forEach((f) => f());
}

export function setView(patch: Partial<View>) {
  const next = resolve({ ...state, ...patch });
  if (JSON.stringify(next) === JSON.stringify(state)) return;
  if (patch.tab && patch.tab !== state.tab) window.scrollTo({ top: 0 });
  state = next;
  writeUrl();
  subs.forEach((f) => f());
}

export const getView = () => state;
export const getToday = () => today;
export function useView(): View {
  return useSyncExternalStore((f) => { subs.add(f); return () => subs.delete(f); }, () => state);
}

window.addEventListener("hashchange", () => {
  const t = location.hash.slice(1) as Tab;
  if ((TABS as readonly string[]).includes(t) && t !== state.tab) setView({ tab: t });
});
