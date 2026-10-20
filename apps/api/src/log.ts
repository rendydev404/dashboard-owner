// Log JSON satu baris per event (dibaca Coolify/Docker).
type Level = "info" | "warn" | "error";
function write(level: Level, msg: string, extra?: Record<string, unknown>) {
  const line = JSON.stringify({ t: new Date().toISOString(), level, msg, ...extra });
  (level === "error" ? console.error : console.log)(line);
}
export const log = {
  info: (msg: string, extra?: Record<string, unknown>) => write("info", msg, extra),
  warn: (msg: string, extra?: Record<string, unknown>) => write("warn", msg, extra),
  error: (msg: string, extra?: Record<string, unknown>) => write("error", msg, extra),
};
export const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
