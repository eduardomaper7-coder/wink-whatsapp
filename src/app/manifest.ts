import type { MetadataRoute } from "next";

/** Manifest de la PWA: instalable en Android, iOS y escritorio. */
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/inbox",
    name: "Wink · Mensajes",
    short_name: "Wink",
    description: "Bandeja de WhatsApp del equipo de Wink",
    start_url: "/inbox",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#f6f3ee",
    theme_color: "#f6f3ee",
    lang: "es-ES",
    categories: ["business", "productivity"],
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
    shortcuts: [{ name: "Conversaciones con el equipo", url: "/inbox", icons: [{ src: "/icons/icon-192.png", sizes: "192x192" }] }],
  };
}
