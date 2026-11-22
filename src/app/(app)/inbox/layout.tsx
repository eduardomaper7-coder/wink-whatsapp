import { Inbox } from "@/components/inbox/Inbox";

/** La bandeja vive en el layout: se mantiene montada al cambiar de conversación (sin parpadeos ni recargas). */
export default function InboxLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <Inbox />
      {children}
    </>
  );
}
