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
  // امنع المتصفح من تخزين استرجاع البرنامج بالكود، وإلا يعرض نسخة قديمة بعد أي
  // تعديل على البرنامج المحفوظ (كان يطلّع عدد أشخاص/طيران قديم رغم تحديث القاعدة).
  "Cache-Control": "no-store, no-cache, must-revalidate",
};

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: CORS_HEADERS });
}

function sanitizeCodeQuery(code: string): string {
  return String(code ?? "").trim();
}

/** يطابق عمود CLIENT_CODE في نص البرنامج (مثل ALZ-2026-001) */
function extractClientCodeFromRaw(raw: string): string {
  const m = String(raw).match(/^\s*CLIENT_CODE:\s*(.+)$/im);
  return m ? String(m[1]).trim() : "";
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
      const code = sanitizeCodeQuery(url.searchParams.get("code") || "");
      if (!code) return json(400, { error: "code مطلوب" });
      const safeLike = code.replace(/[%_\\]/g, "");

      const fields =
        "code,client_code,destination,raw,pdf_variant,total_group,persons,created_at";

      const bySystem = await supabase
        .from("programs")
        .select(fields)
        .eq("code", code)
        .maybeSingle();

      if (bySystem.error) return json(500, { error: bySystem.error.message });
      if (bySystem.data) return json(200, { ok: true, program: bySystem.data });

      if (safeLike.length > 0) {
        const byClient = await supabase
          .from("programs")
          .select(fields)
          .not("client_code", "is", null)
          .ilike("client_code", safeLike)
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();

        if (byClient.error) return json(500, { error: byClient.error.message });
        if (byClient.data) return json(200, { ok: true, program: byClient.data });

        // احتياط للسجلات القديمة قبل إضافة العمود: البحث داخل RAW
        const { data: byRaw, error: rawErr } = await supabase
          .from("programs")
          .select(fields)
          .ilike("raw", `%CLIENT_CODE:${safeLike}%`)
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();

        if (rawErr) return json(500, { error: rawErr.message });
        if (byRaw) return json(200, { ok: true, program: byRaw });
      }

      return json(404, {
        error:
          "البرنامج غير محفوظ أو الكود مختلف. احفظيه أولًا بتصدير PDF، أو ابحثي بكود النظام (مثل MY-2026-001). لاستخدام كود العميل (CLIENT_CODE مثل ALZ-2026-001) تأكدي أنّ البرنامج حُفظ بعد هذا التحديث أو أنّ السطر CLIENT_CODE موجود في النص المحفوظ.",
      });
    }

    if (req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      const raw = String(body.raw || "").trim();
      const destination = String(body.destination || "").trim();
      const pdfVariant = String(body.pdf_variant || "client").trim();
      const totalGroup = Number(body.total_group);
      const persons = Number(body.persons);
      // اسم الموظفة اللي صدّرت الـPDF (من alezz_staff_name بالمتصفح) — لتتبّع التصدير.
      const createdBy = String(body.created_by || "").trim().slice(0, 120) || null;

      if (!raw) return json(400, { error: "raw مطلوب" });
      if (!destination) return json(400, { error: "destination مطلوب" });

      const prefix = inferPrefix(destination);
      const { data: codeData, error: codeErr } = await supabase
        .rpc("next_program_code", { p_prefix: prefix });

      if (codeErr) return json(500, { error: codeErr.message });

      const code = String(codeData || "").trim();
      if (!code) return json(500, { error: "فشل توليد الكود" });

      const clientCode = extractClientCodeFromRaw(raw) || null;

      const { error: insErr } = await supabase.from("programs").insert({
        code,
        client_code: clientCode,
        destination,
        raw,
        pdf_variant: pdfVariant,
        total_group: Number.isFinite(totalGroup) ? totalGroup : null,
        persons: Number.isFinite(persons) ? persons : null,
        created_by: createdBy,
      });

      if (insErr) return json(500, { error: insErr.message });
      return json(200, { ok: true, code, client_code: clientCode });
    }

    return json(405, { error: "Method not allowed" });
  } catch (e) {
    return json(500, { error: (e as Error).message });
  }
});

