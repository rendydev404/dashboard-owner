import { useEffect, useRef, useState } from "react";
import { Send, Bot, Zap, Check, Undo2, Square, Maximize2, Minimize2, X, RotateCcw, Sparkles, Paperclip, Film, AlertCircle } from "lucide-react";
import type { BotAction } from "@iklan/shared";
import { api, useBootstrap, actionsApi, refreshData, ApiError } from "../lib/api";
import { setView, useView } from "../lib/view";
import { actionSummary } from "../lib/campaign-action";
import { accLabel } from "../components/pickers";
import { toast, cx } from "../components/ui";
import { Markdown } from "./Markdown";
import { Widget } from "./Widgets";
import { LaunchPlan } from "./LaunchPlan";
import { useChat, send, greet, updateAction, resetChat, stopChat, type Msg, type SentFile } from "./store";
import { ACCEPT, fmtSize, precheck, uploadMedia, videoCover, type Pending } from "./media";

const CHIPS = ["Ringkasan performa minggu ini", "Rekomendasi kampanye", "Kampanye paling boros?", "Jam paling cuan?", "Produk terlaris bulan ini", "Laba rugi bulan lalu"];

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

const Typing = () => (
  <span className="inline-flex items-center gap-1 text-muted" aria-label="Bot sedang mengetik">
    <span className="size-1.5 animate-bounce rounded-full bg-current" /><span className="size-1.5 animate-bounce rounded-full bg-current [animation-delay:120ms]" /><span className="size-1.5 animate-bounce rounded-full bg-current [animation-delay:240ms]" />
  </span>
);

function BotMessage({ m, last, busy, page }: { m: Msg; last: boolean; busy: boolean; page: boolean }) {
  const empty = !m.parts.length && !m.action;
  return (
    <div className={cx("flex gap-2.5", page ? "max-w-full" : "max-w-[96%]")}>
      {page && <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-full bg-accent-soft text-accent"><Sparkles size={15} /></span>}
      <div className="min-w-0 flex-1 space-y-2">
        {m.ctx && <p className="text-[11px] font-semibold text-muted">{m.ctx}</p>}
        {m.parts.map((p, i) => p.type === "widget" ? <Widget key={i} w={p.widget} /> : p.text.trim() && (
          <div key={i} className={cx("rounded-2xl px-3.5 py-2.5 text-[13.5px] leading-relaxed", m.error ? "bg-red-soft text-red-ink" : page ? "bg-transparent px-0" : "rounded-bl-md bg-bg")}>
            <Markdown text={p.text} />
          </div>
        ))}
        {(empty || (last && busy && m.parts[m.parts.length - 1]?.type === "widget")) && <div className={cx("rounded-2xl px-3.5 py-3", page ? "px-0" : "bg-bg")}><Typing /></div>}
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
          <span className="grid size-9 shrink-0 place-items-center rounded-full bg-accent text-accent-ink"><Bot size={18} /></span>
          <div className="min-w-0 leading-tight">
            <p className="font-semibold">Bot Iklan</p>
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
        {msgs.map((m, i) => m.role === "user"
          ? <div key={m.id} className="ml-auto flex w-fit max-w-[85%] flex-col items-end gap-1.5">
              {m.files?.length ? <div className="flex flex-wrap justify-end gap-1.5">{m.files.map((f) => <FileThumb key={f.id} {...f} />)}</div> : null}
              <div className="whitespace-pre-wrap rounded-2xl rounded-br-md bg-accent px-3.5 py-2.5 text-[13.5px] text-accent-ink">{m.parts[0]?.type === "text" ? m.parts[0].text : ""}</div>
            </div>
          : <BotMessage key={m.id} m={m} last={i === msgs.length - 1} busy={busy} page={page} />)}
        {fresh && page && (
          <div className="grid gap-2 pt-2 sm:grid-cols-2">
            {CHIPS.map((c) => (
              <button key={c} onClick={() => submit(c)} className="rounded-xl border border-line bg-card px-3.5 py-3 text-left text-[13px] font-medium hover:border-accent hover:text-accent">{c}</button>
            ))}
          </div>
        )}
      </div>

      {!(fresh && page) && (
        <div className={cx("flex gap-2 overflow-x-auto pb-2 scrollbar-none", page ? "px-1" : "px-4")}>
          {CHIPS.map((c) => <button key={c} onClick={() => submit(c)} disabled={busy} className="shrink-0 rounded-full border border-line px-3 py-1.5 text-[12px] font-medium hover:border-accent hover:text-accent disabled:opacity-50">{c}</button>)}
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
      <form className={cx("flex items-end gap-2 border-t border-line py-3", page ? "px-1 pb-4" : "px-4 pb-[max(12px,env(safe-area-inset-bottom))]", pending.length > 0 && "border-t-0")} onSubmit={(e) => { e.preventDefault(); submit(input); }}>
        {owner && (
          <>
            <input ref={fileInput} type="file" accept={ACCEPT} multiple hidden onChange={(e) => { addFiles(e.target.files); e.target.value = ""; }} />
            <button type="button" className="btn size-[42px] shrink-0 p-0" onClick={() => fileInput.current?.click()} disabled={busy || pending.length >= 4}
              title="Lampirkan foto/video untuk iklan (JPG/PNG maks. 30 MB, MP4/MOV maks. 100 MB)" aria-label="Lampirkan foto atau video"><Paperclip size={17} /></button>
          </>
        )}
        <textarea ref={ta} rows={1} className="input max-h-40 min-h-[42px] resize-none py-2.5 leading-snug" placeholder={ready.length ? "Jelaskan iklannya: akun, tujuan, budget/hari…" : "Tanya apa saja soal iklan & penjualan…  (Shift+Enter untuk baris baru)"}
          value={input} onChange={(e) => setInput(e.target.value)} maxLength={2000} aria-label="Pesan untuk bot"
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); submit(input); } }} />
        {busy
          ? <button type="button" onClick={stopChat} className="btn size-[42px] shrink-0 p-0" aria-label="Hentikan jawaban" title="Hentikan"><Square size={15} /></button>
          : <button className="btn btn-primary size-[42px] shrink-0 p-0" disabled={(!input.trim() && !ready.length) || uploading} aria-label="Kirim"
              title={uploading ? "Tunggu upload selesai" : undefined}><Send size={17} /></button>}
      </form>
    </div>
  );
}
