import QRCode from "qrcode";
import { LivePanel } from "@/components/live/LivePanel";

export const metadata = { title: "Wink · En directo" };

/**
 * Pantalla para proyectar en la demo. El QR abre WhatsApp con el número de Wink
 * (NEXT_PUBLIC_DEMO_WA_NUMBER, solo dígitos con prefijo, p. ej. 34910000000).
 */
export default async function LivePage() {
  const number = (process.env.NEXT_PUBLIC_DEMO_WA_NUMBER ?? "").replace(/\D/g, "");
  const link = number ? `https://wa.me/${number}?text=${encodeURIComponent("Hola, quiero información para reformar mi casa")}` : null;
  const qr = link ? await QRCode.toString(link, { type: "svg", margin: 0, color: { dark: "#141413", light: "#00000000" } }) : null;
  return <LivePanel qrSvg={qr} waNumber={number || null} />;
}
