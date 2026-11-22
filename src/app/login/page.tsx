"use client";
/* eslint-disable @next/next/no-img-element */
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/browser";

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(params.get("e") === "inactive" ? "Tu usuario aún no está activo. Pide acceso a un administrador." : null);
  const [loading, setLoading] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    const { error } = await supabaseBrowser().auth.signInWithPassword({ email: email.trim(), password });
    if (error) {
      setError(error.message.includes("Invalid") ? "Email o contraseña incorrectos." : error.message);
      setLoading(false);
      return;
    }
    router.replace(params.get("next") ?? "/inbox");
    router.refresh();
  }

  return (
    <main className="center">
      <form className="login" onSubmit={submit}>
        <img src="/brand/wink-logo.png" alt="Wink" width={150} height={79} />
        <p className="muted small" style={{ textAlign: "center", margin: "-6px 0 10px" }}>
          Mensajes · acceso del equipo
        </p>
        <label className="sr-only" htmlFor="email">Email</label>
        <input id="email" className="input" type="email" autoComplete="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        <label className="sr-only" htmlFor="password">Contraseña</label>
        <input id="password" className="input" type="password" autoComplete="current-password" placeholder="Contraseña" value={password} onChange={(e) => setPassword(e.target.value)} required />
        {error && <p className="small" style={{ color: "var(--danger)", margin: 0 }}>{error}</p>}
        <button className="btn btn-primary" style={{ height: 44 }} disabled={loading}>
          {loading ? "Entrando…" : "Entrar"}
        </button>
      </form>
    </main>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}
