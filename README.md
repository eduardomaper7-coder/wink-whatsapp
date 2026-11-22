# Wink · WhatsApp

Sistema propio de WhatsApp para **Wink Group**: recepción y envío sobre la **WhatsApp Cloud API** de Meta, agente de IA de captación y seguimiento, y bandeja de entrada web para el equipo.

Desarrollado por **Aibe Technologies**.

| Fase | Contenido | Estado |
|---|---|---|
| 1 | Webhook, guardado de mensajes, multimedia y estados | ✅ |
| 2 | Envío (texto, botones, listas, media, plantillas, ventana de 24 h) | ✅ |
| 3 | Agente de captación (Claude + herramientas + Calendar + briefing) | ✅ |
| 4 | Bandeja de entrada web | ✅ |
| 5 | PWA y notificaciones push | ✅ |
| 6 | Demo (datos ficticios, reinicio, panel en directo) | ✅ |

---

## Arquitectura (fase 1)

```
Meta ──POST firmado──▶ /api/webhooks/whatsapp
                         1. valida X-Hub-Signature-256 sobre el cuerpo en crudo  → 401 si no
                         2. guarda el webhook (wa_webhook_events, único por sha256 del cuerpo)
                         3. encola process_webhook (jobs, único por evento)
                         4. responde 200   (si no pudo guardar → 500 y Meta reintenta)
                         5. after(): procesa la cola en segundo plano
                                  │
              Supabase pg_cron ───┤ cada minuto → /api/jobs/run (reintentos y respaldo)
                                  ▼
       process_webhook → contacts · conversations · messages (único por wamid)
                       → estados (sent/delivered/read/played/failed, nunca retroceden)
                       → download_media → Meta Media API → Storage → attachments
```

**Idempotencia en dos capas:** el mismo cuerpo reintentado por Meta produce el mismo evento y el mismo trabajo; además, `messages.wa_message_id` es único, así que un mensaje nunca se guarda dos veces ni dispara efectos secundarios duplicados.

**Cola en Postgres** (`jobs` + `claim_jobs()` con `FOR UPDATE SKIP LOCKED`): varios workers pueden ejecutarse a la vez sin pisarse. Los reintentos usan backoff exponencial (15 s → 1 h), y los trabajos bloqueados más de 5 minutos se recuperan solos.

### Estructura

```
src/
  app/api/webhooks/whatsapp/route.ts   GET verificación · POST recepción
  app/api/jobs/run/route.ts            worker de la cola (Bearer CRON_SECRET)
  lib/env.ts                           variables validadas (zod)
  lib/log.ts                           logs JSON con redacción de datos personales y secretos
  lib/whatsapp/                        firma, tipos, parseo, Graph API, media, errores
  lib/whatsapp/inbound/                procesado (independiente de la BD), almacén Supabase, ingesta
  lib/jobs/                            cola, runner y handlers
supabase/migrations/                   esquema completo + RLS + Storage + Realtime
supabase/sql/schedule_worker.sql       programación del worker con pg_cron
scripts/simulate-webhook.mts           envía webhooks firmados como Meta
tests/                                 unitarios, payloads reales, SQL y E2E
```

### Modelo de datos

`profiles` (equipo y roles) · `contacts` · `conversations` (estado bot/humano/cerrada, agente activo, asignación, `last_inbound_at` para la ventana de 24 h) · `messages` · `leads` (expediente) · `attachments` · `agent_runs` (auditoría del agente) · `templates` · `push_subscriptions` · `wa_webhook_events` · `jobs` · `events` (auditoría general).

RLS está activo en todas las tablas. Solo ven datos los miembros **activos** del equipo; la cola, los webhooks crudos y las ejecuciones del agente solo los ven los administradores. El servidor usa la service role.

---

## Envío de mensajes (fase 2)

Hay **un único punto de entrada**, `sendMessage()` (`src/lib/whatsapp/outbound/service.ts`), que usan por igual la bandeja (personas), el agente y el sistema:

```
validar contenido (límites de Meta) → comprobar ventana de 24 h / baja / plantilla
→ guardar mensaje (status "queued") → actualizar conversación
   · si escribe una persona: modo humano + agente pausado + no leídos a 0 + se asigna
→ enviar a Meta (biz_opaque_callback_data = id interno)
   ├─ aceptado          → se guarda el wamid; sent/delivered/read llegan por webhook
   ├─ error temporal    → cola send_message con espera (límites: 15 s–2 min; backoff hasta 1 h)
   ├─ error permanente  → status "failed" + motivo en español para la bandeja
   └─ timeout sin resp. → reintento a los 90 s; si mientras tanto llega un estado con
                          nuestro id, se enlaza el wamid y NO se reenvía
```

| Tipo | Contenido (`content`) |
|---|---|
| Texto | `{ type: "text", body }` (≤ 4096) |
| Botones | `{ type: "buttons", body, buttons: [{id,title}] ≤ 3, header?, footer? }` (título ≤ 20) |
| Lista | `{ type: "list", body, buttonText, sections: [{title?, rows: [{id,title,description?}]}] }` (≤ 10 opciones en total) |
| Imagen | `{ type: "image", media, caption? }` (JPG/PNG ≤ 5 MB) |
| Documento | `{ type: "document", media, filename?, caption? }` (PDF/Office/TXT ≤ 100 MB) |
| Plantilla | `{ type: "template", name, language, body?: [...] \| {nombre: valor}, header?, urlButtons? }` |

`media` puede ser `{ storagePath: "outbound/…" }` (archivo subido a Supabase Storage, que es lo normal), `{ waMediaId }` o `{ link: "https://…" }`. Los archivos de Storage se suben a Meta y se envían por id, como recomienda Meta. El id se reutiliza en los reintentos.

**Ventana de 24 h:** fuera de ella solo se permiten plantillas **aprobadas**. Antes de llamar a Meta se comprueba que se han rellenado todas las variables de la plantilla. La API responde `409 window_closed` con las plantillas disponibles para ofrecerlas en la interfaz. Se aplica un margen de seguridad de 2 minutos.

**Errores:** se clasifican por código según la tabla oficial de Meta (`src/lib/whatsapp/errors.ts`): temporales, límites de envío, ventana cerrada, destinatario, plantilla, multimedia, autenticación, cuenta y petición inválida. Cada uno lleva un mensaje en español. Un token caducado genera el evento `whatsapp.auth_error`, que servirá para alertar a los administradores en la fase 5. Un error de plantilla programa una resincronización.

### API

| Método | Ruta | Quién |
|---|---|---|
| `POST` | `/api/conversations/{id}/messages` · `{ content, clientRef?, replyTo? }` | equipo |
| `GET` | `/api/conversations/{id}/window` → `{ window, templates }` | equipo |
| `GET` | `/api/templates` → plantillas aprobadas con sus variables | equipo |
| `POST` | `/api/templates/sync` | admin |

Autenticación: sesión de Supabase (cookies, la bandeja) o `Authorization: Bearer <access_token>`. Usa `clientRef` (por ejemplo un uuid generado en el navegador) para que un doble clic no duplique el envío.

### Plantillas

- Se sincronizan desde la WABA con `POST /api/templates/sync` o con `npm run send:test -- --sync-templates`.
- Se actualizan solas con el webhook **`message_template_status_update`**. Suscríbelo en Meta junto a `messages`.
- Plantillas que conviene crear y enviar a aprobación cuanto antes, en categoría *Utilidad* e idioma `es`:
  - `retomar_conversacion`: «Hola {{1}}, te escribimos de Wink sobre tu proyecto. ¿Seguimos hablando por aquí?»
  - `recordatorio_visita`: «Hola {{1}}, te recordamos la visita técnica de Wink el {{2}} en {{3}}. Si necesitas cambiarla, responde a este mensaje.»
  - `confirmacion_visita`: «Hola {{1}}, tu visita técnica con Wink queda confirmada para el {{2}}. ¡Hasta pronto!»

## Agente de captación y seguimiento (fase 3)

```
mensaje del cliente → webhook → schedule_agent_run (espera 6 s y agrupa los mensajes seguidos)
  → agent_reply (un bloqueo impide dos ejecuciones a la vez en la misma conversación)
     1. ¿Agente activo? ¿Ventana abierta? ¿Hay algo que responder? ¿Multimedia aún descargándose/transcribiéndose?
     2. Clasificación (Haiku): cliente potencial / obra en curso / proveedor; pide persona; molesto; urgente
        → derivación obligatoria sin pasar por el modelo conversacional
     3. Agente (Sonnet) con herramientas y prompt + base de conocimiento cacheados
     4. Si el cliente escribió mientras tanto → se descarta la respuesta y se contesta a todo junto
     5. Salvaguardas: cifras de dinero bloqueadas · aviso de privacidad garantizado en el primer contacto
     6. Envío (el agente nunca habla si una persona ha tomado la conversación)
     7. Auditoría en agent_runs: herramientas usadas, con su `motivo`, sus entradas y resultados, y los tokens
```

| Herramienta | Qué hace |
|---|---|
| `actualizar_ficha_cliente` | Guarda los datos de cualificación en el expediente y devuelve los campos pendientes |
| `registrar_documento` | Asocia fotos y planos al expediente, con una descripción |
| `consultar_huecos_disponibles` | Devuelve 3 huecos libres (en días distintos, alternando mañana y tarde) |
| `reservar_visita` | Vuelve a comprobar la agenda, crea el evento, marca la visita y programa el briefing |
| `derivar_a_humano` | Modo humano, agente pausado, resumen para el equipo y evento `agent.handoff` |
| `cerrar_conversacion` | Cierra tras la despedida |
| `enviar_opciones` | Envía botones (3 o menos) o una lista (hasta 10) |

**Editable sin tocar código** (carpeta `agent-config/`):
- `system-prompt.md`: personalidad, reglas y flujo.
- `knowledge-base.md`: lo único que el agente puede afirmar sobre Wink. Revisa lo marcado como «(verificar)».
- `agenda.json`: horario, duración y margen de las visitas, antelación y festivos.

**Modelos** (variables de entorno): Sonnet 5.5 para la conversación, Haiku 5.5 para clasificar y Opus 5.5 solo para el briefing. Son modelos 5.5, así que no se envían `temperature` ni `tool_choice` forzado (la API lo rechaza); la latencia se ajusta con `AGENT_EFFORT_CHAT`.

**Si algo falla:** los errores temporales de Claude se reintentan. Si el agente falla de forma definitiva, la conversación pasa a una persona, para que ningún cliente se quede sin respuesta.

### Agenda, email y notas de voz (todo gratuito)

- **Agenda:** `CALENDAR_PROVIDER=demo` funciona sin Google, con huecos simulados y las visitas guardadas en la base de datos. Para usar Google Calendar:
  1. Activa la Calendar API en un proyecto de Google Cloud.
  2. Crea una cuenta de servicio y descarga su clave JSON.
  3. Comparte el calendario de visitas con el email de la cuenta de servicio, con permiso «Hacer cambios en eventos».
  4. Rellena `GOOGLE_SERVICE_ACCOUNT_JSON`, `GOOGLE_CALENDAR_ID` y pon `CALENDAR_PROVIDER=google`.
- **Briefing por email:** SMTP de Hostinger (`smtp.hostinger.com`, puerto 465 con SSL) con `prueba@aibetech.es`. El destinatario se configura en `BRIEFING_EMAIL_TO`. Incluye enlaces firmados (7 días) a la documentación y al expediente.
- **Notas de voz:** Groq Whisper (`whisper-large-v3-turbo`, plan gratuito). Crea una clave en console.groq.com y ponla en `GROQ_API_KEY`. Sin ella, el agente pide que le escriban.

### Probar el agente sin WhatsApp

```bash
npm run agent:chat            # chat de terminal con el agente real (Claude), sin enviar nada a Meta
# /boton 1 pulsa el primer botón · /salir termina
```

## Bandeja de entrada (fase 4)

Sustituye a la app de WhatsApp para el equipo. Funciona en escritorio y en móvil:

| | Escritorio | Tablet | Móvil |
|---|---|---|---|
| Disposición | Lista · conversación · ficha | Lista · conversación (la ficha se abre como panel) | Una vista cada vez, con barra inferior |

- **Acceso:** Supabase Auth con email y contraseña. Solo entran los perfiles **activos**. Dos roles: administrador (gestiona el equipo y las plantillas) y agente.
- **Lista en tiempo real:** filtros Todas, Equipo, Asistente, Sin leer, Mías y Cerradas, búsqueda por nombre o teléfono, punto de ventana de 24 h (verde abierta, ámbar cerrando, gris cerrada) y contador de no leídos.
- **Conversación como en WhatsApp:**
  - Burbujas que distinguen al cliente, al **Asistente IA** y a la persona del equipo (con su nombre).
  - Fotos, audios con su transcripción, PDF y ubicación.
  - Botones ofrecidos y botones pulsados.
  - Estados (enviando, enviado, entregado, leído, fallido con el motivo).
  - Reacciones.
  - Notas de sistema: derivaciones, pausas, visitas.
- **Escribir:** texto, adjuntos (JPG/PNG de hasta 5 MB, documentos de hasta 100 MB) y plantillas con vista previa de sus variables. Al escribir, el asistente **se pausa**. Si la ventana está cerrada, la interfaz lo explica y ofrece las plantillas.
- **Acciones:** pausar o reactivar el asistente (al reactivarlo responde si el cliente estaba esperando), asignar la conversación, cerrarla y reabrirla. La conversación se marca como leída al abrirla.
- **Ficha en directo:** estado del expediente, visita técnica, motivo y resumen de la derivación, campos de la ficha (resaltados al cambiar), progreso, documentos y briefing.
- **Ajustes (solo administradores):** alta de usuarios, roles, activar y desactivar, y plantillas con su estado y la opción de sincronizarlas con Meta.
- **Tiempo real:** con Supabase Realtime. Si el canal no conecta, la bandeja sondea sola y nunca se queda congelada.

### Primer acceso y datos de demo

```bash
npm run demo:seed -- --admin tu@email.com --password "UnaClaveSegura1" --name "Tu Nombre"
```

Crea tu usuario administrador y 5 conversaciones de ejemplo: una captación con visita agendada y briefing, una derivada al equipo, una con la ventana cerrada, un proveedor y una con el asistente atendiendo.

### Prueba visual automatizada

`tests/ui/walkthrough.mjs` recorre la bandeja con Chrome en escritorio y móvil, con 21 comprobaciones y capturas. `tests/ui/fake-supabase.mjs` simula la autenticación y el Storage de Supabase sobre PostgREST para poder ejecutarlo sin un proyecto real.

## App instalable y notificaciones (fase 5)

**Instalar en el móvil:**
- **iPhone (Safari):** Compartir → *Añadir a pantalla de inicio*.
- **Android (Chrome):** menú → *Instalar aplicación*.

Se abre a pantalla completa con el icono de Wink, muestra en el icono el número de conversaciones sin leer y enseña una página «Sin conexión» si se cae la red. El service worker no guarda en caché datos de clientes.

**Notificaciones push** (Web Push estándar, gratuito, sin Firebase):

| Cuándo | A quién |
|---|---|
| Escribe un cliente en una conversación atendida por el equipo | A la persona asignada (o a todo el equipo si no hay nadie asignado) |
| El asistente deriva una conversación | A todo el equipo (fija en pantalla si es urgente) |
| WhatsApp se queda sin token válido | A los administradores |

- Si ya estás mirando esa conversación, no se avisa. Al pulsar la notificación se abre la conversación.
- Cada persona las activa en su dispositivo desde la campana (escritorio) o *Avisos* (móvil). Hay un aviso en la lista mientras no estén activadas, y al activarlas llega una notificación de prueba.
- **En iPhone solo funcionan con la app instalada en la pantalla de inicio** (iOS 16.4 o posterior). La interfaz lo explica.
- Configuración: `npm run vapid:keys` y copia las claves en `NEXT_PUBLIC_VAPID_PUBLIC_KEY` y `VAPID_PRIVATE_KEY`. La clave pública se incrusta al compilar, así que hay que volver a desplegar tras cambiarla.
- Las suscripciones caducadas se borran solas, y los avisos salen por la cola (`push_notify`), así que el webhook sigue respondiendo al momento.

Prueba en navegador: `npm run test:pwa` (manifest, iconos, service worker, push entregado → notificación, página sin conexión).

## Demo en directo (fase 6)

- **Panel `/live`** para proyectar (16:9, se abre desde el icono de la barra lateral). Muestra el chat del cliente que acaba de escribir, con «escribiendo…» mientras el asistente prepara la respuesta. Al lado, el expediente se rellena en directo y resalta cada dato nuevo; debajo, un teletipo con lo que hace el agente: ficha, documentos, nota de voz transcrita, visita reservada, briefing y derivación. Lleva un QR a `wa.me` con el número de `NEXT_PUBLIC_DEMO_WA_NUMBER` para que el público escriba. Se puede fijar una conversación y pasar a pantalla completa.
- **`npm run demo:check`** comprueba antes de empezar las variables y la conexión real con cada servicio: Supabase, número de WhatsApp y su calidad, app suscrita a la WABA, webhook y worker desplegados, modelos de Claude, Groq y SMTP. No imprime secretos.
- **`npm run demo:reset`** borra las conversaciones de ejemplo; con `--phone 346…` borra también la tuya, para repetir la prueba desde cero (el asistente vuelve a saludar y a dar el aviso de privacidad). Con `--seed` vuelve a cargar los ejemplos y con `--all --yes` lo borra todo. Elimina también los ficheros de Storage, los trabajos pendientes y los webhooks guardados. Nunca toca usuarios ni plantillas.
- **Guion, plan B y checklist:** [`docs/DEMO.md`](docs/DEMO.md).

Prueba en navegador: `node tests/ui/live.mjs` (14 comprobaciones a 1920×1080: sigue al cliente nuevo, rellena y resalta el expediente, visita, teletipo y fijar o soltar).

## 1. Configuración de Supabase

1. Crea un proyecto en una **región de la UE** (p. ej. `eu-west-3`, París, o `eu-central-1`, Fráncfort).
2. Aplica la migración: `supabase db push` con la CLI, o pega `supabase/migrations/*.sql` en el SQL Editor.
3. **Authentication → Sign In / Providers:** desactiva el registro público. Los usuarios se invitan, y un administrador los activa (`profiles.active = true`).
4. Copia la URL, la clave anon y la service role en las variables de entorno.

## 2. Configuración de la app en Meta

1. En [developers.facebook.com](https://developers.facebook.com), crea una app de tipo **Empresa** y añade el producto **WhatsApp**.
2. En **WhatsApp → Configuración de la API** anota:
   - el **ID del número de teléfono** → `WHATSAPP_PHONE_NUMBER_ID`
   - el **ID de la cuenta de WhatsApp Business** → `WHATSAPP_BUSINESS_ACCOUNT_ID`
   - un token temporal (24 h) para pruebas → `WHATSAPP_TOKEN`
3. En **Configuración de la app → Básica → Clave secreta** → `WHATSAPP_APP_SECRET`.
4. Con el número de prueba, añade en «Para» los teléfonos que vayan a escribir durante la demo. Solo esos números pueden recibir mensajes.

### Conectar el webhook

1. Despliega primero (sección 3), porque Meta verifica la URL en el momento.
2. En **WhatsApp → Configuración → Webhook → Editar**:
   - URL de devolución de llamada: `https://TU-DOMINIO/api/webhooks/whatsapp`
   - Token de verificación: el valor de `WHATSAPP_VERIFY_TOKEN`
3. Pulsa **Verificar y guardar**. Meta hace el GET y el endpoint devuelve el `hub.challenge`.
4. En **Campos del webhook**, suscribe **`messages`** y **`message_template_status_update`**.
5. Escribe al número desde un móvil y comprueba que aparecen filas en `messages`.

## 3. Despliegue en Vercel

1. Importa el repositorio en Vercel. `vercel.json` fija la región `cdg1` (París) para estar cerca de Supabase UE.
2. Añade todas las variables de `.env.example` en **Settings → Environment Variables**.
3. Despliega.
4. **Programa el worker cada minuto** desde Supabase: activa `pg_cron` y `pg_net`, guarda la URL y `CRON_SECRET` en Vault, y ejecuta `supabase/sql/schedule_worker.sql` (las instrucciones están dentro del archivo). El cron de `vercel.json` es solo un respaldo diario, compatible con el plan Hobby.

## 4. Desarrollo y pruebas

```bash
npm install
cp .env.example .env.local      # rellena los valores
npm run dev

npm test                        # unitarios + payloads reales (107 tests)
npm run typecheck
npm run test:sql                # migración + comportamiento SQL (requiere Postgres local)
SUPABASE_E2E_URL=… SUPABASE_E2E_SERVICE_KEY=… npm run test:e2e   # 22 E2E (webhook, envío, agente, avisos) contra un proyecto DE PRUEBAS

# Envío real con el número de prueba (sin interfaz):
npm run send:test -- --sync-templates
npm run send:test -- 34600111222 --template hello_world en_US   # funciona aunque no haya ventana
npm run send:test -- 34600111222 "Hola desde Wink"               # requiere que el número haya escrito antes
npm run send:test -- 34600111222 --buttons

# Simular un webhook firmado (como Meta) contra local o desplegado:
npm run simulate -- text
npm run simulate -- image --url https://TU-DOMINIO/api/webhooks/whatsapp
npm run simulate -- text --keep-id          # mismo wamid → comprueba que no se duplica
npm run simulate -- text --from 34600111222 --text "Hola, quiero reformar mi piso"
```

Payloads disponibles en `tests/fixtures/webhooks/`: `text`, `text_ad_referral`, `image`, `document`, `audio_voice`, `location`, `interactive_button_reply`, `interactive_list_reply`, `button_template`, `reaction`, `reaction_removed`, `unsupported`, `contacts_card`, `statuses`, `status_failed`, `foreign_number` y `system_error`.

## 5. Pasar al número definitivo de Wink

Solo cambia la configuración, no el código:

1. Registra el número de Wink en la misma WABA (o en una nueva) **solo para la Cloud API**, sin coexistencia con la app WhatsApp Business.
2. Crea un **usuario del sistema** en Business Manager con un token **permanente** y los permisos `whatsapp_business_messaging` y `whatsapp_business_management`.
3. Actualiza en Vercel `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_BUSINESS_ACCOUNT_ID` y `NEXT_PUBLIC_DEMO_WA_NUMBER` (y `WHATSAPP_APP_SECRET` si cambias de app), y vuelve a desplegar.
4. El sistema ignora los webhooks de cualquier otro `phone_number_id`, así que el número de prueba no contamina los datos reales.
5. `npm run demo:reset -- --all --yes` deja la base vacía antes de recibir clientes reales, y `npm run demo:check` confirma el número nuevo.

## Seguridad y datos personales

- Todas las credenciales están en variables de entorno. La service role solo se usa en el servidor.
- Los logs están en JSON y redactan automáticamente tokens, claves y cabeceras `Authorization`. Los teléfonos aparecen como `***678` y el texto del cliente solo como su longitud.
- La multimedia se guarda en un bucket **privado**. Las rutas no contienen datos personales y se accede con URLs firmadas.
- Hay una limpieza programada de webhooks crudos (30 días) y de trabajos terminados (14 días).

## Notas sobre la API de Meta (verificadas en la documentación oficial, noviembre de 2026)

- La versión vigente de la Graph API es la **v26.0** (configurable con `WHATSAPP_GRAPH_VERSION`).
- Las URLs de descarga de media **caducan a los 5 minutos**: se descargan en el mismo trabajo y se piden de nuevo en cada reintento.
- Las reacciones que el cliente retira llegan **sin** el campo `emoji`.
- Un estado `read` puede llegar sin un `delivered` previo; los estados nunca retroceden.
- Los botones de respuesta rápida de **plantillas** llegan como `type: "button"`. Los de mensajes interactivos llegan como `interactive.button_reply`. Se soportan ambos.
- Límites de los mensajes interactivos: máximo 3 botones de 20 caracteres; listas con un máximo de 10 opciones en total, títulos de 24 caracteres y descripciones de 72.
- La respuesta del envío solo confirma que Meta lo ha **aceptado**; la entrega llega por webhook. El `wa_id` devuelto puede no coincidir con el número enviado (se registra).
- **Pendiente de confirmar:** la política exacta de reintentos de Meta (cuántas veces y durante cuánto tiempo) y si el `sha256` de la media viene en hex o en base64. El código acepta ambos formatos y no depende de ninguna de las dos cosas.
