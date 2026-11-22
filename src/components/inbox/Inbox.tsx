"use client";
import { MessageSquare } from "lucide-react";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { ConversationList } from "./ConversationList";
import { ConversationView } from "./ConversationView";
import { useConversations, useLead, useTeam } from "./hooks";
import { LeadPanel } from "./LeadPanel";

/**
 * Bandeja: lista · conversación · ficha.
 * Escritorio: 3 columnas. Tablet: ficha como panel lateral. Móvil: una vista cada vez.
 */
export function Inbox() {
  const params = useParams<{ id?: string }>();
  const selectedId = params.id ?? null;
  const { items } = useConversations();
  const team = useTeam();
  const { lead, docs, events } = useLead(selectedId);
  const [showLead, setShowLead] = useState(false);
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  const conv = items?.find((c) => c.id === selectedId) ?? null;

  const toast = useCallback((m: string) => setToastMsg(m), []);
  useEffect(() => {
    if (!toastMsg) return;
    const t = setTimeout(() => setToastMsg(null), 4000);
    return () => clearTimeout(t);
  }, [toastMsg]);
  useEffect(() => setShowLead(false), [selectedId]);

  return (
    <div className={`inbox ${selectedId ? "has-selection" : ""} ${showLead ? "show-lead" : ""}`}>
      <section className="pane list-pane" aria-label="Lista de conversaciones">
        <ConversationList items={items} selectedId={selectedId} />
      </section>

      {conv ? (
        <ConversationView conv={conv} team={team} events={events} onShowLead={() => setShowLead(true)} toast={toast} />
      ) : (
        <section className="pane chat-pane">
          <div className="empty" style={{ margin: "auto" }}>
            {selectedId && items !== null ? (
              "Esta conversación no existe."
            ) : (
              <>
                <MessageSquare size={34} style={{ opacity: 0.4 }} />
                <p className="serif" style={{ fontSize: 20, color: "var(--ink)", margin: "10px 0 4px" }}>
                  Mensajes de Wink
                </p>
                <p className="small">Elige una conversación para verla aquí.</p>
              </>
            )}
          </div>
        </section>
      )}

      {conv ? (
        <LeadPanel conv={conv} lead={lead} docs={docs} events={events} team={team} onClose={() => setShowLead(false)} />
      ) : (
        <aside className="pane lead-pane lead" />
      )}

      {toastMsg && (
        <div className="toast" role="status">
          {toastMsg}
        </div>
      )}
    </div>
  );
}
