import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Wink · Mensajes",
  description: "Bandeja de entrada de WhatsApp de Wink Group",
  robots: { index: false, follow: false },
  applicationName: "Wink",
  icons: {
    icon: [{ url: "/favicon.ico" }, { url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" }],
    apple: [{ url: "/icons/apple-touch-icon.png", sizes: "180x180" }],
  },
  // iOS: pantalla completa al abrir desde el icono de inicio
  appleWebApp: { capable: true, title: "Wink", statusBarStyle: "default" },
  formatDetection: { telephone: false },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#f6f3ee",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es">
      <body>{children}</body>
    </html>
  );
}
