/**
 * programs — حفظ واسترجاع البرامج السياحية عبر كود فريد
 *
 * Endpoints:
 * - POST  /functions/v1/programs  { raw, destination, pdf_variant, total_group, persons }
 * - GET   /functions/v1/programs?code=VN-2026-001
 *
 * Secrets المطلوبة:
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Content-Type": "application/json",
};

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: CORS_HEADERS });
}

function inferPrefix(destinationRaw: string): string {
  const d = (destinationRaw || "").trim().toLowerCase();
  const map: Array<[RegExp, string]> = [
    [/فيتنام|vietnam/i, "VN"],
    [/ماليزيا|malaysia/i, "MY"],
    [/اندونيسيا|إندونيسيا|indonesia/i, "ID"],
    [/تركيا|turky|turkey/i, "TR"],
    [/روسيا|russia/i, "RU"],
    [/البوسنة|bosnia/i, "BA"],
    [/تايلاند|thailand/i, "TH"],
  ];
  for (const [re, pref] of map) if (re.test(d)) return pref;
  return (destinationRaw || "XX").replace(/[^A-Za-z]/g, "").slice(0, 2).toUpperCase() || "XX";
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  try {
    const url = new URL(req.url);

    if (req.method === "GET") {
      const code = (url.searchParams.get("code") || "").trim();
      if (!code) return json(400, { error: "code مطلوب" });

      const { data, error } = await supabase
        .from("programs")
        .select("code,destination,raw,pdf_variant,total_group,persons,created_at")
        .eq("code", code)
        .maybeSingle();

      if (error) return json(500, { error: error.message });
      if (!data) return json(404, { error: "البرنامج غير موجود" });
      return json(200, { ok: true, program: data });
    }

    if (req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      const raw = String(body.raw || "").trim();
      const destination = String(body.destination || "").trim();
      const pdfVariant = String(body.pdf_variant || "client").trim();
      const totalGroup = Number(body.total_group);
      const persons = Number(body.persons);

      if (!raw) return json(400, { error: "raw مطلوب" });
      if (!destination) return json(400, { error: "destination مطلوب" });

      const prefix = inferPrefix(destination);
      const { data: codeData, error: codeErr } = await supabase
        .rpc("next_program_code", { p_prefix: prefix });

      if (codeErr) return json(500, { error: codeErr.message });

      const code = String(codeData || "").trim();
      if (!code) return json(500, { error: "فشل توليد الكود" });

      const { error: insErr } = await supabase.from("programs").insert({
        code,
        destination,
        raw,
        pdf_variant: pdfVariant,
        total_group: Number.isFinite(totalGroup) ? totalGroup : null,
        persons: Number.isFinite(persons) ? persons : null,
      });

      if (insErr) return json(500, { error: insErr.message });
      return json(200, { ok: true, code });
    }

    return json(405, { error: "Method not allowed" });
  } catch (e) {
    return json(500, { error: (e as Error).message });
  }
});

