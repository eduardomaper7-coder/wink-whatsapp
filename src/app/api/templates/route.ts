import { NextResponse, type NextRequest } from "next/server";
import { errorResponse } from "@/lib/api/respond";
import { requireTeamMember } from "@/lib/auth/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { listApprovedTemplates } from "@/lib/whatsapp/outbound/templates";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Plantillas aprobadas con las variables que hay que rellenar. */
export async function GET(req: NextRequest) {
  try {
    await requireTeamMember(req);
    return NextResponse.json({ templates: await listApprovedTemplates(supabaseAdmin()) });
  } catch (e) {
    return errorResponse(e);
  }
}
