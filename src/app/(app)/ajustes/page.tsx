"use client";
import { RefreshCw, UserPlus } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { api } from "@/components/inbox/hooks";
import { useMe } from "@/components/ui/AppShell";
import { supabaseBrowser } from "@/lib/supabase/browser";

interface User {
  id: string;
  full_name: string;
  email: string | null;
  role: "admin" | "agent";
  active: boolean;
}
interface Template {
  id: string;
  name: string;
  language: string;
  category: string | null;
  status: string;
  rejected_reason: string | null;
}

const STATUS_TONE: Record<string, string> = { APPROVED: "chip-ok", REJECTED: "chip-danger", PAUSED: "chip-warn", DISABLED: "chip-danger", PENDING: "chip-warn" };

export default function SettingsPage() {
  const me = useMe();
  const [users, setUsers] = useState<User[]>([]);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [form, setForm] = useState({ fullName: "", email: "", password: "", role: "agent" as "agent" | "admin" });
  const [msg, setMsg] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);

  const load = useCallback(async () => {
    const r = await api<{ users: User[] }>("/api/admin/users");
    if (r.ok) setUsers(r.data.users);
    const { data } = await supabaseBrowser().from("templates").select("id, name, language, category, status, rejected_reason").neq("status", "DELETED").order("name");
    setTemplates((data as Template[] | null) ?? []);
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  if (me.role !== "admin") return <main className="page">Solo para administradores.</main>;

  async function create(e: React.FormEvent) {
    e.preventDefault();
    const r = await api("/api/admin/users", { body: form });
    setMsg(r.ok ? `Usuario creado: ${form.email}. Ya puede entrar con su contraseña.` : (r.data.error ?? "No se pudo crear"));
    if (r.ok) {
      setForm({ fullName: "", email: "", password: "", role: "agent" });
      void load();
    }
  }
  async function update(id: string, patch: Partial<{ role: string; active: boolean }>) {
    const r = await api("/api/admin/users", { method: "PATCH", body: { id, ...patch } });
    if (!r.ok) setMsg(r.data.error ?? "No se pudo actualizar");
    void load();
  }
  async function sync() {
    setSyncing(true);
    const r = await api<{ total: number; approved: number }>("/api/templates/sync", { method: "POST" });
    setSyncing(false);
    setMsg(r.ok ? `Plantillas sincronizadas: ${r.data.total} (${r.data.approved} aprobadas).` : (r.data.error ?? "No se pudo sincronizar"));
    void load();
  }

  return (
    <main className="page">
      <h1>Ajustes</h1>
      <p className="muted" style={{ marginTop: 0 }}>
        Equipo con acceso a la bandeja y plantillas de WhatsApp.
      </p>
      {msg && (
        <p className="card small" style={{ padding: "10px 14px" }} role="status">
          {msg}
        </p>
      )}

      <section className="card" style={{ padding: 18, marginTop: 18 }}>
        <h2 className="serif" style={{ margin: "0 0 12px", fontSize: 19 }}>
          Equipo
        </h2>
        <div style={{ overflowX: "auto" }}>
          <table className="team">
            <thead>
              <tr>
                <th>Nombre</th>
                <th>Email</th>
                <th>Rol</th>
                <th>Acceso</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id}>
                  <td>{u.full_name || "—"}</td>
                  <td className="muted">{u.email}</td>
                  <td>
                    <select className="input" style={{ height: 34, width: 150 }} value={u.role} disabled={u.id === me.id} onChange={(e) => void update(u.id, { role: e.target.value })}>
                      <option value="agent">Agente</option>
                      <option value="admin">Administrador</option>
                    </select>
                  </td>
                  <td>
                    <button className={`btn btn-sm ${u.active ? "" : "btn-primary"}`} disabled={u.id === me.id} onClick={() => void update(u.id, { active: !u.active })}>
                      {u.active ? "Desactivar" : "Activar"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <form onSubmit={create} style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 10, marginTop: 16 }}>
          <input className="input" placeholder="Nombre" value={form.fullName} onChange={(e) => setForm({ ...form, fullName: e.target.value })} required />
          <input className="input" type="email" placeholder="Email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} required />
          <input className="input" type="password" placeholder="Contraseña (mín. 8)" minLength={8} value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} required />
          <select className="input" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as "agent" | "admin" })}>
            <option value="agent">Agente</option>
            <option value="admin">Administrador</option>
          </select>
          <button className="btn btn-primary" style={{ height: 42 }}>
            <UserPlus size={16} /> Añadir
          </button>
        </form>
      </section>

      <section className="card" style={{ padding: 18, marginTop: 18 }}>
        <div className="row" style={{ marginBottom: 12 }}>
          <h2 className="serif grow" style={{ margin: 0, fontSize: 19 }}>
            Plantillas de WhatsApp
          </h2>
          <button className="btn btn-sm" onClick={() => void sync()} disabled={syncing}>
            <RefreshCw size={14} /> {syncing ? "Sincronizando…" : "Sincronizar con Meta"}
          </button>
        </div>
        {templates.length === 0 ? (
          <p className="small muted">Aún no hay plantillas sincronizadas.</p>
        ) : (
          <table className="team">
            <thead>
              <tr>
                <th>Nombre</th>
                <th>Idioma</th>
                <th>Categoría</th>
                <th>Estado</th>
              </tr>
            </thead>
            <tbody>
              {templates.map((t) => (
                <tr key={t.id}>
                  <td>{t.name}</td>
                  <td>{t.language}</td>
                  <td className="muted">{t.category ?? "—"}</td>
                  <td>
                    <span className={`chip ${STATUS_TONE[t.status] ?? ""}`}>{t.status}</span>
                    {t.rejected_reason && <div className="xs muted">{t.rejected_reason}</div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </main>
  );
}
