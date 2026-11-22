# Demo en directo · Asistente de WhatsApp de Wink

Guía para enseñar el sistema a Wink Group (unos 15 minutos). El presentador maneja un móvil (el «cliente») y un portátil conectado al proyector.

## Lo que hay que tener en pantalla

| Dónde | Qué | Para qué |
|---|---|---|
| Proyector | `https://TU-DOMINIO/live`, en pantalla completa (botón ⤢) | El público ve el chat, el expediente rellenándose y las acciones del agente |
| Portátil (segunda pestaña) | `https://TU-DOMINIO/inbox` | Enseñar la bandeja del equipo, tomar el control y la plantilla |
| Móvil del presentador | WhatsApp, chat con el número de demo | Hacer de cliente |
| Móvil de Wink (opcional) | La app instalada con notificaciones activadas | Que vean llegar el aviso de derivación |
| Bandeja de `BRIEFING_EMAIL_TO` | Correo abierto | Enseñar el briefing que recibe el arquitecto |

> **Número de prueba de Meta:** solo puede escribir a **5 teléfonos autorizados** (WhatsApp → Configuración de la API → «Para»). Si alguien del público escribe desde un móvil no autorizado, su mensaje sí aparece en la bandeja, pero la respuesta falla con el error 131030 y en la bandeja se ve el motivo en español. Por eso, con el número de prueba, **el QR del panel es solo para los móviles autorizados**. Con el número definitivo de Wink, cualquiera puede escanearlo.

## Preparación

**La víspera**
- [ ] `npm run demo:check -- --url https://TU-DOMINIO`: todo en ✓.
- [ ] Token de Meta: el temporal dura 24 h. Para la demo, usa un **token de usuario del sistema** (permanente) o genera uno nuevo esa misma mañana.
- [ ] Móviles autorizados en Meta (máximo 5): el del presentador y los de quien vaya a probarlo.
- [ ] El worker programado en Supabase (`supabase/sql/schedule_worker.sql`). Sin él, el agente responde con retraso.
- [ ] Notificaciones activadas en el móvil de Wink (en iPhone, con la app instalada en la pantalla de inicio).
- [ ] Un ensayo completo con el guion de abajo.

**30 minutos antes**
- [ ] `npm run demo:reset -- --phone 34TU_MOVIL --seed`: borra tu conversación de ensayo y recarga los 5 ejemplos.
- [ ] Abrir `/live` en el proyector y `/inbox` en otra pestaña. Comprobar que el panel muestra el QR.
- [ ] Tener a mano en el móvil la foto de un salón o una cocina y un PDF de un plano (vale cualquiera).
- [ ] Wi-Fi o datos en el móvil. Silenciar otras notificaciones.

## Guion

**1 · Contexto (1 min) — en `/inbox`**
«Hoy los mensajes de WhatsApp llegan a un móvil y alguien tiene que contestar a todas horas. Esto es la bandeja del equipo: aquí están todas las conversaciones; las que lleva el asistente van marcadas, y el filtro «Equipo» reúne las que necesitan a una persona.» Abre *Lucía Martín* (visita agendada, briefing listo) para enseñar el resultado final antes de construirlo en directo.

**2 · Un cliente nuevo (5 min) — cambia al proyector `/live`**
Desde el móvil escribe, con naturalidad y en varios mensajes:
1. «Hola, estoy pensando en reformar mi piso» → el panel salta solo a tu conversación; aparece «escribiendo…». El asistente saluda, da el **aviso de privacidad** y pregunta.
2. Contesta a 2–3 preguntas (dirección aproximada, metros, qué quieres cambiar) → el expediente se rellena y **cada dato nuevo se ilumina**; el teletipo muestra «Ficha actualizada: …».
3. **Manda una nota de voz** contando lo que quieres hacer → «Nota de voz transcrita» y el agente la entiende.
4. Envía la foto y el PDF cuando te los pida → aparecen como miniaturas en el expediente.
5. **Pregunta «¿y más o menos cuánto me costaría?»** → no da precios: explica que lo valora el arquitecto tras la visita. (Es la salvaguarda que más tranquiliza.)

**3 · Visita (2 min)**
El asistente ofrece 3 huecos como **botones**. Pulsa uno → tarjeta negra «Visita técnica reservada» en el panel, evento en el calendario y, al momento, «Briefing redactado» y «Briefing enviado». Abre el correo y enseña el briefing: resumen, datos, fotos y lo que hay que preguntar en la visita.

**4 · El equipo toma el control (3 min) — vuelve a `/inbox`**
- Abre tu conversación, pulsa **Pausar el asistente** y escribe a mano: el cliente lo recibe en su WhatsApp. En el panel, la etiqueta cambia a «Equipo de Wink».
- Desde el móvil escribe «Prefiero que me llaméis» en otra conversación (o reactiva el asistente y pídelo) → **derivación**: aviso push en el móvil de Wink y la conversación pasa al filtro «Equipo» con la nota de derivación.
- Abre *Carmen Ortega* (ventana de 24 h cerrada) para explicar la regla de las 24 h y enviar una **plantilla** aprobada.

**5 · Cierre (1 min)**
Ajustes: usuarios y roles, plantillas sincronizadas con Meta. «Todo esto funciona hoy con el número de prueba; pasar al número de Wink es cambiar la configuración, no el código.»

## Plan B

| Si pasa esto | Haz esto |
|---|---|
| El asistente no contesta en 30 s | Mira en `/inbox` si el mensaje ha llegado. Si ha llegado, el worker no corre: lánzalo a mano con `curl -X POST -H "Authorization: Bearer $CRON_SECRET" https://TU-DOMINIO/api/jobs/run` (`npm run demo:check` lo prueba) o sigue la demo contestando tú a mano desde la bandeja («así toma el control el equipo»). |
| No llega nada a la bandeja | El webhook no está suscrito o el token ha caducado: `npm run demo:check`. Mientras, enseña las conversaciones de ejemplo y la ficha de Lucía. |
| La respuesta falla con «teléfonos autorizados» | Ese móvil no está en la lista del número de prueba (error 131030). Usa el móvil del presentador. |
| Sin conexión en la sala | Comparte datos del móvil. Si no hay manera, enseña las conversaciones de ejemplo: cuentan la misma historia. |
| El agente dice algo raro | Pulsa **Pausar el asistente**, corrige a mano y aprovéchalo: «para esto existe el botón». |
| El panel se queda en otra conversación | Comprueba que pone «Siguiendo al último cliente» (no «Fijada»), o abre `/live?c=ID_DE_LA_CONVERSACIÓN`. |

## Después de la demo

```bash
npm run demo:reset -- --phone 34TU_MOVIL          # borra tu prueba, deja los ejemplos
npm run demo:reset -- --phone 34TU_MOVIL --seed   # …y vuelve a dejar los ejemplos como nuevos
npm run demo:reset -- --all --yes                 # todo a cero (antes de pasar a producción)
```

## Pasar del número de prueba al de Wink

Ver la sección «Pasar al número definitivo de Wink» del README. Resumen: registrar el número en la Cloud API, usar un token permanente de usuario del sistema, cambiar `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_BUSINESS_ACCOUNT_ID` y `NEXT_PUBLIC_DEMO_WA_NUMBER` en Vercel, volver a desplegar, `npm run demo:reset -- --all --yes` y `npm run demo:check`.
