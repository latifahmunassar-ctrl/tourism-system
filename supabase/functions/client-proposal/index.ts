/**
 * client-proposal — public read endpoint for the company-facing proposal page.
 *
 * Given the unguessable view_token, returns ONLY the sanitized client view
 * (client_program) + the single group total — and ONLY when a staff member has
 * approved & sent the request (status = 'sent'). The internal program with
 * pricing (built_program) is never selected here, so it can never be returned.
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: CORS });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });

  const url = new URL(req.url);
  let token = url.searchParams.get("token") || "";
  if (!token && req.method === "POST") {
    const b = await req.json().catch(() => ({}));
    token = String(b.token || "");
  }
  token = token.trim();
  if (!token) return json({ error: "missing token" }, 400);

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  // Select only client-safe columns — built_program is deliberately excluded.
  const { data, error } = await supabase
    .from("client_requests")
    .select("ref_no, company_name, destination, status, client_program, group_total")
    .eq("view_token", token)
    .single();

  if (error || !data) return json({ error: "not_found" }, 404);
  if (data.status !== "sent" || !data.client_program) {
    // Not approved yet (or build pending) — don't reveal anything.
    return json({ status: "pending", message: "العرض قيد التجهيز من فريقنا، نوافيك قريباً." }, 200);
  }

  return json({
    status: "ready",
    ref_no: data.ref_no,
    company_name: data.company_name,
    destination: data.destination,
    group_total: data.group_total,
    proposal: data.client_program,
  });
});
