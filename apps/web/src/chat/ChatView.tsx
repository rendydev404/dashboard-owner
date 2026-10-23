import { useEffect, useRef, useState } from "react";
import { Send, Zap, Check, Undo2, Square, Maximize2, Minimize2, X, RotateCcw, Paperclip, Film, AlertCircle, BarChart3, Lightbulb, Flame, Clock3, Trophy, Wallet } from "lucide-react";
import type { BotAction } from "@iklan/shared";
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

const CHIPS = [
  ["Ringkasan performa minggu ini", BarChart3], ["Rekomendasi kampanye", Lightbulb], ["Kampanye paling boros?", Flame],
  ["Jam paling cuan?", Clock3], ["Produk terlaris bulan ini", Trophy], ["Laba rugi bulan lalu", Wallet],
] as const;
// Tahap yang tampil selama bot bekerja. Backend belum mengirim status per tahap, jadi bergilir tiap 2 detik dan berhenti di tahap terakhir.
const STEPS = ["Membaca data iklan", "Menghitung CPA & ROAS", "Membandingkan kampanye", "Menyusun jawaban"];
const WIDGET_STEPS = ["Menyiapkan grafik", "Merangkum temuan"];
const TIPS = [
  "Coba tanya: “kampanye mana yang paling boros minggu ini?”",
  "Lampirkan foto/video, nanti gw bikinin draft iklannya.",
  "Bilang “pindah ke akun lain” atau “30 hari”, dashboard ikut pindah.",
  "Pause atau scale kampanye juga bisa, tapi gw selalu minta konfirmasi dulu.",
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
    <div className="rounded-xl border border-line bg-card p-3 text-[13px]">
      <p className="flex items-center gap-1.5 font-semibold"><Zap size={14} className="text-accent" /> {s.title.replace("?", "")}</p>
      <p className="mt-1 font-medium">{action.campaignName ?? (p.plan?.campaignName as string | undefined)}</p>
      {action.action === "launch" ? <LaunchPlan action={action} /> : (
        <>
          <p className="text-[12px] text-muted">{action.accountName}</p>
          <p className="mt-1.5 whitespace-pre-line rounded-lg bg-bg px-2.5 py-1.5 text-[12.5px]">{s.detail}</p>
        </>
      )}
      {p.demo && <p className="mt-1 text-[11.5px] text-muted">Mode demo: hanya tersimpan di dashboard.</p>}
      {action.status === "pending" && !expired ? (
        <div className="mt-2.5 flex gap-2">
          <button className="btn btn-primary h-9 min-h-0 flex-1" disabled={busy} onClick={() => run("confirm")}>{busy && action.action === "launch" ? "Membuat iklan…" : "Ya, eksekusi"}</button>
          <button className="btn h-9 min-h-0" disabled={busy} onClick={() => run("cancel")}>Batal</button>
        </div>
      ) : (
        <div className="mt-2 flex items-center justify-between gap-2 text-[12px]">
          <span className={cx("font-semibold", action.status === "executed" ? "text-green-ink" : action.status === "failed" ? "text-red-ink" : "text-muted")}>
            {action.status === "executed" ? <span className="inline-flex items-center gap-1"><Check size={13} /> Dieksekusi</span>
              : action.status === "failed" ? `Gagal: ${action.error}` : expired ? "Kedaluwarsa" : action.status === "reverted" ? "Dibalikkan" : "Dibatalkan"}
          </span>
          {action.status === "executed" && !p.demo && <button className="inline-flex items-center gap-1 font-semibold text-accent" disabled={busy} onClick={() => run("revert")}><Undo2 size={13} /> {action.action === "launch" ? "Pause kampanye ini" : "Batalkan aksi"}</button>}
        </div>
      )}
    </div>
  );
}

/** Kotak kecil foto/video: pratinjau lokal, nama, ukuran, dan progres upload kalau masih jalan. */
function FileThumb({ kind, preview, name, size, progress, error, onRemove }: {
  kind: "image" | "video"; preview: string; name: string; size: number; progress?: number; error?: string; onRemove?: () => void;
}) {
  const uploading = progress != null && progress < 100 && !error;
  return (
    <div className={cx("relative flex w-[200px] items-center gap-2 rounded-xl border bg-card p-1.5 text-left text-ink", error ? "border-red" : "border-line")}>
      <div className="relative size-11 shrink-0 overflow-hidden rounded-lg bg-bg">
        {kind === "image" ? <img src={preview} alt="" className="size-full object-cover" />
          : <><video src={preview} muted preload="metadata" className="size-full object-cover" /><Film size={14} className="absolute bottom-0.5 right-0.5 text-white drop-shadow" /></>}
      </div>
      <div className="min-w-0 flex-1 leading-tight">
        <p className="truncate text-[12px] font-medium">{name}</p>
        <p className={cx("text-[11px]", error ? "text-red-ink" : "text-muted")}>{error ?? (uploading ? `Mengupload ${progress}%` : fmtSize(size))}</p>
        {uploading && <div className="mt-1 h-1 rounded-full bg-bg"><div className="h-1 rounded-full bg-accent transition-[width]" style={{ width: `${progress}%` }} /></div>}
      </div>
      {onRemove && <button type="button" onClick={onRemove} className="absolute -right-1.5 -top-1.5 grid size-5 place-items-center rounded-full bg-ink text-bg" aria-label={`Hapus ${name}`}><X size={12} /></button>}
    </div>
  );
}

function Working({ steps, bot }: { steps: string[]; bot?: boolean }) {
  const [t, setT] = useState(0);
  useEffect(() => { const id = setInterval(() => setT((x) => x + 1), 1000); return () => clearInterval(id); }, []);
  const i = Math.min(steps.length - 1, Math.floor(t / 2));
  return (
    <div className="flex items-center gap-3" role="status">
      {bot && <AdBot size={34} head mood="think" />}
      <div className="w-full max-w-[240px] space-y-2">
        <p className="text-[12.5px] font-medium leading-none">
          <span key={i} className="ab-step ab-status">{steps[i]}…</span>
          {t >= 5 && <span className="num ml-1.5 text-[11px] font-normal text-muted-2">{t} dtk</span>}
        </p>
        <div className="ab-bar" />
      </div>
    </div>
  );
}

/** Layar sambutan: maskot bisa diklik (melambai + tips bergilir), lalu pilihan pertanyaan cepat. */
function Hero({ page, greeting, ctx, onPick }: { page: boolean; greeting: string; ctx: string; onPick: (q: string) => void }) {
  const [tip, setTip] = useState(-1);
  const [wave, setWave] = useState(1);
  const poke = () => { setTip((t) => (t + 1) % TIPS.length); setWave((w) => w + 1); };
  return (
    <div className={cx("flex flex-col items-center", page ? "pt-6" : "pt-2")}>
      <div className="flex items-start gap-2">
        <button type="button" onClick={poke} className="shrink-0 rounded-full" title="Klik aku!" aria-label="Sapa bot, tampilkan tips">
          <AdBot size={page ? 112 : 84} track wave={wave} />
        </button>
        <p key={tip} className="ab-speech mt-3 max-w-[310px] rounded-2xl border border-line bg-card px-3.5 py-2.5 text-[13px] leading-relaxed shadow-card">
          {tip < 0 ? greeting : TIPS[tip]}
        </p>
      </div>
      <h2 className={cx("mt-4 text-center font-semibold tracking-tight", page ? "text-[21px]" : "text-[17px]")}>Mau bahas iklan apa hari ini?</h2>
      <p className="mt-0.5 text-center text-[12px] text-muted">Membaca data {ctx}</p>
      <div className={cx("mt-4 grid w-full gap-2", page ? "sm:grid-cols-3" : "grid-cols-2")}>
        {CHIPS.map(([c, Icon], i) => (
          <button key={c} onClick={() => onPick(c)} style={{ animationDelay: `${i * 40}ms` }}
            className="pop-in group flex items-center gap-2.5 rounded-xl border border-line bg-card px-3 py-2.5 text-left text-[12.5px] font-medium transition-[border-color,translate] hover:-translate-y-0.5 hover:border-accent">
            <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-accent-soft text-accent transition-transform group-hover:scale-110"><Icon size={14} /></span>
            <span className="leading-snug">{c}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function BotMessage({ m, last, busy, page }: { m: Msg; last: boolean; busy: boolean; page: boolean }) {
  const empty = !m.parts.length && !m.action;
  const widgetPending = last && busy && m.parts[m.parts.length - 1]?.type === "widget";
  const mood: BotMood = m.error ? "sad" : empty || widgetPending ? "think" : last && busy ? "talk" : "idle";
  return (
    <div className={cx("pop-in flex gap-2.5", page ? "max-w-full" : "max-w-[96%]")}>
      {page && <AdBot size={34} head mood={mood} className={cx("mt-0.5", !last && "ab-still")} />}
      <div className="min-w-0 flex-1 space-y-2">
        {m.ctx && <p className="text-[11px] font-semibold text-muted">{m.ctx}</p>}
        {m.parts.map((p, i) => p.type === "widget" ? <Widget key={i} w={p.widget} /> : p.type === "video" ? <VideoCard key={i} runId={p.runId} /> : p.text.trim() && (
          <div key={i} className={cx("rounded-2xl px-3.5 py-2.5 text-[13.5px] leading-relaxed", m.error ? "bg-red-soft text-red-ink" : page ? "bg-transparent px-0" : "rounded-bl-md bg-bg")}>
            <Markdown text={p.text} />
          </div>
        ))}
        {(empty || widgetPending) && <div className={cx("rounded-2xl py-2.5", page ? "px-0 pt-2" : "w-fit min-w-[230px] rounded-bl-md bg-bg px-3")}><Working bot={!page} steps={empty ? STEPS : WIDGET_STEPS} /></div>}
        {m.action && <ActionCard action={m.action} />}
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

  useEffect(() => { greet(); setTimeout(() => ta.current?.focus(), 50); }, []);
  useEffect(() => { body.current?.scrollTo({ top: body.current.scrollHeight, behavior: "smooth" }); }, [msgs]);
  useEffect(() => { const el = ta.current; if (el) { el.style.height = "auto"; el.style.height = Math.min(el.scrollHeight, 160) + "px"; } }, [input]);

  const [pending, setPending] = useState<Pending[]>([]);
  const fileInput = useRef<HTMLInputElement>(null);
  const uploading = pending.some((p) => !p.att && !p.error);
  const ready = pending.filter((p) => p.att);
  const upd = (key: string, f: (p: Pending) => Pending) => setPending((ps) => ps.map((p) => (p.key === key ? f(p) : p)));

  const addFiles = (list: FileList | null) => {
    for (const file of Array.from(list ?? []).slice(0, 4 - pending.length)) {
      const key = crypto.randomUUID(), preview = URL.createObjectURL(file), bad = precheck(file);
      setPending((ps) => [...ps, { key, file, preview, progress: 0, error: bad ?? undefined }]);
      if (bad) continue;
      const cover = file.type.startsWith("video/") ? videoCover(file) : null; // diambil paralel dengan upload video
      uploadMedia(file, (pct) => upd(key, (p) => ({ ...p, progress: Math.min(pct, 99) })), (xhr) => upd(key, (p) => ({ ...p, xhr })))
        .then(async (att) => {
          // Lampiran baru dianggap siap setelah cover (kalau ada) ikut terupload; gagal cover tidak menggagalkan video.
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
    pending.filter((p) => !p.att).forEach((p) => URL.revokeObjectURL(p.preview)); // yang gagal dibuang
    setPending([]);
    setInput("");
    void send(t, boot.accounts, owner, files);
  };
  const status = boot.integration.aiConfigured ? "Claude · terhubung" : "Mode aturan · AI belum aktif";

  return (
    <div className={cx("flex min-h-0 flex-1 flex-col", page && "mx-auto w-full max-w-[860px]")}>
      <div className={cx("flex items-center justify-between gap-3 px-4 py-3", page ? "border-b border-line px-1 pt-0" : "border-b border-line pt-[max(12px,env(safe-area-inset-top))]")}>
        <div className="flex min-w-0 items-center gap-3">
          <span className="grid size-10 shrink-0 place-items-center rounded-full bg-accent-soft"><AdBot size={34} head mood={mood} /></span>
          <div className="min-w-0 leading-tight">
            <p className="font-semibold">Bot Iklan{busy && <span className="ml-2 text-[11.5px] font-medium text-accent">{mood === "talk" ? "menulis…" : "berpikir…"}</span>}</p>
            <p className="truncate text-[11.5px] text-muted"><span className={cx("mr-1 inline-block size-1.5 rounded-full align-middle", boot.integration.aiConfigured ? "bg-green" : "bg-muted")} />{status} · {accLabel(view.acc, boot.accounts)}</p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button className="btn btn-ghost size-9 p-0" onClick={resetChat} title="Percakapan baru" aria-label="Percakapan baru"><RotateCcw size={16} /></button>
          {page
            ? <button className="btn btn-ghost size-9 p-0" onClick={() => setView({ tab: "ringkasan" })} title="Kecilkan" aria-label="Keluar dari layar penuh"><Minimize2 size={16} /></button>
            : <button className="btn btn-ghost hidden size-9 p-0 md:inline-flex" onClick={() => { onClose?.(); setView({ tab: "chat" }); }} title="Layar penuh" aria-label="Buka chat layar penuh"><Maximize2 size={16} /></button>}
          {onClose && <button className="btn btn-ghost size-9 p-0" onClick={onClose} aria-label="Tutup chat"><X size={18} /></button>}
        </div>
      </div>

      <div ref={body} className={cx("flex-1 space-y-4 overflow-y-auto py-4", page ? "px-1" : "px-4")} aria-live="polite">
        {fresh ? <Hero page={page} greeting={msgs[0] ? textOf(msgs[0]) : ""} ctx={accLabel(view.acc, boot.accounts)} onPick={submit} /> : msgs.map((m, i) => m.role === "user"
          ? <div key={m.id} className="ml-auto flex w-fit max-w-[85%] flex-col items-end gap-1.5">
              {m.files?.length ? <div className="flex flex-wrap justify-end gap-1.5">{m.files.map((f) => <FileThumb key={f.id} {...f} />)}</div> : null}
              <div className="pop-in whitespace-pre-wrap rounded-2xl rounded-br-md bg-accent px-3.5 py-2.5 text-[13.5px] text-accent-ink">{m.parts[0]?.type === "text" ? m.parts[0].text : ""}</div>
            </div>
          : <BotMessage key={m.id} m={m} last={i === msgs.length - 1} busy={busy} page={page} />)}
      </div>

      {!fresh && (
        <div className={cx("flex gap-2 overflow-x-auto pb-2 scrollbar-none", page ? "px-1" : "px-4")}>
          {CHIPS.map(([c]) => <button key={c} onClick={() => submit(c)} disabled={busy} className="shrink-0 rounded-full border border-line px-3 py-1.5 text-[12px] font-medium hover:border-accent hover:text-accent disabled:opacity-50">{c}</button>)}
        </div>
      )}
      {pending.length > 0 && (
        <div className={cx("flex flex-wrap gap-2 border-t border-line pt-3", page ? "px-1" : "px-4")}>
          {pending.map((p) => (
            <FileThumb key={p.key} kind={p.file.type.startsWith("video/") ? "video" : "image"} preview={p.preview} name={p.file.name} size={p.file.size}
              progress={p.att ? undefined : p.progress} error={p.error} onRemove={() => removePending(p)} />
          ))}
          {pending.some((p) => p.error) && <p className="flex w-full items-center gap-1 text-[11.5px] text-red-ink"><AlertCircle size={13} /> Lampiran yang gagal tidak ikut terkirim.</p>}
        </div>
      )}
      <form className={cx("py-3", page ? "px-1 pb-4" : "px-4 pb-[max(12px,env(safe-area-inset-bottom))]")} onSubmit={(e) => { e.preventDefault(); submit(input); }}>
       <div className="ab-composer flex items-end gap-1 rounded-2xl p-1.5">
        {owner && (
          <>
            <input ref={fileInput} type="file" accept={ACCEPT} multiple hidden onChange={(e) => { addFiles(e.target.files); e.target.value = ""; }} />
            <button type="button" className="btn btn-ghost size-10 min-h-0 shrink-0 rounded-xl p-0 text-muted hover:text-ink" onClick={() => fileInput.current?.click()} disabled={busy || pending.length >= 4}
              title="Lampirkan foto/video untuk iklan (JPG/PNG maks. 30 MB, MP4/MOV maks. 100 MB)" aria-label="Lampirkan foto atau video"><Paperclip size={17} /></button>
          </>
        )}
        <textarea ref={ta} rows={1} className={cx("max-h-40 min-h-10 flex-1 resize-none bg-transparent py-2.5 leading-snug outline-none placeholder:text-muted-2 focus-visible:outline-none", owner ? "px-1" : "px-2.5")} placeholder={ready.length ? "Jelaskan iklannya: akun, tujuan, budget/hari…" : page ? "Tanya apa saja soal iklan & penjualan…  (Shift+Enter untuk baris baru)" : "Tanya soal iklan & penjualan…"}
          value={input} onChange={(e) => setInput(e.target.value)} maxLength={2000} aria-label="Pesan untuk bot"
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); submit(input); } }} />
        {busy
          ? <button type="button" onClick={stopChat} className="btn size-10 min-h-0 shrink-0 rounded-xl p-0" aria-label="Hentikan jawaban" title="Hentikan"><Square size={14} className="fill-current" /></button>
          : <button className="btn btn-primary size-10 min-h-0 shrink-0 rounded-xl p-0 transition-transform active:scale-90" disabled={(!input.trim() && !ready.length) || uploading} aria-label="Kirim"
              title={uploading ? "Tunggu upload selesai" : undefined}><Send size={16} /></button>}
       </div>
      </form>
    </div>
  );
}
