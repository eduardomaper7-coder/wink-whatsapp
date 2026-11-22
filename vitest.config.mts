import { defineConfig } from "vitest/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: { alias: { "@": path.resolve(root, "src") } },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    env: {
      WHATSAPP_APP_SECRET: "test_app_secret",
      WHATSAPP_VERIFY_TOKEN: "test_verify_token",
      WHATSAPP_PHONE_NUMBER_ID: "106540352242922",
      WHATSAPP_TOKEN: "EAAtesttoken",
      WHATSAPP_BUSINESS_ACCOUNT_ID: "102290129340398",
      NEXT_PUBLIC_SUPABASE_URL: "http://localhost:54321",
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon",
      SUPABASE_SERVICE_ROLE_KEY: "service",
      CRON_SECRET: "test_cron_secret",
      LOG_LEVEL: "silent",
      ANTHROPIC_API_KEY: "sk-ant-test",
      CALENDAR_PROVIDER: "demo",
      EMAIL_TRANSPORT: "log",
      BRIEFING_EMAIL_TO: "arquitecto@ejemplo.com",
      PRIVACY_POLICY_URL: "https://winkgroup.es/politica-de-privacidad",
      APP_URL: "https://wink-demo.vercel.app",
      PUSH_TRANSPORT: "log",
    },
  },
});
