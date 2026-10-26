import { useEffect, useRef, useState } from "react";
import {
  Send, Zap, Check, Undo2, Square, Maximize2, Minimize2, X, RotateCcw, Paperclip, Film,
  AlertCircle, BarChart3, Lightbulb, Flame, Clock3, Trophy, Wallet, Copy, RefreshCw,
  ArrowUpRight, ArrowDown, ImagePlus, Layers, Sparkles, Rocket, ShieldCheck,
} from "lucide-react";
import { fmtRange, type BotAction } from "@iklan/shared";
import { api, useBootstrap, actionsApi, refreshData, ApiError } from "../lib/api";
import { setView, useView } from "../lib/view";
import { actionSummary } from "../lib/campaign-action";
import { accLabel } from "../components/pickers";
import { toast, cx } from "../components/ui";
import { AdBot, type BotMood } from "../components/AdBot";
import { Markdown } from "./Markdown";
import { Widget } from "./Widgets";
import { LaunchPlan } from "./LaunchPlan";
import { VideoCard } from "./VideoCard";
import { useChat, send, greet, updateAction, resetChat, stopChat, textOf, type Msg, type SentFile } from "./store";
import { ACCEPT, fmtSize, precheck, uploadMedia, videoCover, type Pending } from "./media";

const STARTER_CARDS = [
  {
    tag: "Audit Performa",
    title: "Ringkasan & Evaluasi ROAS",
    desc: "Cek laba bersih, omzet riil, spend, serta perbandingan periode.",
    prompt: "Ringkasan performa minggu ini",
    icon: BarChart3,
  },
  {
    tag: "Deteksi Boncos",
    title: "Cari Kampanye Paling Boros",
    desc: "Bedah funnel CPM, CTR, CVR, dan kampanye yang wajib di-pause.",
    prompt: "Kampanye paling boros?",
    icon: Flame,
  },
  {
    tag: "Scale & Optimasi",
    title: "Rekomendasi Scale & Jam Cuan",
    desc: "Temukan kampanye winning untuk dinaikkan budget dan jam terbaik.",
    prompt: "Rekomendasi kampanye",
    icon: Lightbulb,
  },
  {
    tag: "Meta Ads Otomatis",
    title: "Buat & Tayangkan Iklan Baru",
    desc: "Susun struktur kampanye CBO, copywriting, atau render video 9:16.",
    prompt: "Saya ingin membuat iklan baru di Meta Ads, bantu siapkan rencananya.",
    icon: Rocket,
  },
] as const;

const CHIPS = [
  ["Ringkasan performa minggu ini", BarChart3],
  ["Rekomendasi kampanye", Lightbulb],
  ["Kampanye paling boros?", Flame],
  ["Jam paling cuan?", Clock3],
  ["Produk terlaris bulan ini", Trophy],
  ["Laba rugi bulan lalu", Wallet],
] as const;

const STEPS = ["Membaca data iklan", "Menghitung CPA & ROAS", "Membandingkan kampanye", "Menyusun jawaban"];
const WIDGET_STEPS = ["Menyiapkan grafik", "Merangkum temuan"];
const TIPS = [
  "Tanya: “kampanye mana yang paling boros minggu ini?” untuk cek potensi kebocoran budget.",
  "Lampirkan atau drag-and-drop foto/video produk, nanti langsung dibuatkan draft iklan Meta Ads.",
  "Ketik “pindah ke akun jasa” atau “periode 30 hari”, filter dashboard otomatis ikut berubah.",
  "Semua aksi pause, scale budget, atau tayang iklan selalu meminta konfirmasi lebih dulu.",
];

function ActionCard({ action }: { action: BotAction }) {
  const [busy, setBusy] = useState(false);
  const s = actionSummary(action);
  const p = action.params as any;
  const run = async (kind: "confirm" | "cancel" | "revert") => {
    setBusy(true);
    try {
      const a = await actionsApi[kind](action.id);
      updateAction(a);
      if (kind === "confirm") a.status === "executed" ? toast(`${s.verb}: ${a.campaignName} berhasil`) : toast(`Gagal: ${a.error}`, { tone: "err" });
      refreshData();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "Gagal", { tone: "err" });
    }
    setBusy(false);
  };
  const expired = action.status === "pending" && action.expiresAt && new Date(action.expiresAt) < new Date();
  return (
    <div className="overflow-hidden rounded-2xl border border-line-strong bg-card text-[13px] shadow-card">
      <div className="flex items-center justify-between gap-2 border-b border-line bg-bg/60 px-4 py-2.5">
        <p className="flex items-center gap-2 font-semibold text-ink">
          <span className="grid size-6 place-items-center rounded-lg bg-accent-soft text-accent"><Zap size={13} /></span>
          {s.title.replace("?", "")}
        </p>
        <span className="pill bg-accent-soft text-[11px] text-accent">
          <ShieldCheck size={12} /> Butuh Konfirmasi
        </span>
      </div>
      <div className="p-4">
        <p className="text-[14px] font-semibold text-ink">{action.campaignName ?? (p.campaignName as string | undefined) ?? (p.plan?.campaignName as string | undefined)}</p>
        {(action.action === "launch" || action.action === "add_ads") ? <LaunchPlan action={action} /> : (
          <>
            <p className="mt-0.5 text-[12px] text-muted">{action.accountName}</p>
            <p className="mt-2.5 whitespace-pre-line rounded-xl border border-line bg-bg px-3 py-2 text-[12.5px] leading-relaxed">{s.detail}</p>
          </>
        )}
        {p.demo && <p className="mt-2 text-[11.5px] text-muted">Mode demo: perubahan hanya disimpan di database lokal dashboard.</p>}
        {action.status === "pending" && !expired ? (
          <div className="mt-3.5 flex gap-2">
            <button className="btn btn-primary h-9 min-h-0 flex-1 rounded-xl" disabled={busy} onClick={() => run("confirm")}>
              <Check size={15} /> {busy && (action.action === "launch" || action.action === "add_ads") ? "Membuat iklan…" : "Ya, eksekusi sekarang"}
            </button>
            <button className="btn h-9 min-h-0 rounded-xl px-4" disabled={busy} onClick={() => run("cancel")}>Batal</button>
          </div>
        ) : (
          <div className="mt-3 flex items-center justify-between gap-2 border-t border-line pt-2.5 text-[12px]">
            <span className={cx("font-semibold", action.status === "executed" ? "text-green-ink" : action.status === "failed" ? "text-red-ink" : "text-muted")}>
              {action.status === "executed" ? <span className="inline-flex items-center gap-1.5"><Check size={14} /> Berhasil dieksekusi</span>
                : action.status === "failed" ? `Gagal: ${action.error}` : expired ? "Kedaluwarsa" : action.status === "reverted" ? "Dibalikkan ke semula" : "Dibatalkan"}
            </span>
            {action.status === "executed" && !p.demo && (
              <button className="inline-flex items-center gap-1 font-semibold text-accent hover:underline" disabled={busy} onClick={() => run("revert")}>
                <Undo2 size={13} /> {action.action === "launch" ? "Pause kampanye ini" : action.action === "add_ads" ? "Pause iklan baru ini" : "Batalkan aksi"}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** Kotak kecil foto/video: pratinjau lokal, nama, ukuran, dan progres upload kalau masih jalan. */
function FileThumb({ kind, preview, name, size, progress, error, onRemove }: {
  kind: "image" | "video"; preview: string; name: string; size: number; progress?: number; error?: string; onRemove?: () => void;
}) {
  const uploading = progress != null && progress < 100 && !error;
  return (
    <div className={cx("relative flex w-[210px] items-center gap-2.5 rounded-xl border bg-bg/70 p-2 text-left text-ink transition-colors", error ? "border-red bg-red-soft/40" : "border-line")}>
      <div className="relative size-11 shrink-0 overflow-hidden rounded-lg border border-line bg-card">
        {kind === "image" ? <img src={preview} alt="" className="size-full object-cover" />
          : <><video src={preview} muted preload="metadata" className="size-full object-cover" /><Film size={13} className="absolute bottom-1 right-1 text-white drop-shadow" /></>}
      </div>
      <div className="min-w-0 flex-1 leading-tight">
        <p className="truncate text-[12px] font-semibold">{name}</p>
        <p className={cx("mt-0.5 text-[11px]", error ? "text-red-ink" : "text-muted")}>
          {error ?? (uploading ? `Mengupload ${progress}%` : `${kind === "video" ? "Video" : "Foto"} · ${fmtSize(size)}`)}
        </p>
        {uploading && (
          <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-track">
            <div className="h-full rounded-full bg-accent transition-[width]" style={{ width: `${progress}%` }} />
          </div>
        )}
      </div>
      {onRemove && (
        <button type="button" onClick={onRemove} className="grid size-6 shrink-0 place-items-center rounded-lg text-muted hover:bg-hover hover:text-ink" aria-label={`Hapus ${name}`}>
          <X size={14} />
        </button>
      )}
    </div>
  );
}

function Working({ steps, bot }: { steps: string[]; bot?: boolean }) {
  const [t, setT] = useState(0);
  useEffect(() => { const id = setInterval(() => setT((x) => x + 1), 1000); return () => clearInterval(id); }, []);
  const i = Math.min(steps.length - 1, Math.floor(t / 2));
  return (
    <div className="flex items-center gap-3" role="status">
      {bot && <AdBot size={32} head mood="think" />}
      <div className="w-full max-w-[260px] space-y-2">
        <div className="flex items-center justify-between gap-2 text-[12.5px] font-medium leading-none">
          <span key={i} className="ab-step ab-status inline-flex items-center gap-1.5">
            <span className="size-1.5 rounded-full bg-accent" />
            {steps[i]}…
          </span>
          <span className="num text-[11px] font-normal text-muted">
            {t >= 2 ? `${t} dtk` : `${i + 1}/${steps.length}`}
          </span>
        </div>
        <div className="ab-bar" />
      </div>
    </div>
  );
}

/** Layar sambutan: maskot interaktif, kartu kategori aksi cepat, dan petunjuk upload media iklan. */
function Hero({ page, greeting, ctx, rangeText, owner, onPick, onAttach }: {
  page: boolean; greeting: string; ctx: string; rangeText: string; owner: boolean; onPick: (q: string) => void; onAttach: () => void;
}) {
  const [tip, setTip] = useState(-1);
  const [wave, setWave] = useState(1);
  const poke = () => { setTip((t) => (t + 1) % TIPS.length); setWave((w) => w + 1); };
  return (
    <div className={cx("mx-auto flex w-full flex-col items-center", page ? "max-w-[760px] py-6 md:py-10" : "py-3")}>
      <div className="flex flex-col items-center text-center sm:flex-row sm:items-center sm:gap-4 sm:text-left">
        <button type="button" onClick={poke} className="group relative shrink-0 rounded-2xl border border-line bg-accent-soft/60 p-2 transition-transform hover:scale-105" title="Klik untuk tips cepat" aria-label="Sapa bot, tampilkan tips">
          <AdBot size={page ? 88 : 68} track wave={wave} />
        </button>
        <div className="mt-3 sm:mt-0">
          <div className="inline-flex items-center gap-1.5 rounded-full border border-line bg-bg px-2.5 py-1 text-[11.5px] font-medium text-muted">
            <Sparkles size={12} className="text-accent" />
            <span>Asisten AI Meta Ads & Penjualan</span>
            <span className="text-muted-2">·</span>
            <span className="font-semibold text-ink">{ctx}</span>
          </div>
          <h2 className={cx("mt-2 font-semibold tracking-tight text-ink", page ? "text-[22px] md:text-[24px]" : "text-[17px]")}>
            Mau analisis performa atau buat iklan hari ini?
          </h2>
          <p key={tip} className="mt-1 max-w-[520px] text-[13px] leading-relaxed text-muted">
            {tip < 0 ? (greeting || `Membaca data ${ctx} (${rangeText}). Pilih topik di bawah atau ketik pertanyaan langsung.`) : TIPS[tip]}
          </p>
        </div>
      </div>

      {/* Grid Kartu Starter */}
      <div className={cx("mt-6 grid w-full gap-2.5", page ? "sm:grid-cols-2" : "grid-cols-1")}>
        {STARTER_CARDS.map((card, i) => {
          const Icon = card.icon;
          return (
            <button
              key={card.title}
              type="button"
              onClick={() => onPick(card.prompt)}
              style={{ animationDelay: `${i * 40}ms` }}
              className="pop-in group flex items-start gap-3.5 rounded-2xl border border-line bg-bg/50 p-3.5 text-left transition-all hover:border-accent hover:bg-card hover:shadow-card"
            >
              <span className="grid size-10 shrink-0 place-items-center rounded-xl border border-line bg-card text-accent transition-colors group-hover:border-accent/40 group-hover:bg-accent-soft">
                <Icon size={18} />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[11px] font-semibold uppercase tracking-wider text-accent">{card.tag}</span>
                  <ArrowUpRight size={14} className="text-muted opacity-0 transition-all group-hover:translate-x-0.5 group-hover:-translate-y-0.5 group-hover:text-accent group-hover:opacity-100" />
                </div>
                <p className="mt-0.5 text-[13.5px] font-semibold text-ink">{card.title}</p>
                <p className="mt-0.5 line-clamp-2 text-[12px] leading-relaxed text-muted">{card.desc}</p>
              </div>
            </button>
          );
        })}
      </div>

      {/* Banner Upload Media Cepat (Khusus Owner) */}
      {owner && (
        <div className="mt-3 flex w-full flex-wrap items-center justify-between gap-3 rounded-2xl border border-dashed border-line-strong bg-bg/40 px-4 py-3 text-[12.5px]">
          <div className="flex items-center gap-2.5 text-muted">
            <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-accent-soft text-accent">
              <ImagePlus size={16} />
            </span>
            <span>
              Punya bahan foto atau video produk? <b>Lampirkan atau tarik file ke sini</b> untuk dibuatkan kampanye iklan Meta Ads.
            </span>
          </div>
          <button type="button" onClick={onAttach} className="btn h-8 min-h-0 shrink-0 rounded-lg px-3 text-[12px]">
            <Paperclip size={13} /> Pilih Foto / Video
          </button>
        </div>
      )}

      {/* Baris Pertanyaan Cepat Tambahan */}
      <div className="mt-4 flex w-full flex-wrap items-center justify-center gap-1.5">
        {CHIPS.slice(3).map(([c, Icon]) => (
          <button
            key={c}
            type="button"
            onClick={() => onPick(c)}
            className="inline-flex items-center gap-1.5 rounded-full border border-line bg-card px-3 py-1.5 text-[12px] font-medium text-muted transition-colors hover:border-accent hover:text-ink"
          >
            <Icon size={13} className="text-accent" />
            <span>{c}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function BotMessage({ m, last, busy, page, onRetry }: { m: Msg; last: boolean; busy: boolean; page: boolean; onRetry?: () => void }) {
  const [copied, setCopied] = useState(false);
  const empty = !m.parts.length && !m.action;
  const widgetPending = last && busy && m.parts[m.parts.length - 1]?.type === "widget";
  const mood: BotMood = m.error ? "sad" : empty || widgetPending ? "think" : last && busy ? "talk" : "idle";
  const fullText = textOf(m).trim();

  const copyText = async () => {
    if (!fullText) return;
    try {
      await navigator.clipboard.writeText(fullText);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast("Gagal menyalin teks", { tone: "err" });
    }
  };

  return (
    <div className="pop-in group flex items-start gap-3">
      <div className="mt-0.5 grid size-9 shrink-0 place-items-center rounded-xl border border-line bg-accent-soft">
        <AdBot size={28} head mood={mood} className={cx(!last && "ab-still")} />
      </div>
      <div className="min-w-0 flex-1 space-y-2.5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[13px] font-semibold text-ink">Bot Iklan</span>
          {m.ctx && (
            <span className="inline-flex items-center gap-1 rounded-md border border-line bg-bg px-2 py-0.5 text-[11px] font-medium text-muted">
              <Layers size={11} className="text-accent" />
              {m.ctx}
            </span>
          )}
        </div>

        {m.parts.map((p, i) =>
          p.type === "widget" ? (
            <Widget key={i} w={p.widget} />
          ) : p.type === "video" ? (
            <VideoCard key={i} runId={p.runId} />
          ) : (
            p.text.trim() && (
              <div
                key={i}
                className={cx(
                  "rounded-2xl rounded-tl-sm border text-[13.5px] leading-relaxed",
                  m.error
                    ? "border-red/30 bg-red-soft px-4 py-3 text-red-ink"
                    : page
                      ? "border-line bg-bg/45 px-5 py-4"
                      : "border-line bg-bg/70 px-3.5 py-3",
                )}
              >
                <Markdown text={p.text} />
              </div>
            )
          ),
        )}

        {(empty || widgetPending) && (
          <div className="w-fit min-w-[250px] rounded-2xl rounded-tl-sm border border-line bg-bg/60 px-4 py-3">
            <Working bot={false} steps={empty ? STEPS : WIDGET_STEPS} />
          </div>
        )}

        {m.action && <ActionCard action={m.action} />}

        {/* Action Bar bawah pesan bot (Salin & Tanya Ulang) */}
        {!busy && fullText && (
          <div className="flex items-center gap-1 pt-0.5 opacity-80 transition-opacity group-hover:opacity-100">
            <button
              type="button"
              onClick={copyText}
              className="inline-flex h-7 items-center gap-1.5 rounded-lg px-2 text-[11.5px] font-medium text-muted transition-colors hover:bg-hover hover:text-ink"
              title="Salin jawaban"
            >
              {copied ? <><Check size={13} className="text-green" /><span className="text-green-ink">Tersalin</span></> : <><Copy size={13} /><span>Salin</span></>}
            </button>
            {last && onRetry && (
              <button
                type="button"
                onClick={onRetry}
                className="inline-flex h-7 items-center gap-1.5 rounded-lg px-2 text-[11.5px] font-medium text-muted transition-colors hover:bg-hover hover:text-ink"
                title="Ulangi jawaban terakhir"
              >
                <RefreshCw size={12} />
                <span>Ulangi</span>
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export default function ChatView({ variant, onClose }: { variant: "panel" | "page"; onClose?: () => void }) {
  const page = variant === "page";
  const boot = useBootstrap().data!;
  const view = useView();
  const { msgs, busy } = useChat();
  const [input, setInput] = useState("");
  const [dragging, setDragging] = useState(false);
  const [atBottom, setAtBottom] = useState(true);
  const body = useRef<HTMLDivElement>(null);
  const ta = useRef<HTMLTextAreaElement>(null);
  const owner = boot.user.role === "owner";
  const fresh = msgs.length <= 1;
  const tail = msgs[msgs.length - 1];

  // Ekspresi maskot di header: berpikir → bicara saat teks mengalir → senang/sedih sebentar setelah selesai.
  const [after, setAfter] = useState<BotMood | null>(null);
  const wasBusy = useRef(false);
  useEffect(() => {
    const ended = wasBusy.current && !busy;
    wasBusy.current = busy;
    if (!ended) return;
    setAfter(tail?.error ? "sad" : "happy");
    const t = setTimeout(() => setAfter(null), 1800);
    return () => clearTimeout(t);
  }, [busy]); // eslint-disable-line react-hooks/exhaustive-deps
  const mood: BotMood = busy ? (tail?.role === "bot" && textOf(tail) ? "talk" : "think") : after ?? "idle";

  const scrollToBottom = (behavior: ScrollBehavior = "smooth") => {
    body.current?.scrollTo({ top: body.current.scrollHeight, behavior });
  };

  useEffect(() => { greet(); setTimeout(() => ta.current?.focus(), 50); }, []);
  useEffect(() => { if (atBottom || busy) scrollToBottom("smooth"); }, [msgs]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const el = ta.current;
    if (el) {
      el.style.height = "auto";
      el.style.height = Math.min(el.scrollHeight, 160) + "px";
    }
  }, [input]);

  const onScroll = () => {
    const el = body.current;
    if (!el) return;
    setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 80);
  };

  const [pending, setPending] = useState<Pending[]>([]);
  const fileInput = useRef<HTMLInputElement>(null);
  const uploading = pending.some((p) => !p.att && !p.error);
  const ready = pending.filter((p) => p.att);
  const upd = (key: string, f: (p: Pending) => Pending) => setPending((ps) => ps.map((p) => (p.key === key ? f(p) : p)));

  const addFiles = (list: FileList | File[] | null) => {
    if (!owner || !list) return;
    for (const file of Array.from(list).slice(0, 4 - pending.length)) {
      const key = crypto.randomUUID(), preview = URL.createObjectURL(file), bad = precheck(file);
      setPending((ps) => [...ps, { key, file, preview, progress: 0, error: bad ?? undefined }]);
      if (bad) continue;
      const cover = file.type.startsWith("video/") ? videoCover(file) : null;
      uploadMedia(file, (pct) => upd(key, (p) => ({ ...p, progress: Math.min(pct, 99) })), (xhr) => upd(key, (p) => ({ ...p, xhr })))
        .then(async (att) => {
          const c = cover && (await cover);
          if (c) await uploadMedia(c, () => {}, (xhr) => upd(key, (p) => ({ ...p, xhr })), att.id).catch(() => null);
          upd(key, (p) => ({ ...p, att, progress: 100, xhr: undefined }));
        })
        .catch((e) => upd(key, (p) => ({ ...p, error: (e as Error).message, xhr: undefined })));
    }
  };

  const removePending = (p: Pending) => {
    p.xhr?.abort();
    if (p.att) void api(`/chat/media/${p.att.id}`, { method: "DELETE" }).catch(() => {});
    URL.revokeObjectURL(p.preview);
    setPending((ps) => ps.filter((x) => x.key !== p.key));
  };

  const submit = (t: string) => {
    if ((!t.trim() && !ready.length) || busy || uploading) return;
    const files: SentFile[] = ready.map((p) => ({ ...p.att!, preview: p.preview }));
    pending.filter((p) => !p.att).forEach((p) => URL.revokeObjectURL(p.preview));
    setPending([]);
    setInput("");
    setAtBottom(true);
    void send(t, boot.accounts, owner, files);
  };

  const retryLast = () => {
    if (busy) return;
    const lastUser = [...msgs].reverse().find((m) => m.role === "user");
    if (lastUser) void send(textOf(lastUser), boot.accounts, owner);
  };

  const scopeLabel = accLabel(view.acc, boot.accounts);
  const rangeLabel = view.from ? fmtRange(view.from, view.to) : "";
  const statusLabel = boot.integration.aiConfigured ? "Claude AI · Aktif" : "Mode Aturan Lokal";

  // Pesan percakapan: sembunyikan pesan sambutan default (msgs[0]) ketika user sudah mulai bertanya agar alur percakapan bersih.
  const visibleMsgs = fresh ? msgs : msgs.filter((m, idx) => !(idx === 0 && m.role === "bot" && !m.ctx && !m.action));

  return (
    <div
      className="relative flex min-h-0 w-full flex-1 flex-col"
      onDragOver={(e) => { if (owner && e.dataTransfer.types.includes("Files")) { e.preventDefault(); setDragging(true); } }}
      onDragLeave={(e) => { if (e.currentTarget === e.target || !e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false); }}
      onDrop={(e) => {
        if (!owner) return;
        e.preventDefault();
        setDragging(false);
        if (e.dataTransfer.files?.length) addFiles(e.dataTransfer.files);
      }}
    >
      {/* Overlay Drag & Drop Media */}
      {dragging && owner && (
        <div className="pop-in pointer-events-none absolute inset-3 z-40 flex flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-accent bg-card/95 text-center backdrop-blur-xs">
          <div className="grid size-14 place-items-center rounded-2xl bg-accent-soft text-accent">
            <ImagePlus size={28} />
          </div>
          <p className="text-[15px] font-semibold text-ink">Lepaskan Foto atau Video di Sini</p>
          <p className="text-[12.5px] text-muted">Maks. 4 file (JPG, PNG, WebP, MP4, MOV) untuk bahan iklan Meta Ads</p>
        </div>
      )}

      {/* Header Bar Full-Width */}
      <div className={cx("flex shrink-0 items-center justify-between gap-3 border-b border-line bg-card px-4 py-3 md:px-6", !page && "pt-[max(12px,env(safe-area-inset-top))]")}>
        <div className="flex min-w-0 items-center gap-3">
          <div className="relative grid size-10 shrink-0 place-items-center rounded-xl border border-line bg-accent-soft">
            <AdBot size={32} head mood={mood} />
            <span className={cx("absolute -bottom-0.5 -right-0.5 size-2.5 rounded-full border-2 border-card", boot.integration.aiConfigured ? "bg-green" : "bg-yellow")} />
          </div>
          <div className="min-w-0 leading-tight">
            <div className="flex items-center gap-2">
              <p className="truncate text-[14.5px] font-semibold text-ink">Bot Iklan AI</p>
              <span className={cx("hidden rounded-md px-1.5 py-0.5 text-[11px] font-semibold sm:inline-block", boot.integration.aiConfigured ? "bg-accent-soft text-accent" : "bg-hover text-muted")}>
                {statusLabel}
              </span>
              {busy && (
                <span className="inline-flex items-center gap-1 rounded-full bg-accent-soft px-2 py-0.5 text-[11px] font-semibold text-accent">
                  <span className="size-1.5 animate-pulse rounded-full bg-accent" />
                  {mood === "talk" ? "Menulis jawaban…" : "Menganalisis…"}
                </span>
              )}
            </div>
            <p className="mt-0.5 truncate text-[12px] text-muted">
              Scope aktif: <span className="font-medium text-ink">{scopeLabel}</span>
              {rangeLabel ? ` · ${rangeLabel}` : ""}
            </p>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          {!fresh && (
            <button
              type="button"
              className="btn h-8 min-h-0 gap-1.5 rounded-lg px-2.5 text-[12px]"
              onClick={resetChat}
              title="Mulai percakapan baru"
            >
              <RotateCcw size={14} />
              <span className="hidden sm:inline">Chat Baru</span>
            </button>
          )}
          {page ? (
            <button
              type="button"
              className="btn btn-ghost size-8 min-h-0 rounded-lg p-0"
              onClick={() => setView({ tab: "ringkasan" })}
              title="Kembali ke Ringkasan"
              aria-label="Kembali ke Ringkasan"
            >
              <Minimize2 size={16} />
            </button>
          ) : (
            <button
              type="button"
              className="btn btn-ghost hidden size-8 min-h-0 rounded-lg p-0 md:inline-flex"
              onClick={() => { onClose?.(); setView({ tab: "chat" }); }}
              title="Buka layar penuh"
              aria-label="Buka chat layar penuh"
            >
              <Maximize2 size={16} />
            </button>
          )}
          {onClose && (
            <button type="button" className="btn btn-ghost size-8 min-h-0 rounded-lg p-0" onClick={onClose} aria-label="Tutup chat">
              <X size={18} />
            </button>
          )}
        </div>
      </div>

      {/* Area Scroll Percakapan (Full-Width Scrollbar di Tepi Kanan, Konten Terpusat) */}
      <div
        ref={body}
        onScroll={onScroll}
        className="chat-scroll flex-1 overflow-y-auto px-4 py-5 md:px-6"
        aria-live="polite"
      >
        <div className={cx("mx-auto w-full", page ? "max-w-[820px]" : "max-w-full")}>
          {fresh ? (
            <Hero
              page={page}
              greeting={msgs[0] ? textOf(msgs[0]) : ""}
              ctx={scopeLabel}
              rangeText={rangeLabel}
              owner={owner}
              onPick={submit}
              onAttach={() => fileInput.current?.click()}
            />
          ) : (
            <div className="space-y-6 pb-2">
              {visibleMsgs.map((m, i) =>
                m.role === "user" ? (
                  <div key={m.id} className="ml-auto flex w-fit max-w-[88%] flex-col items-end gap-2 sm:max-w-[76%]">
                    {m.files?.length ? (
                      <div className="flex flex-wrap justify-end gap-2">
                        {m.files.map((f) => <FileThumb key={f.id} {...f} />)}
                      </div>
                    ) : null}
                    <div className="pop-in whitespace-pre-wrap rounded-2xl rounded-tr-sm bg-accent px-4 py-2.5 text-[14px] leading-relaxed text-accent-ink shadow-card">
                      {m.parts[0]?.type === "text" ? m.parts[0].text : ""}
                    </div>
                  </div>
                ) : (
                  <BotMessage
                    key={m.id}
                    m={m}
                    last={i === visibleMsgs.length - 1}
                    busy={busy}
                    page={page}
                    onRetry={retryLast}
                  />
                ),
              )}
            </div>
          )}
        </div>
      </div>

      {/* Tombol Melayang Scroll ke Bawah */}
      {!atBottom && !fresh && (
        <div className="pointer-events-none absolute inset-x-0 bottom-36 z-20 flex justify-center">
          <button
            type="button"
            onClick={() => scrollToBottom("smooth")}
            className="pointer-events-auto inline-flex items-center gap-1.5 rounded-full border border-line-strong bg-card px-3 py-1.5 text-[12px] font-semibold text-ink shadow-pop transition-transform hover:-translate-y-0.5"
          >
            <ArrowDown size={13} className="text-accent" />
            <span>Ke pesan terbaru</span>
          </button>
        </div>
      )}

      {/* Footer / Dock Komposer */}
      <div className={cx("shrink-0 border-t border-line bg-bg/35 px-4 pt-2.5", page ? "pb-4 md:px-6" : "pb-[max(12px,env(safe-area-inset-bottom))]")}>
        <div className={cx("mx-auto w-full", page ? "max-w-[820px]" : "max-w-full")}>
          {/* Baris Saran Pertanyaan Cepat saat sedang chat */}
          {!fresh && (
            <div className="mb-2.5 flex items-center gap-1.5 overflow-x-auto scrollbar-none">
              <span className="inline-flex shrink-0 items-center gap-1 pr-1 text-[11.5px] font-semibold text-muted">
                <Sparkles size={12} className="text-accent" /> Tanya cepat:
              </span>
              {CHIPS.map(([c, Icon]) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => submit(c)}
                  disabled={busy}
                  className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-line bg-card px-2.5 py-1 text-[12px] font-medium text-ink transition-colors hover:border-accent hover:text-accent disabled:opacity-45"
                >
                  <Icon size={12} className="text-muted" />
                  <span>{c}</span>
                </button>
              ))}
            </div>
          )}

          {/* Form Input Multi-Baris */}
          <form onSubmit={(e) => { e.preventDefault(); submit(input); }}>
            <div className="ab-composer overflow-hidden rounded-2xl">
              {/* Daftar Lampiran yang Sedang Diupload / Siap Dikirim */}
              {pending.length > 0 && (
                <div className="flex flex-wrap gap-2 border-b border-line bg-bg/40 px-3.5 py-2.5">
                  {pending.map((p) => (
                    <FileThumb
                      key={p.key}
                      kind={p.file.type.startsWith("video/") ? "video" : "image"}
                      preview={p.preview}
                      name={p.file.name}
                      size={p.file.size}
                      progress={p.att ? undefined : p.progress}
                      error={p.error}
                      onRemove={() => removePending(p)}
                    />
                  ))}
                  {pending.some((p) => p.error) && (
                    <p className="flex w-full items-center gap-1.5 text-[11.5px] text-red-ink">
                      <AlertCircle size={13} /> Lampiran yang bermasalah tidak akan ikut dikirim.
                    </p>
                  )}
                </div>
              )}

              <textarea
                ref={ta}
                rows={1}
                className="max-h-40 min-h-[46px] w-full resize-none bg-transparent px-3.5 pt-3 pb-1.5 text-[14px] leading-relaxed outline-none placeholder:text-muted-2 focus-visible:outline-none"
                placeholder={
                  ready.length
                    ? "Jelaskan rencana iklannya: pilih akun, tujuan (sales/WA/traffic), dan budget harian…"
                    : "Tanya performa iklan, minta rekomendasi, atau lampirkan foto/video untuk iklan baru…"
                }
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onPaste={(e) => {
                  const files = Array.from(e.clipboardData?.files ?? []);
                  if (files.length && owner) addFiles(files);
                }}
                maxLength={2000}
                aria-label="Pesan untuk bot"
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    submit(input);
                  }
                }}
              />

              {/* Toolbar Bawah Komposer */}
              <div className="flex items-center justify-between gap-2 px-2.5 pb-2 pt-1">
                <div className="flex min-w-0 items-center gap-1.5">
                  {owner && (
                    <>
                      <input
                        ref={fileInput}
                        type="file"
                        accept={ACCEPT}
                        multiple
                        hidden
                        onChange={(e) => { addFiles(e.target.files); e.target.value = ""; }}
                      />
                      <button
                        type="button"
                        className="inline-flex h-8 items-center gap-1.5 rounded-xl border border-line bg-bg/70 px-2.5 text-[12px] font-medium text-ink transition-colors hover:border-accent hover:bg-accent-soft hover:text-accent disabled:opacity-45"
                        onClick={() => fileInput.current?.click()}
                        disabled={busy || pending.length >= 4}
                        title="Lampirkan foto/video untuk iklan (JPG/PNG maks. 30 MB, MP4/MOV maks. 100 MB)"
                        aria-label="Lampirkan foto atau video"
                      >
                        <ImagePlus size={15} className="text-accent" />
                        <span>Media Iklan</span>
                        {pending.length > 0 && <span className="num rounded-full bg-accent px-1.5 text-[10.5px] font-semibold text-accent-ink">{pending.length}/4</span>}
                      </button>
                    </>
                  )}
                  <span className="hidden truncate rounded-lg bg-bg px-2 py-1 text-[11.5px] text-muted sm:inline-flex sm:items-center sm:gap-1">
                    <Layers size={12} className="shrink-0 text-muted" />
                    <span className="truncate">{scopeLabel}</span>
                  </span>
                </div>

                <div className="flex shrink-0 items-center gap-2.5">
                  {page && (
                    <span className="hidden text-[11px] text-muted-2 md:inline">
                      Enter kirim · Shift+Enter baris baru
                    </span>
                  )}
                  {busy ? (
                    <button
                      type="button"
                      onClick={stopChat}
                      className="btn h-8 min-h-0 gap-1.5 rounded-xl border-red/40 bg-red-soft px-3 text-[12.5px] text-red-ink hover:bg-red hover:text-white"
                      aria-label="Hentikan jawaban"
                    >
                      <Square size={12} className="fill-current" />
                      <span>Hentikan</span>
                    </button>
                  ) : (
                    <button
                      type="submit"
                      className="btn btn-primary h-8 min-h-0 gap-1.5 rounded-xl px-3.5 text-[12.5px] transition-transform active:scale-95"
                      disabled={(!input.trim() && !ready.length) || uploading}
                      aria-label="Kirim pesan"
                      title={uploading ? "Tunggu upload media selesai" : "Kirim pesan (Enter)"}
                    >
                      <span>Kirim</span>
                      <Send size={14} />
                    </button>
                  )}
                </div>
              </div>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}
