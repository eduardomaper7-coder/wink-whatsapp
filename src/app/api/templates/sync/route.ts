import { NextResponse, type NextRequest } from "next/server";
import { errorResponse } from "@/lib/api/respond";
import { requireTeamMember } from "@/lib/auth/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { WhatsAppApiError } from "@/lib/whatsapp/errors";
import { syncTemplates } from "@/lib/whatsapp/outbound/templates";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Sincroniza ahora las plantillas desde Meta (solo administradores). */
export async function POST(req: NextRequest) {
  try {
    await requireTeamMember(req, { admin: true });
    return NextResponse.json(await syncTemplates(supabaseAdmin()));
  } catch (e) {
    if (e instanceof WhatsAppApiError) {
      return NextResponse.json({ error: e.info.es, code: e.code ?? null }, { status: 502 });
    }
    return errorResponse(e);
  }
}
