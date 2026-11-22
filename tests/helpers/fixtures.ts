import { readFileSync } from "node:fs";
import path from "node:path";
import type { WebhookPayload } from "@/lib/whatsapp/types";

export function fixture(name: string): WebhookPayload {
  return JSON.parse(readFileSync(path.resolve(__dirname, "../fixtures/webhooks", `${name}.json`), "utf8"));
}

export function fixtureRaw(name: string): string {
  return readFileSync(path.resolve(__dirname, "../fixtures/webhooks", `${name}.json`), "utf8");
}
