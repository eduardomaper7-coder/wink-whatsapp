import { describe, expect, it } from "vitest";
import { buildMessagePayload, previewOf, renderTemplateText } from "@/lib/whatsapp/outbound/payload";
import { parseOutbound, ValidationError } from "@/lib/whatsapp/outbound/schema";

const TO = "34612345678";
const build = (c: unknown, extra = {}) => buildMessagePayload(parseOutbound(c), { to: TO, callbackRef: "ref-1", ...extra });

describe("payloads de envío (formato de POST /messages)", () => {
  it("texto, con referencia interna y respuesta citada", () => {
    expect(build({ type: "text", body: "  Hola Lucía  " }, { replyToWaMessageId: "wamid.X" })).toEqual({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: TO,
      biz_opaque_callback_data: "ref-1",
      context: { message_id: "wamid.X" },
      type: "text",
      text: { body: "Hola Lucía", preview_url: false },
    });
  });

  it("botones interactivos (máx. 3)", () => {
    const p = build({
      type: "buttons",
      body: "¿Qué hueco te viene mejor para la visita?",
      footer: "Wink · Arquitectura e interiorismo",
      buttons: [
        { id: "slot_1", title: "Lun 24, 10:00" },
        { id: "slot_2", title: "Mar 25, 16:30" },
        { id: "slot_none", title: "Ninguno me va" },
      ],
    }) as { interactive: Record<string, unknown> };
    expect(p.interactive).toEqual({
      type: "button",
      body: { text: "¿Qué hueco te viene mejor para la visita?" },
      footer: { text: "Wink · Arquitectura e interiorismo" },
      action: {
        buttons: [
          { type: "reply", reply: { id: "slot_1", title: "Lun 24, 10:00" } },
          { type: "reply", reply: { id: "slot_2", title: "Mar 25, 16:30" } },
          { type: "reply", reply: { id: "slot_none", title: "Ninguno me va" } },
        ],
      },
    });
  });

  it("lista con secciones", () => {
    const p = build({
      type: "list",
      body: "¿Qué tipo de proyecto tienes en mente?",
      buttonText: "Ver opciones",
      sections: [
        { title: "Reformas", rows: [{ id: "reforma_integral", title: "Reforma integral", description: "Toda la vivienda" }, { id: "reforma_parcial", title: "Reforma parcial" }] },
        { title: "Otros", rows: [{ id: "interiorismo", title: "Interiorismo" }] },
      ],
    }) as { interactive: { action: { button: string; sections: unknown[] } } };
    expect(p.interactive.action.button).toBe("Ver opciones");
    expect(p.interactive.action.sections[0]).toEqual({
      title: "Reformas",
      rows: [{ id: "reforma_integral", title: "Reforma integral", description: "Toda la vivienda" }, { id: "reforma_parcial", title: "Reforma parcial" }],
    });
  });

  it("imagen y documento usan el id de media subido", () => {
    expect(build({ type: "image", media: { storagePath: "outbound/c/1.jpg" }, caption: "Referencia" }, { media: { id: "999" } })).toMatchObject({
      type: "image",
      image: { id: "999", caption: "Referencia" },
    });
    expect(build({ type: "document", media: { waMediaId: "123" }, filename: "Dossier Wink.pdf" }, { media: { id: "123" } })).toMatchObject({
      type: "document",
      document: { id: "123", filename: "Dossier Wink.pdf" },
    });
  });

  it("plantilla con variables posicionales, cabecera y botón URL", () => {
    const p = build({
      type: "template",
      name: "recordatorio_visita",
      language: "es",
      header: { type: "text", text: "Lucía" },
      body: ["Lucía", "lunes 24 a las 10:00"],
      urlButtons: [{ index: 0, suffix: "abc123" }],
    }) as { template: unknown };
    expect(p.template).toEqual({
      name: "recordatorio_visita",
      language: { code: "es" },
      components: [
        { type: "header", parameters: [{ type: "text", text: "Lucía" }] },
        { type: "body", parameters: [{ type: "text", text: "Lucía" }, { type: "text", text: "lunes 24 a las 10:00" }] },
        { type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: "abc123" }] },
      ],
    });
  });

  it("plantilla con parámetros con nombre y sin variables", () => {
    const named = build({ type: "template", name: "retomar", language: "es_ES", body: { nombre: "Lucía" } }) as { template: { components: unknown[] } };
    expect(named.template.components[0]).toEqual({ type: "body", parameters: [{ type: "text", parameter_name: "nombre", text: "Lucía" }] });
    const plain = build({ type: "template", name: "hello_world", language: "en_US" }) as { template: Record<string, unknown> };
    expect(plain.template).toEqual({ name: "hello_world", language: { code: "en_US" } });
  });
});

describe("validación con los límites de Meta", () => {
  const issues = (c: unknown) => {
    try {
      parseOutbound(c);
      return [];
    } catch (e) {
      return (e as ValidationError).issues;
    }
  };
  it("más de 3 botones, títulos > 20, títulos repetidos", () => {
    const four = [1, 2, 3, 4].map((i) => ({ id: `b${i}`, title: `B${i}` }));
    expect(issues({ type: "buttons", body: "x", buttons: four })).toContain("Máximo 3 botones");
    expect(issues({ type: "buttons", body: "x", buttons: [{ id: "a", title: "Un título demasiado largo" }] })[0]).toMatch(/máximo 20/);
    expect(issues({ type: "buttons", body: "x", buttons: [{ id: "a", title: "Sí" }, { id: "b", title: "sí" }] })).toContain("Los títulos de los botones deben ser distintos");
  });
  it("lista: más de 10 filas en total entre secciones", () => {
    const rows = (n: number, p: string) => Array.from({ length: n }, (_, i) => ({ id: `${p}${i}`, title: `Opción ${p}${i}` }));
    expect(issues({ type: "list", body: "x", buttonText: "Ver", sections: [{ title: "A", rows: rows(6, "a") }, { title: "B", rows: rows(5, "b") }] })).toContain(
      "Máximo 10 opciones en total",
    );
  });
  it("texto vacío y texto demasiado largo", () => {
    expect(issues({ type: "text", body: "   " })[0]).toMatch(/vacío/);
    expect(issues({ type: "text", body: "a".repeat(4097) })[0]).toMatch(/4096/);
  });
  it("ruta de Storage fuera de outbound/ y URL no https", () => {
    expect(issues({ type: "image", media: { storagePath: "conv/2026/11/x.jpg" } }).length).toBeGreaterThan(0);
    expect(issues({ type: "image", media: { link: "http://x.com/a.jpg" } }).length).toBeGreaterThan(0);
  });
  it("tipo desconocido", () => {
    expect(issues({ type: "sticker" })).toEqual(["Tipo de mensaje no válido"]);
  });
});

describe("vista previa", () => {
  it("sustituye variables de plantilla", () => {
    expect(renderTemplateText("Hola {{1}}, tu visita es el {{2}}.", ["Lucía", "lunes"])).toBe("Hola Lucía, tu visita es el lunes.");
    expect(renderTemplateText("Hola {{nombre}}", { nombre: "Lucía" })).toBe("Hola Lucía");
    expect(renderTemplateText("Hola {{1}} {{3}}", ["A"])).toBe("Hola A {{3}}");
  });
  it("vista previa de botones", () => {
    expect(previewOf(parseOutbound({ type: "buttons", body: "¿Te va bien?", buttons: [{ id: "s", title: "Sí" }, { id: "n", title: "No" }] }))).toBe("¿Te va bien?\n[Sí] [No]");
  });
});
