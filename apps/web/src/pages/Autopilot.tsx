import { useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import {
  Cpu, Play, ShieldCheck, ShieldAlert, TrendingUp, TrendingDown, Sliders, Plus, Upload,
  Image as ImageIcon, Video, FileText, CheckCircle2, AlertTriangle, Clock3, RotateCcw,
  Layers, Package, Brain, Archive, ExternalLink, PauseCircle, ArrowUpRight, XCircle, Sparkles, RefreshCw,
} from "lucide-react";
import {
  rp, rpk, dec, parseRp, LINES,
  type Account, type AgentDecisionLog, type AgentMemory, type AgentRun, type AutopilotAccountSummary,
  type BotAction, type BotMode, type ChatAttachment, type ProductAsset, type ProductUnitEcon,
} from "@iklan/shared";
import { api, actionsApi, autopilotApi, refreshData, useAutopilot, useBootstrap, ApiError } from "../lib/api";
import { actionSummary } from "../lib/campaign-action";
import {
  Card, CardHead, CustomSelect, CustomSwitch, EmptyState, ErrorState, Modal, Skeleton, confirmDialog, cx, toast,
} from "../components/ui";

/* ------------------------------------------------------------------ konstanta label & helper */

type SubTab = "runs" | "assets" | "memories";

const MODE_SEGMENTS: { value: BotMode; label: string; short: string }[] = [
  { value: "off", label: "Nonaktif", short: "Off" },
  { value: "suggest", label: "Mode Saran", short: "Saran" },
  { value: "auto", label: "Full Autopilot", short: "Full Auto" },
];

const ANGLE_NAMES: Record<string, string> = {
  pain_agitation: "Pain-Agitation-Solution",
  outcome_mechanism: "Outcome & Mekanisme",
  direct_offer: "Direct Offer & Value Stack",
  qualification_proof: "Kualifikasi & Bukti Nyata",
  contrarian_efficiency: "Efisiensi vs Cara Manual",
};

function formatSingleAngle(item: string): string {
  const token = item.trim();
  const base = Object.keys(ANGLE_NAMES).find((k) => token.startsWith(k));
  if (!base) return token.replace(/_/g, " ");
  const suffix = token.slice(base.length).replace(/^_/, "");
  return suffix ? `${ANGLE_NAMES[base]} (${suffix.toUpperCase()})` : ANGLE_NAMES[base];
}

function formatAngle(raw: string | null | undefined): string {
  if (!raw) return "Eksperimen Kreatif";
  return raw
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map(formatSingleAngle)
    .join(" + ");
}

function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return "Belum pernah";
  return new Date(iso).toLocaleString("id-ID", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function decisionMeta(kind: AgentDecisionLog["kind"]) {
  switch (kind) {
    case "pause_campaign":
      return { label: "Pause Kampanye Boncos", icon: PauseCircle, tone: "bg-red-soft text-red-ink" };
    case "pause_ad":
      return { label: "Pause Iklan Individual", icon: PauseCircle, tone: "bg-red-soft text-red-ink" };
    case "scale_campaign":
      return { label: "Scale Budget Kampanye", icon: ArrowUpRight, tone: "bg-green-soft text-green-ink" };
    case "launch_campaign":
      return { label: "Luncurkan Kampanye Baru", icon: Sparkles, tone: "bg-accent-soft text-accent" };
    case "inject_ads":
      return { label: "Suntik Variasi Iklan Baru", icon: Layers, tone: "bg-accent-soft text-accent" };
    default:
      return { label: "Pertahankan & Pantau", icon: ShieldCheck, tone: "bg-track text-muted" };
  }
}

function decisionStatusBadge(status: AgentDecisionLog["status"]) {
  switch (status) {
    case "executed":
      return { label: "Dieksekusi", cls: "bg-green-soft text-green-ink" };
    case "pending":
      return { label: "Menunggu Persetujuan", cls: "bg-yellow-soft text-yellow-ink" };
    case "blocked_guardrail":
      return { label: "Ditahan Guardrail", cls: "bg-yellow-soft text-yellow-ink" };
    case "failed":
      return { label: "Gagal", cls: "bg-red-soft text-red-ink" };
    default:
      return { label: "Dilewati", cls: "bg-track text-muted" };
  }
}

function outcomeBadge(outcome: AgentMemory["outcome"]) {
  switch (outcome) {
    case "winning":
      return { label: "Menang / Profitabel", cls: "bg-green-soft text-green-ink" };
    case "losing":
      return { label: "Boncos / Jangan Ulang", cls: "bg-red-soft text-red-ink" };
    case "inconclusive":
      return { label: "Sampel Kecil", cls: "bg-track text-muted" };
    default:
      return { label: "Sedang Diuji", cls: "bg-accent-soft text-accent" };
  }
}

/* ------------------------------------------------------------------ Modal Pengaturan Guardrail per Akun */

function GuardrailModal({
  acc,
  onClose,
}: {
  acc: Account | null;
  onClose: () => void;
}) {
  if (!acc) return null;
  return <GuardrailForm acc={acc} onClose={onClose} />;
}

function GuardrailForm({ acc, onClose }: { acc: Account; onClose: () => void }) {
  const s = acc.settings;
  const isJasa = acc.line === "jasa";
  const [f, setF] = useState({
    targetRoas: String(s.targetRoas),
    maxCpa: s.maxCpa != null ? String(s.maxCpa) : "",
    maxCpl: s.maxCpl != null ? String(s.maxCpl) : "",
    killAfterSpend: String(s.killAfterSpend),
    scaleStepPct: String(s.scaleStepPct),
    dailyStopLoss: s.dailyStopLoss != null ? String(s.dailyStopLoss) : "",
    maxDailyBudget: s.maxDailyBudget != null ? String(s.maxDailyBudget) : "",
    maxAccountDailyBudget: s.maxAccountDailyBudget != null ? String(s.maxAccountDailyBudget) : "",
    cooldownHours: String(s.cooldownHours),
    maxAutoLaunchesPerDay: String(s.maxAutoLaunchesPerDay),
    autoLaunchEnabled: s.autoLaunchEnabled,
  });

  const save = useMutation({
    mutationFn: () =>
      api(`/accounts/${acc.id}/settings`, {
        method: "PATCH",
        json: {
          targetRoas: Number(f.targetRoas) || s.targetRoas,
          maxCpa: f.maxCpa.trim() ? parseRp(f.maxCpa) : null,
          maxCpl: isJasa ? (f.maxCpl.trim() ? parseRp(f.maxCpl) : null) : s.maxCpl,
          killAfterSpend: parseRp(f.killAfterSpend),
          scaleStepPct: Math.min(50, Math.max(5, Math.round(Number(f.scaleStepPct) || 20))),
          dailyStopLoss: f.dailyStopLoss.trim() ? parseRp(f.dailyStopLoss) : null,
          maxDailyBudget: f.maxDailyBudget.trim() ? parseRp(f.maxDailyBudget) : null,
          maxAccountDailyBudget: f.maxAccountDailyBudget.trim() ? parseRp(f.maxAccountDailyBudget) : null,
          cooldownHours: Math.min(72, Math.max(0, Math.round(Number(f.cooldownHours) || 0))),
          maxAutoLaunchesPerDay: Math.min(10, Math.max(0, Math.round(Number(f.maxAutoLaunchesPerDay) || 0))),
          autoLaunchEnabled: f.autoLaunchEnabled,
        },
      }),
    onSuccess: () => {
      toast(`Guardrail akun ${acc.name} disimpan`);
      refreshData();
      onClose();
    },
    onError: (e) => toast(e instanceof Error ? e.message : "Gagal menyimpan guardrail", { tone: "err" }),
  });

  return (
    <Modal open title={`Guardrail & Aturan Profit · ${acc.name}`} onClose={onClose} wide>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <div className="rounded-xl border border-line bg-bg p-3.5 text-[12.5px] text-muted">
          Circuit breaker melindungi saldo iklan secara deterministik di level kode. Jika rugi bersih hari ini melewati{" "}
          <strong className="text-ink">Stop-Loss Harian</strong>, AI otomatis menahan semua scale & peluncuran baru dan hanya mengizinkan penghentian iklan yang boncos.
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block">
            <span className="label">Stop-Loss Rugi Harian (Rp, kosong = nonaktif)</span>
            <input
              className="input num mt-1"
              inputMode="numeric"
              value={f.dailyStopLoss}
              onChange={(e) => setF({ ...f, dailyStopLoss: e.target.value })}
              placeholder="Contoh: 300000"
            />
          </label>
          <label className="block">
            <span className="label">Plafon Total Budget Harian Se-Akun (Rp)</span>
            <input
              className="input num mt-1"
              inputMode="numeric"
              value={f.maxAccountDailyBudget}
              onChange={(e) => setF({ ...f, maxAccountDailyBudget: e.target.value })}
              placeholder="Kosong = tanpa batas"
            />
          </label>
          <label className="block">
            <span className="label">Plafon Budget Harian per Kampanye (Rp)</span>
            <input
              className="input num mt-1"
              inputMode="numeric"
              value={f.maxDailyBudget}
              onChange={(e) => setF({ ...f, maxDailyBudget: e.target.value })}
              placeholder="Kosong = tanpa batas"
            />
          </label>
          <label className="block">
            <span className="label">Batas Spend Sebelum Vonis Matikan / Kill (Rp)</span>
            <input
              className="input num mt-1"
              inputMode="numeric"
              value={f.killAfterSpend}
              onChange={(e) => setF({ ...f, killAfterSpend: e.target.value })}
              required
            />
          </label>
          <label className="block">
            <span className="label">Target ROAS Minimal (x)</span>
            <input
              className="input num mt-1"
              type="number"
              step="0.1"
              min="0.5"
              max="50"
              value={f.targetRoas}
              onChange={(e) => setF({ ...f, targetRoas: e.target.value })}
              required
            />
          </label>
          <label className="block">
            <span className="label">{isJasa ? "Batas Maksimal CPL Leads (Rp)" : "Batas Maksimal CPA Pembelian (Rp)"}</span>
            <input
              className="input num mt-1"
              inputMode="numeric"
              value={isJasa ? f.maxCpl : f.maxCpa}
              onChange={(e) => setF(isJasa ? { ...f, maxCpl: e.target.value } : { ...f, maxCpa: e.target.value })}
              placeholder="Kosong = ikut CPA impas produk"
            />
          </label>
          <label className="block">
            <span className="label">Langkah Kenaikan Scale Budget (%)</span>
            <input
              className="input num mt-1"
              type="number"
              min="5"
              max="50"
              value={f.scaleStepPct}
              onChange={(e) => setF({ ...f, scaleStepPct: e.target.value })}
              required
            />
          </label>
          <label className="block">
            <span className="label">Cooldown Antar-Aksi Kampanye Sama (Jam)</span>
            <input
              className="input num mt-1"
              type="number"
              min="0"
              max="72"
              value={f.cooldownHours}
              onChange={(e) => setF({ ...f, cooldownHours: e.target.value })}
              required
            />
          </label>
          <label className="block sm:col-span-2">
            <span className="label">Kuota Maksimal Peluncuran Kampanye/Iklan Baru Otomatis per Hari</span>
            <input
              className="input num mt-1"
              type="number"
              min="0"
              max="10"
              value={f.maxAutoLaunchesPerDay}
              onChange={(e) => setF({ ...f, maxAutoLaunchesPerDay: e.target.value })}
              required
            />
          </label>
        </div>

        <div className="rounded-xl border border-line px-4 py-3">
          <CustomSwitch
            checked={f.autoLaunchEnabled}
            onChange={(autoLaunchEnabled) => setF({ ...f, autoLaunchEnabled })}
            label="Izinkan AI Meluncurkan / Menyuntik Iklan Baru Secara Otonom"
            hint="Saat kampanye boncos dimatikan atau akun masih defisit laba, AI otomatis merakit iklan ber-angle baru dari Bank Aset Produk."
          />
        </div>

        <div className="flex justify-end gap-2 pt-1">
          <button type="button" className="btn" onClick={onClose}>Batal</button>
          <button type="submit" className="btn btn-primary" disabled={save.isPending}>
            {save.isPending ? "Menyimpan..." : "Simpan Guardrail"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/* ------------------------------------------------------------------ Modal Tambah Aset Kreatif Produk */

function AssetModal({
  open,
  onClose,
  products,
  accounts,
  defaultProductId,
}: {
  open: boolean;
  onClose: () => void;
  products: ProductUnitEcon[];
  accounts: Account[];
  defaultProductId?: number | null;
}) {
  if (!open) return null;
  return <AssetForm onClose={onClose} products={products} accounts={accounts} defaultProductId={defaultProductId} />;
}

function AssetForm({
  onClose,
  products,
  accounts,
  defaultProductId,
}: {
  onClose: () => void;
  products: ProductUnitEcon[];
  accounts: Account[];
  defaultProductId?: number | null;
}) {
  const firstProd = products.find((p) => p.id === defaultProductId) ?? products[0];
  const [productId, setProductId] = useState<string>(firstProd ? String(firstProd.id) : "");
  const selectedProd = products.find((p) => String(p.id) === productId) ?? firstProd;
  const matchingAccounts = accounts.filter((a) => a.active && (!selectedProd || a.line === selectedProd.line));

  const [accountId, setAccountId] = useState<string>(matchingAccounts[0]?.id ?? "");
  const [kind, setKind] = useState<"image" | "video" | "post">("image");
  const [name, setName] = useState("");
  const [imageUrl, setImageUrl] = useState("");
  const [imageHash, setImageHash] = useState("");
  const [videoId, setVideoId] = useState("");
  const [objectStoryId, setObjectStoryId] = useState("");
  const [notes, setNotes] = useState("");
  const [uploaded, setUploaded] = useState<ChatAttachment | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const productOptions = products.map((p) => ({
    value: String(p.id),
    label: `${p.name} (${LINES[p.line].label})`,
    hint: p.maxBreakEvenCpa ? `CPA Impas ${rpk(p.maxBreakEvenCpa)}` : undefined,
  }));

  const accountOptions = [
    { value: "", label: "Semua akun satu lini (tanpa upload file langsung)" },
    ...matchingAccounts.map((a) => ({ value: a.id, label: a.name, hint: `ID ${a.id}` })),
  ];

  const kindOptions = [
    { value: "image" as const, label: "Gambar / Poster Produk (1:1 atau 4:5)" },
    { value: "video" as const, label: "Video Reels / Feed (9:16 atau 4:5)" },
    { value: "post" as const, label: "Postingan IG/FB Existing (Social Proof)" },
  ];

  async function onPickFile(file: File | undefined) {
    if (!file) return;
    setUploading(true);
    try {
      const att = await autopilotApi.uploadMedia(file);
      setUploaded(att);
      setKind(att.kind);
      if (!name.trim()) setName(file.name.replace(/\.[^.]+$/, "").slice(0, 80));
      if (!accountId && matchingAccounts[0]) setAccountId(matchingAccounts[0].id);
      toast(`File ${att.name} siap diunggah ke Meta`);
    } catch (e) {
      toast(e instanceof Error ? e.message : "Gagal mengunggah file", { tone: "err" });
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  const create = useMutation({
    mutationFn: () =>
      autopilotApi.createAsset({
        productId: Number(productId),
        accountId: accountId || null,
        name: name.trim(),
        kind,
        ...(uploaded ? { mediaId: uploaded.id } : {}),
        ...(imageUrl.trim() ? { imageUrl: imageUrl.trim() } : {}),
        ...(imageHash.trim() ? { imageHash: imageHash.trim() } : {}),
        ...(videoId.trim() ? { videoId: videoId.trim() } : {}),
        ...(objectStoryId.trim() ? { objectStoryId: objectStoryId.trim() } : {}),
        ...(notes.trim() ? { notes: notes.trim() } : {}),
      }),
    onSuccess: (res) => {
      toast(res.note ? `Aset disimpan · ${res.note}` : "Aset kreatif ditambahkan ke Bank Aset Produk");
      refreshData();
      onClose();
    },
    onError: (e) => toast(e instanceof Error ? e.message : "Gagal menyimpan aset", { tone: "err" }),
  });

  if (!products.length) {
    return (
      <Modal open title="Tambah Aset Kreatif" onClose={onClose}>
        <EmptyState
          icon={<Package size={20} />}
          title="Belum ada produk aktif"
          text="Tambahkan produk beserta harga dan HPP terlebih dahulu di menu Pengaturan agar AI dapat menghitung batas CPA impas."
        />
      </Modal>
    );
  }

  return (
    <Modal open title="Tambah Aset ke Bank Kreatif Produk" onClose={onClose} wide>
      <form
        className="space-y-3.5"
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate();
        }}
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <span className="label">Produk Tujuan</span>
            <div className="mt-1">
              <CustomSelect
                value={productId}
                options={productOptions}
                ariaLabel="Produk Tujuan"
                onChange={(val) => {
                  setProductId(val);
                  const nextProd = products.find((p) => String(p.id) === val);
                  const nextAccs = accounts.filter((a) => a.active && (!nextProd || a.line === nextProd.line));
                  if (accountId && !nextAccs.some((a) => a.id === accountId)) {
                    setAccountId(nextAccs[0]?.id ?? "");
                  }
                }}
              />
            </div>
          </div>
          <div>
            <span className="label">Akun Iklan Meta</span>
            <div className="mt-1">
              <CustomSelect
                value={accountId}
                options={accountOptions}
                ariaLabel="Akun Iklan Meta"
                onChange={setAccountId}
              />
            </div>
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <span className="label">Jenis Aset Kreatif</span>
            <div className="mt-1">
              <CustomSelect value={kind} options={kindOptions} ariaLabel="Jenis Aset Kreatif" onChange={setKind} />
            </div>
          </div>
          <label className="block">
            <span className="label">Nama Aset (untuk identifikasi AI)</span>
            <input
              className="input mt-1"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Contoh: Poster Demo Bundle V1"
              required
              maxLength={120}
            />
          </label>
        </div>

        {kind !== "post" && (
          <div className="rounded-xl border border-dashed border-line-strong bg-bg p-4">
            <input
              ref={fileRef}
              type="file"
              accept={kind === "video" ? "video/mp4,video/quicktime,video/webm" : "image/jpeg,image/png,image/webp"}
              className="hidden"
              onChange={(e) => onPickFile(e.target.files?.[0])}
            />
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-[13.5px] font-semibold">
                  {uploaded ? `File terpilih: ${uploaded.name}` : `Upload ${kind === "video" ? "Video MP4/MOV" : "Foto JPG/PNG/WebP"} dari perangkat`}
                </p>
                <p className="text-[12px] text-muted">
                  {uploaded
                    ? "File akan langsung dikirim ke library akun iklan Meta saat disimpan."
                    : "Atau isi URL / ID kreatif Meta di bawah bila file sudah pernah diunggah sebelumnya."}
                </p>
              </div>
              <div className="flex items-center gap-2">
                {uploaded && (
                  <button type="button" className="btn btn-ghost text-[12.5px]" onClick={() => setUploaded(null)}>
                    Ganti
                  </button>
                )}
                <button
                  type="button"
                  className="btn"
                  disabled={uploading}
                  onClick={() => fileRef.current?.click()}
                >
                  <Upload size={15} />
                  {uploading ? "Mengunggah..." : uploaded ? "Pilih Ulang" : "Pilih File"}
                </button>
              </div>
            </div>
          </div>
        )}

        {kind === "image" && !uploaded && (
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="label">URL Gambar Publik (opsional)</span>
              <input
                className="input mt-1"
                type="url"
                value={imageUrl}
                onChange={(e) => setImageUrl(e.target.value)}
                placeholder="https://..."
              />
            </label>
            <label className="block">
              <span className="label">Meta Image Hash (opsional)</span>
              <input
                className="input mt-1"
                value={imageHash}
                onChange={(e) => setImageHash(e.target.value)}
                placeholder="Contoh: a1b2c3d4e5..."
              />
            </label>
          </div>
        )}

        {kind === "video" && !uploaded && (
          <label className="block">
            <span className="label">Meta Video ID (angka)</span>
            <input
              className="input num mt-1"
              inputMode="numeric"
              value={videoId}
              onChange={(e) => setVideoId(e.target.value.replace(/\D/g, ""))}
              placeholder="Contoh: 981273645123"
            />
          </label>
        )}

        {kind === "post" && (
          <label className="block">
            <span className="label">Object Story ID Postingan FB/IG (format PAGEID_POSTID)</span>
            <input
              className="input num mt-1"
              value={objectStoryId}
              onChange={(e) => setObjectStoryId(e.target.value.trim())}
              placeholder="Contoh: 10492837461_88273645192"
              required
            />
          </label>
        )}

        <label className="block">
          <span className="label">Catatan Visual / Isi Konten untuk AI (opsional)</span>
          <input
            className="input mt-1"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Contoh: Tampilan before-after hasil prompt + badge harga Rp99rb"
            maxLength={300}
          />
        </label>

        <div className="flex justify-end gap-2 pt-1">
          <button type="button" className="btn" onClick={onClose}>Batal</button>
          <button type="submit" className="btn btn-primary" disabled={create.isPending || uploading}>
            {create.isPending ? "Menyimpan..." : "Simpan ke Bank Aset"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/* ------------------------------------------------------------------ Kartu Otonomi per Akun */

function AccountAutopilotCard({
  item,
  isOwner,
  onEditGuardrail,
  onRunAccount,
  runningId,
}: {
  item: AutopilotAccountSummary;
  isOwner: boolean;
  onEditGuardrail: (acc: Account) => void;
  onRunAccount: (accountId: string) => void;
  runningId: string | null;
}) {
  const { account: acc, pl } = item;
  const st = acc.settings;
  const isJasa = acc.line === "jasa";

  const setMode = useMutation({
    mutationFn: (botMode: BotMode) => api(`/accounts/${acc.id}`, { method: "PATCH", json: { botMode } }),
    onSuccess: (_, botMode) => {
      const label = MODE_SEGMENTS.find((m) => m.value === botMode)?.label ?? botMode;
      toast(`${acc.name}: mode diubah ke ${label}`);
      refreshData();
    },
    onError: (e) => toast(e instanceof Error ? e.message : "Gagal mengubah mode", { tone: "err" }),
  });

  const toggleAutoLaunch = useMutation({
    mutationFn: (autoLaunchEnabled: boolean) =>
      api(`/accounts/${acc.id}/settings`, { method: "PATCH", json: { autoLaunchEnabled } }),
    onSuccess: (_, on) => {
      toast(`${acc.name}: peluncuran iklan pengganti otomatis ${on ? "diaktifkan" : "dinonaktifkan"}`);
      refreshData();
    },
    onError: (e) => toast(e instanceof Error ? e.message : "Gagal memperbarui pengaturan", { tone: "err" }),
  });

  const isRunningThis = runningId === acc.id || runningId === "all";
  const net7Positive = pl.net7d >= 0;

  return (
    <Card className="flex flex-col justify-between gap-4">
      <div className="space-y-4">
        {/* Header akun & switcher mode */}
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="truncate text-[15.5px] font-semibold">{acc.name}</h3>
              <span className="pill bg-accent-soft text-accent">{LINES[acc.line].label}</span>
              <span className="pill bg-track text-muted num">{item.activeCampaigns} kampanye aktif</span>
            </div>
            <p className="mt-1 text-[12px] text-muted">
              ID {acc.id} · Evaluasi terakhir: <span className="font-medium text-ink">{fmtDateTime(item.lastRunAt)}</span>
            </p>
          </div>

          {isOwner ? (
            <div className="inline-flex rounded-xl border border-line bg-bg p-1" role="group" aria-label={`Mode Autopilot ${acc.name}`}>
              {MODE_SEGMENTS.map((seg) => {
                const active = acc.botMode === seg.value;
                return (
                  <button
                    key={seg.value}
                    type="button"
                    disabled={setMode.isPending}
                    onClick={() => !active && setMode.mutate(seg.value)}
                    className={cx(
                      "rounded-lg px-2.5 py-1.5 text-[12px] font-semibold transition-colors",
                      active
                        ? seg.value === "auto"
                          ? "bg-accent text-accent-ink"
                          : "bg-card text-ink shadow-card"
                        : "text-muted hover:text-ink",
                    )}
                  >
                    {seg.short}
                  </button>
                );
              })}
            </div>
          ) : (
            <span className={cx("pill", acc.botMode === "auto" ? "bg-accent-soft text-accent" : "bg-track text-muted")}>
              {MODE_SEGMENTS.find((m) => m.value === acc.botMode)?.label}
            </span>
          )}
        </div>

        {/* Metrik P&L Multi-Horizon */}
        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
          <div className="min-w-0 rounded-xl border border-line bg-bg px-3 py-2.5">
            <p className="text-[11.5px] text-muted">Laba Bersih 7h</p>
            <p className={cx("num mt-0.5 truncate whitespace-nowrap text-[13.5px] font-semibold", net7Positive ? "text-green-ink" : "text-red-ink")}>
              {rp(pl.net7d)}
            </p>
            <p className="num text-[11px] text-muted">Spend {rpk(pl.spend7d)}</p>
          </div>
          <div className="min-w-0 rounded-xl border border-line bg-bg px-3 py-2.5">
            <p className="text-[11.5px] text-muted">ROAS Riil 7h</p>
            <p className={cx("num mt-0.5 truncate whitespace-nowrap text-[13.5px] font-semibold", pl.roas7d >= pl.beRoas7d && pl.spend7d > 0 ? "text-green-ink" : "text-ink")}>
              {dec(pl.roas7d)}x
            </p>
            <p className="num text-[11px] text-muted">Impas {dec(pl.beRoas7d)}x</p>
          </div>
          <div className="min-w-0 rounded-xl border border-line bg-bg px-3 py-2.5">
            <p className="text-[11.5px] text-muted">Laba Hari Ini</p>
            <p className={cx("num mt-0.5 truncate whitespace-nowrap text-[13.5px] font-semibold", pl.todayNet >= 0 ? "text-green-ink" : "text-red-ink")}>
              {rp(pl.todayNet)}
            </p>
            <p className="num text-[11px] text-muted">Spend {rpk(pl.todaySpend)}</p>
          </div>
          <div className="min-w-0 rounded-xl border border-line bg-bg px-3 py-2.5">
            <p className="text-[11.5px] text-muted">{isJasa ? "CPL Aktual 7h" : "CPA Aktual 7h"}</p>
            <p className="num mt-0.5 truncate whitespace-nowrap text-[13.5px] font-semibold">
              {isJasa ? (pl.cpl7d > 0 ? rpk(pl.cpl7d) : "-") : pl.cpa7d > 0 ? rpk(pl.cpa7d) : "-"}
            </p>
            <p className="num text-[11px] text-muted">
              Batas {isJasa ? (st.maxCpl ? rpk(st.maxCpl) : "-") : st.maxCpa ? rpk(st.maxCpa) : pl.maxCpaBE7d > 0 ? rpk(pl.maxCpaBE7d) : "-"}
            </p>
          </div>
        </div>

        {/* Status Safety Circuit Breakers */}
        <div className="flex flex-wrap items-center gap-2 text-[12px]">
          {item.stopLossTriggered ? (
            <span className="pill bg-red-soft text-red-ink">
              <ShieldAlert size={13} /> Stop-Loss Aktif (Batas {rpk(st.dailyStopLoss ?? 0)})
            </span>
          ) : (
            <span className="pill bg-green-soft text-green-ink">
              <ShieldCheck size={13} /> Stop-Loss {st.dailyStopLoss ? rpk(st.dailyStopLoss) : "Nonaktif"}
            </span>
          )}

          {item.rejectionCircuitOpen && (
            <span className="pill bg-yellow-soft text-yellow-ink">
              <AlertTriangle size={13} /> Circuit Breaker Meta Terbuka
            </span>
          )}

          <span className="pill bg-track text-ink num">
            Peluncuran hari ini: {item.launchesToday}/{st.maxAutoLaunchesPerDay}
          </span>
          <span className="pill bg-track text-muted num">
            Budget aktif: {rpk(pl.activeDailyBudget)}/hari
          </span>
        </div>
      </div>

      {/* Baris kontrol bawah */}
      <div className="space-y-3 border-t border-line pt-3">
        {isOwner && (
          <CustomSwitch
            checked={st.autoLaunchEnabled}
            disabled={toggleAutoLaunch.isPending}
            onChange={(next) => toggleAutoLaunch.mutate(next)}
            label="Auto-Launch Pengganti Saat Rugi / Fatigue"
            hint={`Cooldown ${st.cooldownHours} jam · Kill spend ${rpk(st.killAfterSpend)} · Scale +${st.scaleStepPct}%`}
          />
        )}
        {isOwner && (
          <div className="flex flex-wrap items-center justify-end gap-2">
            <button type="button" className="btn min-h-[36px] px-3 text-[13px]" onClick={() => onEditGuardrail(acc)}>
              <Sliders size={14} /> Atur Guardrail
            </button>
            <button
              type="button"
              className="btn btn-primary min-h-[36px] px-3 text-[13px]"
              disabled={isRunningThis}
              onClick={() => onRunAccount(acc.id)}
            >
              {isRunningThis ? <RefreshCw size={14} className="animate-spin" /> : <Play size={14} />}
              {isRunningThis ? "Mengevaluasi..." : "Evaluasi Akun"}
            </button>
          </div>
        )}
      </div>
    </Card>
  );
}

/* ------------------------------------------------------------------ Kartu Siklus AgentRun */

function AgentRunCard({
  run,
  isOwner,
  executedActionIds,
  onRevert,
}: {
  run: AgentRun;
  isOwner: boolean;
  executedActionIds: Set<number>;
  onRevert: (actionId: number) => void;
}) {
  const pl = run.plSnapshot;
  const statusTone =
    run.status === "completed"
      ? "bg-green-soft text-green-ink"
      : run.status === "halted_guardrail"
        ? "bg-yellow-soft text-yellow-ink"
        : run.status === "failed"
          ? "bg-red-soft text-red-ink"
          : "bg-accent-soft text-accent";

  const statusLabel =
    run.status === "completed"
      ? "Selesai"
      : run.status === "halted_guardrail"
        ? "Ditahan Guardrail"
        : run.status === "failed"
          ? "Gagal"
          : "Berjalan";

  const triggerLabel =
    run.trigger === "sync" ? "Otomatis pasca-Sync" : run.trigger === "chat" ? "Dari Chat AI" : "Eksekusi Manual";

  return (
    <Card className="space-y-3.5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[15px] font-semibold">{run.accountName}</span>
            <span className={cx("pill", statusTone)}>{statusLabel}</span>
            <span className="pill bg-track text-ink">
              {run.brain === "ai" ? "Claude Strategist" : "Mesin Kuantitatif"}
            </span>
            <span className="pill bg-track text-muted">
              {run.mode === "auto" ? "Full Auto" : "Mode Saran"}
            </span>
          </div>
          <p className="mt-1 text-[12px] text-muted">
            {fmtDateTime(run.startedAt)} · {triggerLabel}
            {run.inputTokens ? ` · ${run.inputTokens + (run.outputTokens ?? 0)} token` : ""}
          </p>
        </div>

        {pl.net7d !== undefined && (
          <div className="flex items-center gap-3 rounded-xl border border-line bg-bg px-3 py-1.5 text-[12px]">
            <span>
              Laba 7h:{" "}
              <strong className={cx("num", (pl.net7d ?? 0) >= 0 ? "text-green-ink" : "text-red-ink")}>
                {rp(pl.net7d ?? 0)}
              </strong>
            </span>
            <span className="text-line-strong">|</span>
            <span className="num">
              ROAS: <strong>{dec(pl.roas7d ?? 0)}x</strong>
            </span>
          </div>
        )}
      </div>

      {run.guardrailNote && (
        <div className="flex items-start gap-2.5 rounded-xl border border-yellow/40 bg-yellow-soft px-3.5 py-2.5 text-[12.5px] text-yellow-ink">
          <ShieldAlert size={16} className="mt-0.5 shrink-0" />
          <span>{run.guardrailNote}</span>
        </div>
      )}

      {run.error && (
        <div className="flex items-start gap-2.5 rounded-xl bg-red-soft px-3.5 py-2.5 text-[12.5px] text-red-ink">
          <XCircle size={16} className="mt-0.5 shrink-0" />
          <span>{run.error}</span>
        </div>
      )}

      {run.diagnosis && (
        <div className="rounded-xl border border-line bg-bg px-4 py-3 text-[13.5px] leading-relaxed text-ink">
          {run.diagnosis}
        </div>
      )}

      {run.decisions.length > 0 && (
        <div className="space-y-2">
          {run.decisions.map((d, idx) => {
            const meta = decisionMeta(d.kind);
            const stBadge = decisionStatusBadge(d.status);
            const Icon = meta.icon;
            const canUndo = isOwner && d.status === "executed" && d.actionId != null && executedActionIds.has(d.actionId);
            return (
              <div
                key={idx}
                className="flex flex-col justify-between gap-2.5 rounded-xl border border-line px-3.5 py-3 sm:flex-row sm:items-start"
              >
                <div className="flex min-w-0 items-start gap-3">
                  <div className={cx("mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg", meta.tone)}>
                    <Icon size={16} />
                  </div>
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-[13.5px] font-semibold">{meta.label}</span>
                      <span className="text-[13px] font-medium text-muted">· {d.targetName}</span>
                      {d.angle && (
                        <span className="pill max-w-full whitespace-normal break-words bg-accent-soft text-left text-[11px] leading-snug text-accent">
                          {formatAngle(d.angle)}
                        </span>
                      )}
                    </div>
                    <p className="text-[13px] text-ink/90">{d.rationale}</p>
                    {d.detail && <p className="text-[12px] text-muted">{d.detail}</p>}
                  </div>
                </div>

                <div className="flex shrink-0 items-center gap-2 self-end sm:self-center">
                  <span className={cx("pill", stBadge.cls)}>{stBadge.label}</span>
                  {canUndo && (
                    <button
                      type="button"
                      className="btn min-h-[32px] px-2.5 py-1 text-[12px]"
                      onClick={() => onRevert(d.actionId!)}
                    >
                      <RotateCcw size={13} /> Batalkan
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}

/* ------------------------------------------------------------------ Halaman Utama Autopilot AI */

export default function Autopilot() {
  const boot = useBootstrap().data!;
  const isOwner = boot.user.role === "owner";
  const q = useAutopilot();

  const [sub, setSub] = useState<SubTab>("runs");
  const [guardrailAcc, setGuardrailAcc] = useState<Account | null>(null);
  const [assetModalOpen, setAssetModalOpen] = useState(false);
  const [assetDefaultProd, setAssetDefaultProd] = useState<number | null>(null);
  const [runningTarget, setRunningTarget] = useState<string | null>(null);
  const [prodFilter, setProdFilter] = useState<string>("all");
  const [memFilter, setMemFilter] = useState<string>("all");

  async function triggerRun(accountId?: string) {
    setRunningTarget(accountId ?? "all");
    try {
      const res = await autopilotApi.run(accountId);
      if (res.skippedLock) {
        toast("Siklus Autopilot sedang berjalan di latar belakang, tunggu beberapa detik.", { tone: "info" });
      } else {
        const count = res.runs.reduce((s, r) => s + r.decisions.filter((d) => d.kind !== "hold").length, 0);
        toast(`Siklus Autopilot selesai · ${res.runs.length} akun dievaluasi (${count} keputusan strategis)`);
      }
      refreshData();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "Gagal menjalankan siklus Autopilot", { tone: "err" });
    } finally {
      setRunningTarget(null);
    }
  }

  async function approvePendingAction(a: BotAction) {
    const s = actionSummary(a);
    const ok = await confirmDialog({
      title: s.title,
      confirm: `Ya, ${s.verb.toLowerCase()}`,
      danger: a.action === "pause" || a.action === "pause_ad",
      body: (
        <div className="space-y-2">
          <p className="font-semibold text-ink">{a.campaignName ?? a.accountName}</p>
          {a.reason && <p className="text-[13px] text-ink/90">{a.reason}</p>}
          {s.detail && <p className="whitespace-pre-line rounded-lg bg-bg px-3 py-2 text-[13px] text-ink">{s.detail}</p>}
        </div>
      ),
    });
    if (!ok) return;
    try {
      const done = await actionsApi.confirm(a.id);
      if (done.status === "executed") {
        toast(`${s.verb} berhasil dieksekusi`);
      } else {
        toast(`Gagal: ${done.error ?? "error dari Meta"}`, { tone: "err" });
      }
      refreshData();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Gagal mengeksekusi usulan", { tone: "err" });
    }
  }

  async function rejectPendingAction(a: BotAction) {
    try {
      await actionsApi.cancel(a.id);
      toast("Usulan Autopilot dibatalkan");
      refreshData();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Gagal membatalkan usulan", { tone: "err" });
    }
  }

  async function handleRevertAction(actionId: number) {
    const ok = await confirmDialog({
      title: "Batalkan perubahan iklan ini?",
      body: "Status kampanye, iklan, atau budget akan dikembalikan ke nilai sebelum dieksekusi oleh Autopilot AI.",
      confirm: "Ya, kembalikan",
    });
    if (!ok) return;
    try {
      await actionsApi.revert(actionId);
      toast("Perubahan iklan berhasil dikembalikan");
      refreshData();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Gagal membatalkan aksi", { tone: "err" });
    }
  }

  async function handleArchiveAsset(asset: ProductAsset) {
    const ok = await confirmDialog({
      title: `Nonaktifkan aset "${asset.name}"?`,
      body: "Aset ini akan diarsipkan (soft-deactivate) sehingga AI tidak memakainya pada peluncuran baru, tanpa menghapus riwayat kampanye lama.",
      confirm: "Ya, nonaktifkan",
    });
    if (!ok) return;
    try {
      await autopilotApi.updateAsset(asset.id, { active: false });
      toast(`Aset "${asset.name}" dinonaktifkan`);
      refreshData();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Gagal menonaktifkan aset", { tone: "err" });
    }
  }

  if (q.isPending && !q.data) {
    return (
      <div className="space-y-4">
        <div className="grid gap-3.5 sm:grid-cols-2 lg:grid-cols-4">
          {[1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-[112px]" />)}
        </div>
        <div className="grid gap-4 lg:grid-cols-2">
          <Skeleton className="h-[280px]" />
          <Skeleton className="h-[280px]" />
        </div>
      </div>
    );
  }
  if (q.error && !q.data) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;

  const data = q.data!;
  const totalNet7d = data.accounts.reduce((s, a) => s + a.pl.net7d, 0);
  const totalRev7d = data.accounts.reduce((s, a) => s + a.pl.revenue7d, 0);
  const totalSpend7d = data.accounts.reduce((s, a) => s + a.pl.spend7d, 0);
  const totalTodayNet = data.accounts.reduce((s, a) => s + a.pl.todayNet, 0);
  const totalTodaySpend = data.accounts.reduce((s, a) => s + a.pl.todaySpend, 0);
  const totalDailyBudget = data.accounts.reduce((s, a) => s + a.pl.activeDailyBudget, 0);
  const autoCount = data.accounts.filter((a) => a.account.botMode === "auto").length;
  const suggestCount = data.accounts.filter((a) => a.account.botMode === "suggest").length;

  const pendingProposals = data.recentActions.filter((a) => a.status === "pending");
  const executedActionIds = new Set(data.recentActions.filter((a) => a.status === "executed").map((a) => a.id));

  const filteredAssets = prodFilter === "all"
    ? data.assets
    : data.assets.filter((a) => String(a.productId) === prodFilter);

  const filteredMemories = memFilter === "all"
    ? data.memories
    : data.memories.filter((m) => m.outcome === memFilter);

  return (
    <div className="space-y-5">
      {/* Row 1: KPI Ringkasan Profit Engine & Command Trigger */}
      <div className="grid gap-3.5 sm:grid-cols-2 xl:grid-cols-4">
        <Card className="flex flex-col justify-between">
          <div className="flex items-center justify-between text-muted">
            <span className="text-[12.5px] font-medium">Laba Bersih Riil (7 Hari)</span>
            {totalNet7d >= 0 ? <TrendingUp size={17} className="text-green" /> : <TrendingDown size={17} className="text-red" />}
          </div>
          <p className={cx("num mt-2 text-[22px] font-semibold tracking-tight", totalNet7d >= 0 ? "text-green-ink" : "text-red-ink")}>
            {rp(totalNet7d)}
          </p>
          <p className="num mt-1 text-[12px] text-muted">
            Omzet {rpk(totalRev7d)} · Spend {rpk(totalSpend7d)}
          </p>
        </Card>

        <Card className="flex flex-col justify-between">
          <div className="flex items-center justify-between text-muted">
            <span className="text-[12.5px] font-medium">Laba Bersih Hari Ini</span>
            <Clock3 size={17} className="text-muted" />
          </div>
          <p className={cx("num mt-2 text-[22px] font-semibold tracking-tight", totalTodayNet >= 0 ? "text-green-ink" : "text-red-ink")}>
            {rp(totalTodayNet)}
          </p>
          <p className="num mt-1 text-[12px] text-muted">
            Spend berjalan hari ini {rpk(totalTodaySpend)}
          </p>
        </Card>

        <Card className="flex flex-col justify-between">
          <div className="flex items-center justify-between text-muted">
            <span className="text-[12.5px] font-medium">Anggaran & Mode Otonomi</span>
            <ShieldCheck size={17} className="text-accent" />
          </div>
          <p className="num mt-2 text-[22px] font-semibold tracking-tight">{rp(totalDailyBudget)}<span className="text-[13px] font-normal text-muted">/hari</span></p>
          <p className="mt-1 text-[12px] text-muted">
            {autoCount} akun Full Auto · {suggestCount} Mode Saran
          </p>
        </Card>

        <Card className="flex flex-col justify-between bg-accent-soft border-accent/25">
          <div className="flex items-center justify-between">
            <span className="text-[12.5px] font-semibold text-accent">Mesin Keputusan Profit AI</span>
            <Cpu size={18} className="text-accent" />
          </div>
          <p className="mt-1.5 text-[12.5px] leading-snug text-ink/85">
            Otomatis berjalan setiap selesai sinkron Meta untuk memangkas iklan rugi & merilis angle baru.
          </p>
          {isOwner && (
            <button
              type="button"
              className="btn btn-primary mt-3 w-full"
              disabled={runningTarget !== null || data.accounts.length === 0}
              onClick={() => triggerRun()}
            >
              {runningTarget === "all" ? <RefreshCw size={15} className="animate-spin" /> : <Play size={15} />}
              {runningTarget === "all" ? "Menjalankan Siklus..." : "Jalankan Siklus AI Sekarang"}
            </button>
          )}
        </Card>
      </div>

      {/* Row 2: Usulan Pending (Mode Saran) bila ada */}
      {pendingProposals.length > 0 && (
        <Card className="border-accent/40">
          <CardHead
            title={`Usulan Strategi Menunggu Persetujuan (${pendingProposals.length})`}
            hint="Dibuat oleh Autopilot dalam Mode Saran. Tinjau alasan kuantitatif di bawah sebelum mengeksekusi ke Meta Ads."
          />
          <div className="space-y-2.5">
            {pendingProposals.map((a) => {
              const s = actionSummary(a);
              return (
                <div key={a.id} className="flex flex-col justify-between gap-3 rounded-xl border border-line bg-bg px-4 py-3 sm:flex-row sm:items-center">
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="pill bg-accent-soft text-accent">{s.verb}</span>
                      <span className="font-semibold text-[13.5px]">{a.campaignName ?? a.accountName}</span>
                      <span className="text-[12px] text-muted">· {a.accountName}</span>
                    </div>
                    {a.reason && <p className="text-[13px] text-ink/90">{a.reason}</p>}
                    {s.detail && <p className="text-[12px] text-muted">{s.detail}</p>}
                  </div>
                  {isOwner && (
                    <div className="flex shrink-0 items-center gap-2">
                      <button type="button" className="btn min-h-[36px] px-3 text-[12.5px]" onClick={() => rejectPendingAction(a)}>
                        Tolak
                      </button>
                      <button type="button" className="btn btn-primary min-h-[36px] px-3.5 text-[12.5px]" onClick={() => approvePendingAction(a)}>
                        <CheckCircle2 size={14} /> Setujui & Eksekusi
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </Card>
      )}

      {/* Row 3: Grid Kontrol Otonomi & Guardrail per Akun */}
      {data.accounts.length === 0 ? (
        <Card>
          <EmptyState
            icon={<Cpu size={20} />}
            title="Belum ada akun iklan aktif"
            text="Hubungkan akun Meta Ads terlebih dahulu di halaman Pengaturan untuk mengaktifkan Autopilot Profit Engine."
          />
        </Card>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {data.accounts.map((item) => (
            <AccountAutopilotCard
              key={item.account.id}
              item={item}
              isOwner={isOwner}
              onEditGuardrail={setGuardrailAcc}
              onRunAccount={(id) => triggerRun(id)}
              runningId={runningTarget}
            />
          ))}
        </div>
      )}

      {/* Row 4: Navigasi Sub-Tab Custom */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line pb-3">
        <div
          className="inline-flex max-w-full overflow-x-auto rounded-xl border border-line bg-card p-1"
          role="tablist"
          aria-label="Detail Autopilot"
        >
          <button
            type="button"
            role="tab"
            aria-selected={sub === "runs"}
            onClick={() => setSub("runs")}
            className={cx(
              "inline-flex shrink-0 items-center gap-2 whitespace-nowrap rounded-lg px-3.5 py-2 text-[13px] font-semibold transition-colors",
              sub === "runs" ? "bg-accent-soft text-accent" : "text-muted hover:text-ink",
            )}
          >
            <Cpu size={15} /> Siklus & Keputusan AI ({data.runs.length})
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={sub === "assets"}
            onClick={() => setSub("assets")}
            className={cx(
              "inline-flex shrink-0 items-center gap-2 whitespace-nowrap rounded-lg px-3.5 py-2 text-[13px] font-semibold transition-colors",
              sub === "assets" ? "bg-accent-soft text-accent" : "text-muted hover:text-ink",
            )}
          >
            <Package size={15} /> Unit Economics & Bank Aset ({data.assets.length})
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={sub === "memories"}
            onClick={() => setSub("memories")}
            className={cx(
              "inline-flex shrink-0 items-center gap-2 whitespace-nowrap rounded-lg px-3.5 py-2 text-[13px] font-semibold transition-colors",
              sub === "memories" ? "bg-accent-soft text-accent" : "text-muted hover:text-ink",
            )}
          >
            <Brain size={15} /> Memori Eksperimen Angle ({data.memories.length})
          </button>
        </div>

        {sub === "assets" && isOwner && (
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => {
              setAssetDefaultProd(null);
              setAssetModalOpen(true);
            }}
          >
            <Plus size={16} /> Tambah Aset Kreatif
          </button>
        )}
      </div>

      {/* Konten Sub-Tab 1: Siklus & Keputusan AI */}
      {sub === "runs" && (
        <div className="space-y-3.5">
          {data.runs.length === 0 ? (
            <Card>
              <EmptyState
                icon={<Cpu size={20} />}
                title="Belum ada riwayat siklus Autopilot"
                text="Klik tombol Jalankan Siklus AI Sekarang di atas atau tunggu jadwal sinkronisasi Meta berikutnya."
              />
            </Card>
          ) : (
            data.runs.map((r) => (
              <AgentRunCard
                key={r.id}
                run={r}
                isOwner={isOwner}
                executedActionIds={executedActionIds}
                onRevert={handleRevertAction}
              />
            ))
          )}
        </div>
      )}

      {/* Konten Sub-Tab 2: Unit Economics Produk & Bank Aset Kreatif */}
      {sub === "assets" && (
        <div className="space-y-4">
          <Card>
            <CardHead
              title="Unit Economics Produk & Titik Impas Iklan"
              hint="AI menghitung batas maksimal CPA/CPL impas setiap produk (Harga Jual dikurangi HPP, Fee Platform, dan PPN Iklan) sebelum memutuskan peluncuran."
            />
            {data.products.length === 0 ? (
              <EmptyState
                icon={<Package size={20} />}
                title="Belum ada produk terdaftar"
                text="Tambahkan produk beserta harga jual, HPP, dan URL halaman di menu Pengaturan."
              />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[760px] text-left text-[13px]">
                  <thead>
                    <tr className="border-b border-line text-[11.5px] font-semibold uppercase tracking-wide text-muted">
                      <th className="py-2.5 pr-3">Produk</th>
                      <th className="px-3 py-2.5 text-right">Harga Jual</th>
                      <th className="px-3 py-2.5 text-right">HPP + Fee</th>
                      <th className="px-3 py-2.5 text-right">Margin / Unit</th>
                      <th className="px-3 py-2.5 text-right">Batas CPA Impas</th>
                      <th className="px-3 py-2.5 text-right">ROAS Impas</th>
                      <th className="px-3 py-2.5 text-right">Terjual 30h</th>
                      <th className="pl-3 py-2.5 text-right">Bank Aset</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {data.products.map((p) => {
                      const feeNominal = p.price != null ? Math.round((p.price * p.platformFeePct) / 100) : 0;
                      return (
                        <tr key={p.id} className="hover:bg-hover/60">
                          <td className="py-3 pr-3">
                            <div className="flex items-center gap-2">
                              <span className="font-semibold text-ink">{p.name}</span>
                              <span className="pill bg-track text-[11px] text-muted">{LINES[p.line].label}</span>
                              {p.url && (
                                <a
                                  href={p.url}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="text-muted hover:text-accent"
                                  title={p.url}
                                >
                                  <ExternalLink size={13} />
                                </a>
                              )}
                            </div>
                            {p.line === "digital" && !p.url && (
                              <p className="mt-0.5 text-[11.5px] text-red-ink">URL produk belum diisi (wajib untuk auto-launch)</p>
                            )}
                          </td>
                          <td className="num px-3 py-3 text-right">{p.price != null ? rp(p.price) : "Variabel"}</td>
                          <td className="num px-3 py-3 text-right text-muted">{rp(p.cogs + feeNominal)}</td>
                          <td className={cx("num px-3 py-3 text-right font-semibold", (p.profitBeforeAds ?? 1) > 0 ? "text-green-ink" : "text-red-ink")}>
                            {p.profitBeforeAds != null ? rp(p.profitBeforeAds) : "—"}
                          </td>
                          <td className="num px-3 py-3 text-right font-semibold">
                            {p.maxBreakEvenCpa != null ? rp(p.maxBreakEvenCpa) : "Ikut CPL Akun"}
                          </td>
                          <td className="num px-3 py-3 text-right">
                            {p.breakEvenRoas != null ? `${dec(p.breakEvenRoas)}x` : "—"}
                          </td>
                          <td className="num px-3 py-3 text-right">
                            {p.sold30d} <span className="text-muted">({rpk(p.revenue30d)})</span>
                          </td>
                          <td className="pl-3 py-3 text-right">
                            <div className="inline-flex items-center gap-2">
                              <span className={cx("pill num", p.assetCount > 0 ? "bg-green-soft text-green-ink" : "bg-yellow-soft text-yellow-ink")}>
                                {p.assetCount} aset
                              </span>
                              {isOwner && (
                                <button
                                  type="button"
                                  className="btn min-h-[30px] px-2.5 py-1 text-[12px]"
                                  onClick={() => {
                                    setAssetDefaultProd(p.id);
                                    setAssetModalOpen(true);
                                  }}
                                >
                                  <Plus size={13} /> Upload
                                </button>
                              )}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          <Card>
            <CardHead
              title="Bank Aset Kreatif Siap Tayang"
              hint="Kumpulan foto, video, dan postingan yang dipakai Autopilot AI saat menyusun variasi iklan baru secara otomatis."
              right={
                data.products.length > 0 && (
                  <div className="w-[220px]">
                    <CustomSelect
                      value={prodFilter}
                      ariaLabel="Filter produk aset"
                      onChange={setProdFilter}
                      options={[
                        { value: "all", label: "Semua Produk" },
                        ...data.products.map((p) => ({ value: String(p.id), label: p.name })),
                      ]}
                    />
                  </div>
                )
              }
            />
            {filteredAssets.length === 0 ? (
              <EmptyState
                icon={<ImageIcon size={20} />}
                title="Bank aset kreatif masih kosong"
                text="Tambahkan minimal 1 foto atau video produk agar AI dapat merakit kampanye baru secara mandiri saat iklan lama mengalami fatigue atau merugi."
              />
            ) : (
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {filteredAssets.map((a) => {
                  const KindIcon = a.kind === "video" ? Video : a.kind === "post" ? FileText : ImageIcon;
                  return (
                    <div key={a.id} className="flex flex-col justify-between gap-3 rounded-xl border border-line bg-bg p-3.5">
                      <div className="space-y-2">
                        <div className="flex items-start justify-between gap-2">
                          <div className="flex min-w-0 items-center gap-2.5">
                            <div className="grid size-9 shrink-0 place-items-center rounded-lg bg-accent-soft text-accent">
                              <KindIcon size={17} />
                            </div>
                            <div className="min-w-0">
                              <p className="truncate text-[13.5px] font-semibold">{a.name}</p>
                              <p className="truncate text-[12px] text-muted">{a.productName}</p>
                            </div>
                          </div>
                          <span className="pill bg-card text-muted num text-[11px]">Dipakai {a.timesUsed}x</span>
                        </div>
                        {a.notes && <p className="text-[12px] text-ink/85">{a.notes}</p>}
                        <div className="flex flex-wrap gap-1.5 text-[11px] text-muted">
                          {a.accountName && <span className="rounded-md bg-card px-2 py-0.5">{a.accountName}</span>}
                          {a.imageHash && <span className="rounded-md bg-card px-2 py-0.5 num">Hash: {a.imageHash.slice(0, 10)}...</span>}
                          {a.videoId && <span className="rounded-md bg-card px-2 py-0.5 num">Video ID: {a.videoId}</span>}
                          {a.objectStoryId && <span className="rounded-md bg-card px-2 py-0.5 num">Post: {a.objectStoryId}</span>}
                        </div>
                      </div>

                      {isOwner && (
                        <div className="flex justify-end border-t border-line pt-2.5">
                          <button
                            type="button"
                            className="btn btn-ghost min-h-[30px] px-2.5 py-1 text-[12px] text-muted hover:text-red-ink"
                            onClick={() => handleArchiveAsset(a)}
                          >
                            <Archive size={13} /> Nonaktifkan
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </Card>
        </div>
      )}

      {/* Konten Sub-Tab 3: Memori Eksperimen Angle */}
      {sub === "memories" && (
        <Card>
          <CardHead
            title="Memori Eksperimen Copywriting & Angle Iklan"
            hint="Setiap peluncuran dicatat ke memori episodis. AI mempelajari angle yang menang untuk di-scale dan memblokir pengulangan angle yang terbukti boncos."
            right={
              <div className="w-[210px]">
                <CustomSelect
                  value={memFilter}
                  ariaLabel="Filter status memori"
                  onChange={setMemFilter}
                  options={[
                    { value: "all", label: "Semua Status" },
                    { value: "winning", label: "Menang / Profitabel" },
                    { value: "testing", label: "Sedang Diuji" },
                    { value: "losing", label: "Boncos / Jangan Ulang" },
                    { value: "inconclusive", label: "Sampel Kecil" },
                  ]}
                />
              </div>
            }
          />
          {filteredMemories.length === 0 ? (
            <EmptyState
              icon={<Brain size={20} />}
              title="Belum ada memori eksperimen angle"
              text="Saat Autopilot meluncurkan kampanye atau variasi iklan baru, setiap angle dan metrik hasilnya akan tercatat otomatis di sini."
            />
          ) : (
            <div className="space-y-3">
              {filteredMemories.map((m) => {
                const badge = outcomeBadge(m.outcome);
                return (
                  <div key={m.id} className="rounded-xl border border-line bg-bg p-4">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="space-y-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="pill bg-accent-soft text-accent">{formatAngle(m.angle)}</span>
                          <span className={cx("pill", badge.cls)}>{badge.label}</span>
                          {m.productName && <span className="text-[13px] font-semibold">{m.productName}</span>}
                          <span className="text-[12px] text-muted">· {m.accountName}</span>
                        </div>
                        {m.headline && <p className="text-[13.5px] font-semibold text-ink">Headline: &ldquo;{m.headline}&rdquo;</p>}
                        {m.hookSummary && <p className="text-[12.5px] text-muted">{m.hookSummary}</p>}
                      </div>

                      <div className="flex flex-wrap items-center gap-3 rounded-lg border border-line bg-card px-3 py-1.5 text-[12px] num">
                        <span>Spend: <strong>{rpk(m.metrics.spend ?? 0)}</strong></span>
                        <span>Hasil: <strong>{m.metrics.results ?? 0}</strong></span>
                        {m.metrics.cpa != null && <span>CPA: <strong>{rpk(m.metrics.cpa)}</strong></span>}
                        {(m.metrics.roas ?? 0) > 0 && <span>ROAS: <strong>{dec(m.metrics.roas ?? 0)}x</strong></span>}
                      </div>
                    </div>

                    {m.lesson && (
                      <div className="mt-2.5 rounded-lg border border-line bg-card px-3 py-2 text-[12.5px] text-ink">
                        <span className="font-semibold">Kesimpulan AI: </span>
                        {m.lesson}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </Card>
      )}

      <GuardrailModal acc={guardrailAcc} onClose={() => setGuardrailAcc(null)} />
      <AssetModal
        open={assetModalOpen}
        onClose={() => setAssetModalOpen(false)}
        products={data.products}
        accounts={boot.accounts}
        defaultProductId={assetDefaultProd}
      />
    </div>
  );
}
