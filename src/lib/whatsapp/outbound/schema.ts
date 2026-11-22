import { z } from "zod";

/**
 * Contenido saliente independiente de Meta, validado con los límites oficiales
 * (developers.facebook.com → WhatsApp → Messages → interactive reply buttons / list messages):
 *  - Botones: 1–3, título ≤ 20 car., único, sin espacios al inicio/fin; id ≤ 256.
 *  - Listas: botón ≤ 20, 1–10 secciones, ≤ 10 filas EN TOTAL, título fila/sección ≤ 24,
 *    descripción ≤ 72, id fila ≤ 200 (único).
 *  - Cabecera de texto ≤ 60, pie ≤ 60. Texto libre ≤ 4096. Cuerpo interactivo ≤ 1024.
 */
export const LIMITS = {
  textBody: 4096,
  interactiveBody: 1024,
  header: 60,
  footer: 60,
  buttons: 3,
  buttonTitle: 20,
  buttonId: 256,
  listButton: 20,
  listSections: 10,
  listRowsTotal: 10,
  rowTitle: 24,
  rowDescription: 72,
  rowId: 200,
  sectionTitle: 24,
  caption: 1024,
  filename: 240,
} as const;

const trimmed = (max: number, label: string) =>
  z
    .string()
    .transform((s) => s.trim())
    .pipe(z.string().min(1, `${label}: no puede estar vacío`).max(max, `${label}: máximo ${max} caracteres`));

const optionalTrimmed = (max: number, label: string) =>
  z
    .string()
    .transform((s) => s.trim())
    .pipe(z.string().max(max, `${label}: máximo ${max} caracteres`))
    .optional()
    .transform((s) => (s ? s : undefined));

/** Origen de la media saliente: archivo en Storage (lo normal), id ya subido a Meta o URL pública. */
export const mediaRefSchema = z.union([
  z.object({ storagePath: z.string().regex(/^outbound\/[A-Za-z0-9/_\-.]+$/, "Ruta de Storage no válida (debe empezar por outbound/)") }),
  z.object({ waMediaId: z.string().regex(/^\d+$/) }),
  z.object({ link: z.string().url().startsWith("https://", "La URL debe ser https") }),
]);
export type MediaRef = z.infer<typeof mediaRefSchema>;

export const textSchema = z.object({
  type: z.literal("text"),
  body: trimmed(LIMITS.textBody, "Texto"),
  previewUrl: z.boolean().optional(),
});

export const buttonsSchema = z
  .object({
    type: z.literal("buttons"),
    body: trimmed(LIMITS.interactiveBody, "Mensaje"),
    header: optionalTrimmed(LIMITS.header, "Cabecera"),
    footer: optionalTrimmed(LIMITS.footer, "Pie"),
    buttons: z
      .array(z.object({ id: trimmed(LIMITS.buttonId, "Id de botón"), title: trimmed(LIMITS.buttonTitle, "Botón") }))
      .min(1, "Añade al menos un botón")
      .max(LIMITS.buttons, `Máximo ${LIMITS.buttons} botones`),
  })
  .superRefine((v, ctx) => {
    const titles = v.buttons.map((b) => b.title.toLowerCase());
    if (new Set(titles).size !== titles.length) ctx.addIssue({ code: "custom", message: "Los títulos de los botones deben ser distintos" });
    const ids = v.buttons.map((b) => b.id);
    if (new Set(ids).size !== ids.length) ctx.addIssue({ code: "custom", message: "Los ids de los botones deben ser distintos" });
  });

export const listSchema = z
  .object({
    type: z.literal("list"),
    body: trimmed(LIMITS.textBody, "Mensaje"),
    header: optionalTrimmed(LIMITS.header, "Cabecera"),
    footer: optionalTrimmed(LIMITS.footer, "Pie"),
    buttonText: trimmed(LIMITS.listButton, "Texto del botón de la lista"),
    sections: z
      .array(
        z.object({
          title: optionalTrimmed(LIMITS.sectionTitle, "Título de sección"),
          rows: z
            .array(
              z.object({
                id: trimmed(LIMITS.rowId, "Id de opción"),
                title: trimmed(LIMITS.rowTitle, "Opción"),
                description: optionalTrimmed(LIMITS.rowDescription, "Descripción"),
              }),
            )
            .min(1, "Cada sección necesita al menos una opción"),
        }),
      )
      .min(1)
      .max(LIMITS.listSections, `Máximo ${LIMITS.listSections} secciones`),
  })
  .superRefine((v, ctx) => {
    const rows = v.sections.flatMap((s) => s.rows);
    if (rows.length > LIMITS.listRowsTotal) ctx.addIssue({ code: "custom", message: `Máximo ${LIMITS.listRowsTotal} opciones en total` });
    if (new Set(rows.map((r) => r.id)).size !== rows.length) ctx.addIssue({ code: "custom", message: "Los ids de las opciones deben ser distintos" });
    if (v.sections.length > 1 && v.sections.some((s) => !s.title))
      ctx.addIssue({ code: "custom", message: "Con varias secciones, todas necesitan título" });
  });

export const imageSchema = z.object({
  type: z.literal("image"),
  media: mediaRefSchema,
  caption: optionalTrimmed(LIMITS.caption, "Pie de foto"),
});

export const documentSchema = z.object({
  type: z.literal("document"),
  media: mediaRefSchema,
  caption: optionalTrimmed(LIMITS.caption, "Descripción"),
  filename: optionalTrimmed(LIMITS.filename, "Nombre de archivo"),
});

/** Parámetros de plantilla en forma sencilla; se traducen a components de Meta. */
export const templateSchema = z.object({
  type: z.literal("template"),
  name: z.string().regex(/^[a-z0-9_]{1,512}$/, "Nombre de plantilla no válido"),
  language: z.string().regex(/^[a-z]{2,3}(_[A-Z]{2})?$/, "Idioma no válido (p. ej. es o es_ES)"),
  /** Variables del cuerpo: lista ordenada ({{1}}, {{2}}…) u objeto para parámetros con nombre. */
  body: z.union([z.array(z.string().min(1)), z.record(z.string(), z.string().min(1))]).optional(),
  /** Cabecera: texto con variable, o media (imagen/documento). */
  header: z
    .union([
      z.object({ type: z.literal("text"), text: z.string().min(1).max(LIMITS.header) }),
      z.object({ type: z.literal("image"), media: mediaRefSchema }),
      z.object({ type: z.literal("document"), media: mediaRefSchema, filename: z.string().max(LIMITS.filename).optional() }),
    ])
    .optional(),
  /** Sufijos de botones URL dinámicos, por índice del botón. */
  urlButtons: z.array(z.object({ index: z.number().int().min(0).max(9), suffix: z.string().min(1).max(2000) })).optional(),
});

export const outboundContentSchema = z.union([textSchema, buttonsSchema, listSchema, imageSchema, documentSchema, templateSchema]);

export type OutboundContent = z.infer<typeof outboundContentSchema>;
/** Forma de entrada (antes de validar/normalizar): la que construye el código que envía. */
export type OutboundInput = z.input<typeof outboundContentSchema>;
export type TemplateContent = z.infer<typeof templateSchema>;

export class ValidationError extends Error {
  constructor(readonly issues: string[]) {
    super(issues.join(" · "));
    this.name = "ValidationError";
  }
}

export function parseOutbound(input: unknown): OutboundContent {
  const r = outboundContentSchema.safeParse(input);
  if (r.success) return r.data;
  // Mostrar solo los errores del tipo indicado (no los de todas las ramas de la unión)
  const t = (input as { type?: string } | null)?.type;
  const byType = { text: textSchema, buttons: buttonsSchema, list: listSchema, image: imageSchema, document: documentSchema, template: templateSchema } as const;
  if (!t || !(t in byType)) throw new ValidationError(["Tipo de mensaje no válido"]);
  const specific = byType[t as keyof typeof byType].safeParse(input);
  const issues = (!specific.success ? specific.error.issues : r.error.issues).map((i) => i.message);
  throw new ValidationError(issues.length ? [...new Set(issues)] : ["Mensaje no válido"]);
}
