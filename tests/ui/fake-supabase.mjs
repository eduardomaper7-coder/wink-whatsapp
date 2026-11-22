/**
 * Sustituto mínimo de Supabase para probar la interfaz en local:
 *  - /rest/v1      → PostgREST real (con la migración aplicada)
 *  - /auth/v1      → login con contraseña, usuario actual, refresco y salida (JWT HS256)
 *  - /storage/v1   → subida, URL firmada y descarga en memoria
 *  - /realtime/v1  → no disponible (la bandeja pasa a sondeo automático)
 * Uso: node tests/ui/fake-supabase.mjs   (variables: PORT, PGRST_PORT, JWT_SECRET, TEST_USER_ID, TEST_USER_EMAIL)
 */
import http from "node:http";
import crypto from "node:crypto";

const PORT = Number(process.env.PORT ?? 3001);
const PGRST = Number(process.env.PGRST_PORT ?? 3002);
const SECRET = process.env.JWT_SECRET ?? "super-secret-jwt-token-with-at-least-32-characters-long";
const USER = { id: process.env.TEST_USER_ID, email: process.env.TEST_USER_EMAIL ?? "marta@wink.test" };
const files = new Map();

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const sign = (payload) => {
  const h = b64({ alg: "HS256", typ: "JWT" });
  const p = b64(payload);
  return `${h}.${p}.${crypto.createHmac("sha256", SECRET).update(`${h}.${p}`).digest("base64url")}`;
};
const verify = (t) => {
  const [h, p, s] = String(t).split(".");
  if (!s || crypto.createHmac("sha256", SECRET).update(`${h}.${p}`).digest("base64url") !== s) return null;
  return JSON.parse(Buffer.from(p, "base64url").toString());
};
const userJson = () => ({ id: USER.id, aud: "authenticated", role: "authenticated", email: USER.email, app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString() });
const session = () => {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  return { access_token: sign({ sub: USER.id, email: USER.email, role: "authenticated", aud: "authenticated", exp }), token_type: "bearer", expires_in: 3600, expires_at: exp, refresh_token: "fake-refresh", user: userJson() };
};
const json = (res, status, body) => {
  res.writeHead(status, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
  res.end(JSON.stringify(body));
};
const readBody = (req) => new Promise((r) => { const c = []; req.on("data", (d) => c.push(d)); req.on("end", () => r(Buffer.concat(c))); });

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    if (req.method === "OPTIONS") {
      res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "*" });
      return res.end();
    }
    // ---------------- REST → PostgREST
    if (url.pathname.startsWith("/rest/v1")) {
      const p = http.request({ host: "127.0.0.1", port: PGRST, path: req.url.replace(/^\/rest\/v1/, ""), method: req.method, headers: req.headers }, (r) => {
        res.writeHead(r.statusCode, { ...r.headers, "access-control-allow-origin": "*" });
        r.pipe(res);
      });
      return req.pipe(p);
    }
    // ---------------- Auth
    if (url.pathname === "/auth/v1/token") return json(res, 200, session());
    if (url.pathname === "/auth/v1/user") {
      const claims = verify((req.headers.authorization ?? "").replace(/^Bearer /i, ""));
      return claims?.sub ? json(res, 200, userJson()) : json(res, 401, { msg: "invalid JWT" });
    }
    if (url.pathname === "/auth/v1/logout") { res.writeHead(204); return res.end(); }
    // ---------------- Storage
    const sign_ = url.pathname.match(/^\/storage\/v1\/object\/sign\/([^/]+)\/(.+)$/);
    if (sign_ && req.method === "POST") return json(res, 200, { signedURL: `/object/sign/${sign_[1]}/${sign_[2]}?token=demo` });
    if (sign_ && req.method === "GET") {
      const f = files.get(`${sign_[1]}/${decodeURIComponent(sign_[2])}`);
      if (!f) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { "Content-Type": f.type, "Access-Control-Allow-Origin": "*" });
      return res.end(f.data);
    }
    const bucket = url.pathname.match(/^\/storage\/v1\/bucket\/([^/]+)$/);
    if (bucket && req.method === "GET") return json(res, 200, { id: bucket[1], name: bucket[1], public: false });
    const list = url.pathname.match(/^\/storage\/v1\/object\/list\/([^/]+)$/);
    if (list && req.method === "POST") {
      const { prefix = "" } = JSON.parse((await readBody(req)).toString() || "{}");
      const base = `${list[1]}/${prefix ? `${prefix.replace(/\/$/, "")}/` : ""}`;
      const seen = new Map();
      for (const k of files.keys()) {
        if (!k.startsWith(base)) continue;
        const rest = k.slice(base.length);
        const name = rest.split("/")[0];
        seen.set(name, rest.includes("/") ? { name, id: null } : { name, id: name });
      }
      return json(res, 200, [...seen.values()]);
    }
    const del = url.pathname.match(/^\/storage\/v1\/object\/([^/]+)$/);
    if (del && req.method === "DELETE") {
      const { prefixes = [] } = JSON.parse((await readBody(req)).toString() || "{}");
      const gone = prefixes.filter((p) => files.delete(`${del[1]}/${p}`));
      return json(res, 200, gone.map((name) => ({ name })));
    }
    const obj = url.pathname.match(/^\/storage\/v1\/object\/(?:authenticated\/)?([^/]+)\/(.+)$/);
    if (obj && (req.method === "POST" || req.method === "PUT")) {
      const data = await readBody(req);
      files.set(`${obj[1]}/${decodeURIComponent(obj[2])}`, { data, type: req.headers["content-type"] ?? "application/octet-stream" });
      return json(res, 200, { Key: `${obj[1]}/${obj[2]}` });
    }
    if (obj && req.method === "GET") {
      const f = files.get(`${obj[1]}/${decodeURIComponent(obj[2])}`);
      if (!f) return json(res, 404, { error: "not found" });
      res.writeHead(200, { "Content-Type": f.type });
      return res.end(f.data);
    }
    json(res, 404, { error: `fake-supabase: ${url.pathname}` });
  })
  .on("upgrade", (_req, socket) => socket.destroy()) // sin Realtime → sondeo
  .listen(PORT, () => console.log(`fake-supabase en :${PORT}`));
