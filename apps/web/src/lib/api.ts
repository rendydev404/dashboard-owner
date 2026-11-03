import { QueryClient, useQuery, keepPreviousData } from "@tanstack/react-query";
import type {
  Bootstrap, DashboardResp, CampaignsResp, HourlyResp, ProductsResp, PlResp, ManualResp, BotAction, FbResp, LynkResp,
  AutopilotResp, AgentRun, ChatAttachment,
} from "@iklan/shared";
import { useView } from "./view";

export class ApiError extends Error {
  constructor(message: string, public status: number) { super(message); }
}

export async function api<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, ...rest } = init;
  const res = await fetch(`/api${path}`, {
    credentials: "same-origin",
    ...rest,
    headers: { ...(json !== undefined ? { "Content-Type": "application/json" } : {}), ...(rest.headers ?? {}) },
    body: json !== undefined ? JSON.stringify(json) : rest.body,
  });
  // Sesi habis saat memakai app → kembalikan ke layar login (sekali, lewat reset bootstrap).
  // /bootstrap sendiri tidak memicu event ini supaya tidak terjadi loop 401.
  if (res.status === 401 && !path.startsWith("/auth/") && !path.startsWith("/bootstrap")) {
    window.dispatchEvent(new Event("iklan:unauthorized"));
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(body.error || `Gagal (${res.status})`, res.status);
  }
  return res.status === 204 ? (undefined as T) : res.json();
}

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 60_000,
      gcTime: 10 * 60_000,
      refetchOnWindowFocus: false,
      retry: (n, e) => !(e instanceof ApiError && e.status < 500) && n < 2,
    },
  },
});

export const useBootstrap = () =>
  useQuery({ queryKey: ["bootstrap"], queryFn: () => api<Bootstrap>("/bootstrap"), staleTime: 5 * 60_000 });

/** Query agregat yang mengikuti akun & periode aktif. Data lama tetap tampil saat berganti periode. */
function useRange<T>(name: string, opts: { withAcc?: boolean; enabled?: boolean } = {}) {
  const v = useView();
  const withAcc = opts.withAcc ?? true;
  const qs = new URLSearchParams({ ...(withAcc ? { acc: v.acc } : {}), from: v.from, to: v.to }).toString();
  return useQuery({
    queryKey: [name, withAcc ? v.acc : "-", v.from, v.to],
    queryFn: ({ signal }) => api<T>(`/${name}?${qs}`, { signal }),
    placeholderData: keepPreviousData,
    enabled: !!v.from && (opts.enabled ?? true),
  });
}
export const useDashboard = () => useRange<DashboardResp>("dashboard");
export const useCampaigns = () => useRange<CampaignsResp>("campaigns");
export const useHourly = () => useRange<HourlyResp>("hourly");
export const useProducts = () => useRange<ProductsResp>("products");
export const useFb = (enabled = true) => useRange<FbResp>("fb", { enabled });
export const useLynk = (enabled = true) => useRange<LynkResp>("lynk", { withAcc: false, enabled });
export const usePl = () => useRange<PlResp>("pl", { withAcc: false });
export const useManual = (limit: number) =>
  useQuery({ queryKey: ["manual", limit], queryFn: () => api<ManualResp>(`/manual?limit=${limit}`), placeholderData: keepPreviousData });

export function useAutopilot() {
  const v = useView();
  return useQuery({
    queryKey: ["autopilot", v.acc],
    queryFn: ({ signal }) => api<AutopilotResp>(`/autopilot?acc=${encodeURIComponent(v.acc)}`, { signal }),
    placeholderData: keepPreviousData,
    staleTime: 25_000,
  });
}

export const actionsApi = {
  create: (campaignId: string, action: "pause" | "activate" | "scale") => api<BotAction>("/actions", { method: "POST", json: { campaignId, action } }),
  get: (id: number) => api<BotAction>(`/actions/${id}`),
  confirm: (id: number) => api<BotAction>(`/actions/${id}/confirm`, { method: "POST" }),
  cancel: (id: number) => api<BotAction>(`/actions/${id}/cancel`, { method: "POST" }),
  revert: (id: number) => api<BotAction>(`/actions/${id}/revert`, { method: "POST" }),
};

export const autopilotApi = {
  run: (accountId?: string) => api<{ skippedLock?: boolean; runs: AgentRun[] }>("/autopilot/run", { method: "POST", json: accountId ? { accountId } : {} }),
  uploadMedia: (file: File) =>
    api<ChatAttachment>("/chat/media", {
      method: "PUT",
      headers: { "Content-Type": file.type || "application/octet-stream", "X-File-Name": encodeURIComponent(file.name) },
      body: file,
    }),
  createAsset: (payload: Record<string, unknown>) => api<{ id: number; note?: string }>("/product-assets", { method: "POST", json: payload }),
  updateAsset: (id: number, payload: Record<string, unknown>) => api<{ ok: boolean }>(`/product-assets/${id}`, { method: "PATCH", json: payload }),
};

/** Invalidasi semua data agregat (dipakai setelah input/aksi & saat SSE melapor versi baru). */
export function refreshData() {
  return queryClient.invalidateQueries({ predicate: (q) => q.queryKey[0] !== "me" });
}
