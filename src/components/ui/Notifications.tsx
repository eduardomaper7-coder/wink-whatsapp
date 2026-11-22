"use client";
import { Bell, BellOff, BellRing, X } from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useState } from "react";

export type PushState = "loading" | "unsupported" | "ios-install" | "default" | "denied" | "subscribed" | "not-configured";

interface Ctx {
  state: PushState;
  busy: boolean;
  message: string | null;
  enable: () => Promise<void>;
  disable: () => Promise<void>;
  test: () => Promise<void>;
}
const NotificationsContext = createContext<Ctx | null>(null);
export const useNotifications = () => useContext(NotificationsContext)!;

const VAPID = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ?? "";

function keyToBytes(base64: string): Uint8Array<ArrayBuffer> {
  const pad = "=".repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const isStandalone = () => window.matchMedia("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;

async function saveSubscription(sub: PushSubscription) {
  const res = await fetch("/api/push/subscribe", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(sub.toJSON()) });
  if (!res.ok) throw new Error("No se pudo guardar la suscripción");
}

export function NotificationsProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<PushState>("loading");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [reg, setReg] = useState<ServiceWorkerRegistration | null>(null);

  // Registro del service worker y estado inicial
  useEffect(() => {
    if (!("serviceWorker" in navigator)) {
      setState("unsupported");
      return;
    }
    navigator.serviceWorker
      .register("/sw.js", { scope: "/" })
      .then(async (r) => {
        setReg(r);
        if (!("PushManager" in window) || !("Notification" in window)) {
          setState(isIOS() && !isStandalone() ? "ios-install" : "unsupported");
          return;
        }
        if (!VAPID) return setState("not-configured");
        if (Notification.permission === "denied") return setState("denied");
        const existing = await r.pushManager.getSubscription();
        if (existing && Notification.permission === "granted") {
          await saveSubscription(existing).catch(() => {});
          setState("subscribed");
        } else setState("default");
      })
      .catch(() => setState("unsupported"));
  }, []);

  const enable = useCallback(async () => {
    if (!reg) return;
    setBusy(true);
    setMessage(null);
    try {
      const perm = await Notification.requestPermission();
      if (perm !== "granted") {
        setState(perm === "denied" ? "denied" : "default");
        return;
      }
      const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyToBytes(VAPID) }));
      await saveSubscription(sub);
      setState("subscribed");
      await fetch("/api/push/test", { method: "POST" });
      setMessage("Listo: te hemos enviado una notificación de prueba.");
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "No se pudieron activar las notificaciones");
    } finally {
      setBusy(false);
    }
  }, [reg]);

  const disable = useCallback(async () => {
    if (!reg) return;
    setBusy(true);
    const sub = await reg.pushManager.getSubscription();
    if (sub) {
      await fetch("/api/push/subscribe", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ endpoint: sub.endpoint }) });
      await sub.unsubscribe();
    }
    setState("default");
    setBusy(false);
    setMessage("Notificaciones desactivadas en este dispositivo.");
  }, [reg]);

  const test = useCallback(async () => {
    setBusy(true);
    const r = await fetch("/api/push/test", { method: "POST" });
    setBusy(false);
    setMessage(r.ok ? "Notificación de prueba enviada." : "No se pudo enviar la prueba.");
  }, []);

  return <NotificationsContext.Provider value={{ state, busy, message, enable, disable, test }}>{children}</NotificationsContext.Provider>;
}

/** Texto y acciones según el estado (lo usan el panel y el aviso de la lista). */
export function NotificationsPanel({ onClose }: { onClose?: () => void }) {
  const { state, busy, message, enable, disable, test } = useNotifications();
  return (
    <div className="notif-panel" role="dialog" aria-label="Notificaciones">
      <div className="row" style={{ marginBottom: 6 }}>
        <b className="grow">Notificaciones</b>
        {onClose && (
          <button className="btn btn-ghost btn-icon btn-sm" onClick={onClose} aria-label="Cerrar">
            <X size={16} />
          </button>
        )}
      </div>
      {state === "subscribed" && (
        <>
          <p className="small muted">Activadas en este dispositivo. Te avisaremos cuando un cliente escriba en una conversación tuya o el asistente pase una al equipo.</p>
          <div className="row">
            <button className="btn btn-sm" onClick={() => void test()} disabled={busy}>
              Enviar prueba
            </button>
            <button className="btn btn-sm btn-ghost" onClick={() => void disable()} disabled={busy}>
              Desactivar
            </button>
          </div>
        </>
      )}
      {state === "default" && (
        <>
          <p className="small muted">Recibe un aviso cuando un cliente necesite a alguien del equipo, aunque tengas la app cerrada.</p>
          <button className="btn btn-primary btn-sm" onClick={() => void enable()} disabled={busy}>
            {busy ? "Activando…" : "Activar notificaciones"}
          </button>
        </>
      )}
      {state === "ios-install" && (
        <p className="small muted">
          En iPhone, las notificaciones funcionan con la app instalada: pulsa <b>Compartir</b> → <b>Añadir a pantalla de inicio</b>, abre Wink desde el icono y actívalas aquí.
        </p>
      )}
      {state === "denied" && <p className="small muted">Las notificaciones están bloqueadas para esta web. Permítelas en los ajustes del navegador y vuelve a intentarlo.</p>}
      {state === "unsupported" && <p className="small muted">Este navegador no admite notificaciones push.</p>}
      {state === "not-configured" && <p className="small muted">Falta configurar las claves de notificaciones en el servidor (VAPID).</p>}
      {state === "loading" && <p className="small muted">Comprobando…</p>}
      {message && (
        <p className="small" style={{ margin: "8px 0 0" }} role="status">
          {message}
        </p>
      )}
    </div>
  );
}

export function NotificationsButton({ variant = "rail" }: { variant?: "rail" | "tab" }) {
  const { state } = useNotifications();
  const [open, setOpen] = useState(false);
  const Icon = state === "subscribed" ? BellRing : state === "denied" || state === "unsupported" ? BellOff : Bell;
  return (
    <div style={{ position: "relative", display: variant === "tab" ? "contents" : undefined }}>
      <button onClick={() => setOpen((v) => !v)} title="Notificaciones" aria-expanded={open} className={state === "default" ? "notif-attention" : undefined}>
        <Icon size={variant === "tab" ? 20 : 19} />
        {variant === "tab" && "Avisos"}
      </button>
      {open && (
        <div className={`notif-pop notif-pop--${variant}`}>
          <NotificationsPanel onClose={() => setOpen(false)} />
        </div>
      )}
    </div>
  );
}

/** Aviso discreto en la lista de conversaciones mientras no estén activadas. */
export function NotificationsBanner() {
  const { state, busy, enable } = useNotifications();
  const [hidden, setHidden] = useState(true);
  useEffect(() => {
    try {
      setHidden(localStorage.getItem("wink:notif-banner") === "off");
    } catch {
      setHidden(false);
    }
  }, []);
  if (hidden || (state !== "default" && state !== "ios-install")) return null;
  const dismiss = () => {
    setHidden(true);
    try {
      localStorage.setItem("wink:notif-banner", "off");
    } catch {}
  };
  return (
    <div className="notif-banner">
      <Bell size={16} style={{ flex: "none", marginTop: 2 }} />
      <span className="grow small">
        {state === "ios-install" ? "Instala Wink en la pantalla de inicio (Compartir → Añadir a pantalla de inicio) para recibir avisos." : "Activa los avisos para enterarte cuando un cliente necesite al equipo."}
      </span>
      {state === "default" && (
        <button className="btn btn-primary btn-sm" onClick={() => void enable()} disabled={busy}>
          Activar
        </button>
      )}
      <button className="btn btn-ghost btn-icon btn-sm" onClick={dismiss} aria-label="Ocultar aviso">
        <X size={15} />
      </button>
    </div>
  );
}
