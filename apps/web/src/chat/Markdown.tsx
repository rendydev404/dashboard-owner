import { memo, useMemo } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";

marked.setOptions({ gfm: true, breaks: true });

// Semua link dari bot dibuka di tab baru tanpa akses ke window dashboard.
DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A") { node.setAttribute("target", "_blank"); node.setAttribute("rel", "noopener noreferrer"); }
});

/** Markdown (GFM: judul, daftar, tabel, kode) dari bot, disanitasi sebelum dirender. Aman untuk teks yang masih streaming. */
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  const html = useMemo(() => DOMPurify.sanitize(marked.parse(text, { async: false }) as string, { USE_PROFILES: { html: true } }), [text]);
  return <div className="md-chat" dangerouslySetInnerHTML={{ __html: html }} />;
});
