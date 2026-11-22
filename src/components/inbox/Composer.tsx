"use client";
import { Bot, FileText, Paperclip, Send, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/browser";
import { api } from "./hooks";
import { windowLevel, windowText } from "./format";
import { TemplatePicker } from "./TemplatePicker";
import type { ConversationItem } from "./types";

const IMAGE_MIMES = ["image/jpeg", "image/png"];
const MAX_IMAGE = 5 * 1024 * 1024;
const MAX_DOC = 100 * 1024 * 1024;

export function Composer({ conv, onSent, toast }: { conv: ConversationItem; onSent: () => void; toast: (m: string) => void }) {
  const [text, setText] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [sending, setSending] = useState(false);
  const [showTemplates, setShowTemplates] = useState(false);
  const ta = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const win = windowLevel(conv.last_inbound_at);

  useEffect(() => {
    setText("");
    setFile(null);
  }, [conv.id]);

  // Autoajuste de altura del cuadro de texto
  useEffect(() => {
    if (!ta.current) return;
    ta.current.style.height = "auto";
    ta.current.style.height = `${Math.min(ta.current.scrollHeight, 140)}px`;
  }, [text]);

  function pickFile(f: File | undefined) {
    if (!f) return;
    const isImage = IMAGE_MIMES.includes(f.type);
    if (isImage && f.size > MAX_IMAGE) return toast("Las imágenes pueden ocupar como máximo 5 MB.");
    if (!isImage && f.size > MAX_DOC) return toast("Los documentos pueden ocupar como máximo 100 MB.");
    setFile(f);
  }

  async function send() {
    if (sending || (!text.trim() && !file)) return;
    setSending(true);
    const clientRef = crypto.randomUUID();
    try {
      let content: Record<string, unknown>;
      if (file) {
        const safe = file.name.normalize("NFD").replace(/[^\w.-]+/g, "_").slice(-80);
        const path = `outbound/${conv.id}/${clientRef}-${safe}`;
        const { error } = await supabaseBrowser().storage.from("whatsapp-media").upload(path, file, { contentType: file.type || "application/octet-stream" });
        if (error) throw new Error(`No se pudo subir el archivo: ${error.message}`);
        content = IMAGE_MIMES.includes(file.type)
          ? { type: "image", media: { storagePath: path }, ...(text.trim() ? { caption: text.trim() } : {}) }
          : { type: "document", media: { storagePath: path }, filename: file.name, ...(text.trim() ? { caption: text.trim() } : {}) };
      } else {
        content = { type: "text", body: text };
      }
      const res = await api<{ message?: unknown; templates?: unknown[] }>(`/api/conversations/${conv.id}/messages`, { body: { content, clientRef } });
      if (res.status === 409 && res.data.code === "window_closed") {
        toast("La ventana de 24 h está cerrada: envía una plantilla.");
        setShowTemplates(true);
        return;
      }
      if (!res.ok && res.status !== 422) throw new Error(res.data.error ?? "No se pudo enviar");
      setText("");
      setFile(null);
      onSent();
    } catch (e) {
      toast(e instanceof Error ? e.message : "No se pudo enviar");
    } finally {
      setSending(false);
      ta.current?.focus();
    }
  }

  if (win.level === "closed") {
    return (
      <>
        <div className="window-bar closed">
          <span className="grow">Han pasado más de 24 h desde el último mensaje del cliente. Solo puedes enviar una plantilla aprobada.</span>
          <button className="btn btn-primary btn-sm" onClick={() => setShowTemplates(true)}>
            <FileText size={15} /> Enviar plantilla
          </button>
        </div>
        {showTemplates && <TemplatePicker conversationId={conv.id} onClose={() => setShowTemplates(false)} onSent={onSent} toast={toast} />}
      </>
    );
  }

  return (
    <>
      {conv.agent_active && conv.status === "bot" ? (
        <div className="window-bar agent">
          <Bot size={15} style={{ flex: "none" }} /> <span className="grow">El asistente está atendiendo. Si escribes, se pausará.</span>
          <span className="xs muted win-time">{windowText(conv.last_inbound_at)}</span>
        </div>
      ) : win.level === "soon" ? (
        <div className="window-bar soon">
          <span className="grow">{windowText(conv.last_inbound_at)}. Después solo podrás enviar plantillas.</span>
        </div>
      ) : null}
      {file && (
        <div className="attach-preview">
          <FileText size={18} />
          <span className="grow ellipsis">{file.name}</span>
          <span className="xs muted">{(file.size / 1024 / 1024).toFixed(1)} MB</span>
          <button className="btn btn-ghost btn-icon btn-sm" onClick={() => setFile(null)} aria-label="Quitar adjunto">
            <X size={16} />
          </button>
        </div>
      )}
      <div className="composer">
        <input ref={fileInput} type="file" hidden accept="image/jpeg,image/png,application/pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt" onChange={(e) => pickFile(e.target.files?.[0])} />
        <button className="btn btn-ghost btn-icon" onClick={() => fileInput.current?.click()} aria-label="Adjuntar archivo" title="Adjuntar imagen o documento">
          <Paperclip size={19} />
        </button>
        <textarea
          ref={ta}
          rows={1}
          placeholder={file ? "Añade un comentario (opcional)" : "Escribe un mensaje"}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !("ontouchstart" in window)) {
              e.preventDefault();
              void send();
            }
          }}
          aria-label="Mensaje"
        />
        <button className="btn btn-ghost btn-icon" onClick={() => setShowTemplates(true)} aria-label="Plantillas" title="Enviar plantilla">
          <FileText size={19} />
        </button>
        <button className="send" onClick={() => void send()} disabled={sending || (!text.trim() && !file)} aria-label="Enviar">
          <Send size={18} />
        </button>
      </div>
      {showTemplates && <TemplatePicker conversationId={conv.id} onClose={() => setShowTemplates(false)} onSent={onSent} toast={toast} />}
    </>
  );
}
