import { useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import { api, queryClient } from "../lib/api";
import { ThemeToggle } from "../components/pickers";

export default function Login() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setErr("");
    try {
      await api("/auth/login", { method: "POST", json: { email, password } });
      await queryClient.invalidateQueries();
    } catch (e) {
      setErr((e as Error).message);
    }
    setBusy(false);
  };
  return (
    <div className="grid min-h-dvh place-items-center px-4 py-10">
      <div className="absolute right-4 top-4"><ThemeToggle /></div>
      <div className="w-full max-w-[380px]">
        <div className="mb-8 flex items-center justify-center gap-2.5">
          <svg width="32" height="32" viewBox="0 0 28 28" aria-hidden>
            <path d="M14 3c3 0 5 2.5 5 5.5S16 14 14 14 9 11.5 9 8.5 11 3 14 3Z" fill="#6366F1" /><path d="M25 14c0 3-2.5 5-5.5 5S14 16 14 14s2.5-5 5.5-5S25 11 25 14Z" fill="#EC4899" />
            <path d="M14 25c-3 0-5-2.5-5-5.5S12 14 14 14s5 2.5 5 5.5S17 25 14 25Z" fill="#8B5CF6" /><path d="M3 14c0-3 2.5-5 5.5-5S14 12 14 14s-2.5 5-5.5 5S3 17 3 14Z" fill="#3B82F6" />
          </svg>
          <span className="text-[22px] font-semibold tracking-tight">Iklan AI</span>
        </div>
        <form onSubmit={submit} className="card space-y-4 p-6">
          <div><h1 className="text-[20px] font-semibold">Masuk</h1><p className="text-[13px] text-muted">Dashboard iklan & laba rugi owner</p></div>
          <label className="block"><span className="label">Email</span><input className="input mt-1" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus /></label>
          <label className="block"><span className="label">Password</span>
            <span className="relative mt-1 block">
              <input className="input pr-11" type={show ? "text" : "password"} autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
              <button type="button" className="absolute right-1 top-1/2 grid size-9 -translate-y-1/2 place-items-center text-muted" onClick={() => setShow((s) => !s)} aria-label={show ? "Sembunyikan password" : "Tampilkan password"}>{show ? <EyeOff size={17} /> : <Eye size={17} />}</button>
            </span>
          </label>
          {err && <p className="rounded-lg bg-red-soft px-3 py-2 text-[13px] text-red-ink" role="alert">{err}</p>}
          <button className="btn btn-primary w-full" disabled={busy}>{busy ? "Memeriksa…" : "Masuk"}</button>
        </form>
      </div>
    </div>
  );
}
