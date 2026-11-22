import { describe, expect, it } from "vitest";
import { JOB, processWebhookPayload } from "@/lib/whatsapp/inbound/process";
import { fixture } from "./helpers/fixtures";
import { MemoryStore } from "./helpers/memory-store";

const OPTS = { phoneNumberId: "106540352242922" };

describe("processWebhookPayload", () => {
  it("texto: crea contacto, conversación y mensaje; actualiza ventana 24 h y no leídos", async () => {
    const store = new MemoryStore();
    const s = await processWebhookPayload(fixture("text"), store, OPTS);
    expect(s.messagesStored).toBe(1);
    expect(store.contacts.get("34612345678")?.profileName).toBe("Lucía Martín");
    const conv = [...store.conversations.values()][0]!;
    expect(conv.unread).toBe(1);
    expect(conv.lastInboundAt?.getTime()).toBe(1763650000 * 1000);
    expect(store.events.map((e) => e.type)).toEqual(["message.received"]);
  });

  it("idempotencia: el mismo webhook reintentado por Meta no duplica nada", async () => {
    const store = new MemoryStore();
    await processWebhookPayload(fixture("image"), store, OPTS);
    const again = await processWebhookPayload(fixture("image"), store, OPTS);
    expect(again).toMatchObject({ messagesStored: 0, duplicates: 1 });
    expect(store.messages).toHaveLength(1);
    expect(store.jobs.filter((j) => j.type === JOB.DOWNLOAD_MEDIA)).toHaveLength(1);
    expect([...store.conversations.values()][0]!.unread).toBe(1);
  });

  it("imagen, documento y audio encolan la descarga de media con dedupe por wamid", async () => {
    const store = new MemoryStore();
    for (const f of ["image", "document", "audio_voice"]) await processWebhookPayload(fixture(f), store, OPTS);
    const media = store.jobs.filter((j) => j.type === JOB.DOWNLOAD_MEDIA);
    expect(media.map((j) => j.payload.kind)).toEqual(["image", "document", "audio"]);
    expect(media[1]!.payload.filename).toBe("plano-vivienda.pdf");
    expect(media[0]!.opts?.dedupeKey).toBe("media:wamid.IMAGE0001");
    expect(store.messages.every((m) => m.mediaId)).toBe(true);
  });

  it("varios clientes / mensajes: una conversación por contacto", async () => {
    const store = new MemoryStore();
    for (const f of ["text", "location", "interactive_list_reply"]) await processWebhookPayload(fixture(f), store, OPTS);
    expect(store.contacts.size).toBe(1);
    expect(store.conversations.size).toBe(1);
    expect([...store.conversations.values()][0]!.unread).toBe(3);
  });

  it("reacción: se guarda sobre el mensaje saliente y no cuenta como no leído", async () => {
    const store = new MemoryStore();
    await processWebhookPayload(fixture("text"), store, OPTS);
    const convId = store.messages[0]!.conversationId;
    store.addOutbound("wamid.OUTBOUND_SLOTS_0001", convId);
    await processWebhookPayload(fixture("reaction"), store, OPTS);
    const target = store.messages.find((m) => m.waMessageId === "wamid.OUTBOUND_SLOTS_0001")!;
    expect(target.customerReaction).toBe("👍");
    expect(store.conversations.get(convId)!.unread).toBe(1);
    expect(store.conversations.get(convId)!.preview).toMatch(/Chamberí/); // la vista previa no cambia
    await processWebhookPayload(fixture("reaction_removed"), store, OPTS);
    expect(target.customerReaction).toBeNull();
  });

  it("estados: read antes que delivered no retrocede", async () => {
    const store = new MemoryStore();
    store.addOutbound("wamid.OUTBOUND_SLOTS_0001");
    const s = await processWebhookPayload(fixture("statuses"), store, OPTS);
    expect(s.statusesApplied).toBe(3);
    expect(store.messages[0]!.status).toBe("read");
  });

  it("estado failed guarda el error y deja evento de auditoría", async () => {
    const store = new MemoryStore();
    store.addOutbound("wamid.OUTBOUND_FAILED_0001");
    await processWebhookPayload(fixture("status_failed"), store, OPTS);
    expect(store.messages[0]!.status).toBe("failed");
    expect(store.messages[0]!.error).toMatchObject({ code: 131047 });
    expect(store.events.at(-1)).toMatchObject({ type: "message.failed" });
  });

  it("estado de un mensaje aún no registrado se reintenta más tarde", async () => {
    const store = new MemoryStore();
    const s = await processWebhookPayload(fixture("status_failed"), store, OPTS);
    expect(s.statusesDeferred).toBe(1);
    const job = store.jobs.find((j) => j.type === JOB.APPLY_STATUS)!;
    expect(job.opts?.runAfter!.getTime()).toBeGreaterThan(Date.now());
    expect(job.payload.status).toBe("failed");
  });

  it("no soportado: se guarda con aviso visible", async () => {
    const store = new MemoryStore();
    await processWebhookPayload(fixture("unsupported"), store, OPTS);
    expect(store.messages[0]!.type).toBe("unsupported");
    expect(store.events[0]).toMatchObject({ type: "message.unsupported" });
  });

  it("ignora mensajes de otro phone_number_id (número de prueba vs producción)", async () => {
    const store = new MemoryStore();
    const s = await processWebhookPayload(fixture("foreign_number"), store, OPTS);
    expect(s.ignoredForeignNumber).toBe(1);
    expect(store.messages).toHaveLength(0);
  });

  it("errores de sistema se registran en auditoría", async () => {
    const store = new MemoryStore();
    const s = await processWebhookPayload(fixture("system_error"), store, OPTS);
    expect(s.systemErrors).toBe(1);
    expect(store.events[0]).toMatchObject({ type: "whatsapp.system_error", data: { code: 131000 } });
  });
});

describe("fase 2 · webhooks relacionados con el envío", () => {
  it("estado con biz_opaque_callback_data enlaza un saliente sin wamid (respuesta perdida)", async () => {
    const store = new MemoryStore();
    store.addOutbound("", undefined, "queued", "11111111-2222-3333-4444-555555555555");
    const s = await processWebhookPayload(fixture("status_with_callback"), store, OPTS);
    expect(s.statusesApplied).toBe(1);
    expect(store.messages[0]).toMatchObject({ waMessageId: "wamid.RECOVERED0001", status: "sent" });
  });

  it("estado failed guarda el motivo en español para la bandeja", async () => {
    const store = new MemoryStore();
    store.addOutbound("wamid.OUTBOUND_FAILED_0001");
    await processWebhookPayload(fixture("status_failed"), store, OPTS);
    expect(store.messages[0]!.error).toMatchObject({ kind: "window_closed", message_es: expect.stringMatching(/24 h/) });
  });

  it("plantilla rechazada y aprobada actualizan la caché y la auditoría", async () => {
    const store = new MemoryStore();
    await processWebhookPayload(fixture("template_status_rejected"), store, OPTS);
    await processWebhookPayload(fixture("template_status_approved"), store, OPTS);
    expect(store.templates.get("1307282397617458")).toEqual({
      name: "retomar_conversacion",
      language: "es",
      status: "REJECTED",
      rejectedReason: "La variable {{1}} está al final del texto.",
    });
    expect(store.templates.get("1307282397617459")?.status).toBe("APPROVED");
    expect(store.events.filter((e) => e.type === "template.status")).toHaveLength(2);
  });
});

describe("fase 3 · disparo del agente", () => {
  it("una ráfaga de mensajes programa una sola respuesta; las reacciones no la disparan", async () => {
    const store = new MemoryStore();
    for (const f of ["text", "location", "reaction"]) await processWebhookPayload(fixture(f), store, OPTS);
    expect(store.agentRuns.size).toBe(1);
  });
  it("con multimedia espera más (descarga/transcripción)", async () => {
    const store = new MemoryStore();
    await processWebhookPayload(fixture("audio_voice"), store, OPTS);
    expect([...store.agentRuns.values()][0]).toBeGreaterThan(6);
  });
  it("no programa nada si el agente está pausado", async () => {
    const store = new MemoryStore();
    await processWebhookPayload(fixture("text"), store, OPTS);
    const convId = [...store.conversations.keys()][0]!;
    store.agentRuns.clear();
    store.agentPaused.add(convId);
    const s = await processWebhookPayload(fixture("image"), store, OPTS);
    expect(s.agentScheduled).toBe(0);
  });
});

describe("fase 5 · notificaciones push", () => {
  it("mensaje en conversación atendida por el equipo → trabajo push_notify (una vez por wamid)", async () => {
    const store = new MemoryStore();
    await processWebhookPayload(fixture("text"), store, OPTS);
    const conv = [...store.conversations.values()][0]!;
    expect(store.jobs.filter((j) => j.type === "push_notify")).toHaveLength(0); // con el asistente: no se avisa
    conv.status = "human";
    await processWebhookPayload(fixture("image"), store, OPTS);
    await processWebhookPayload(fixture("image"), store, OPTS); // reintento de Meta
    const push = store.jobs.filter((j) => j.type === "push_notify");
    expect(push).toHaveLength(1);
    expect(push[0]!.payload).toMatchObject({ kind: "message", conversationId: conv.id });
  });
  it("las reacciones no generan aviso", async () => {
    const store = new MemoryStore();
    await processWebhookPayload(fixture("text"), store, OPTS);
    [...store.conversations.values()][0]!.status = "human";
    await processWebhookPayload(fixture("reaction"), store, OPTS);
    expect(store.jobs.filter((j) => j.type === "push_notify")).toHaveLength(0);
  });
});
