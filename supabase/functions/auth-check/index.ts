/**
 * auth-check — التحقّق من كلمة مرور داشبورد البرامج + طبقة أمان (دولة + سجل دخول)
 *
 * البيئة المطلوبة (Supabase Secrets):
 *   APP_PASSWORD            → كلمة المرور المشتركة (مؤقتة أثناء التحويل)
 *   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY → للوصول لجداول الأمان والسجل
 *
 * منطق الأمان (مرحلة ١):
 *   • يكشف دولة الـIP ويسجّل كل محاولة في auth_log.
 *   • يحظر الدخول من خارج الدول المسموحة فقط إذا enforce_country=true
 *     في جدول security_settings (افتراضياً false = «وضع المراقبة» بلا حظر).
 *   • لتغيير كلمة السر: supabase secrets set APP_PASSWORD=... --project-ref ofotvacszlmrqxzfjmtn
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Content-Type": "application/json",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: CORS_HEADERS });
}

// مقارنة آمنة من timing-attacks (constant-time)
function safeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return result === 0;
}

function clientIP(req: Request): string {
  const xff = req.headers.get("x-forwarded-for") || "";
  const first = xff.split(",")[0].trim();
  return first || req.headers.get("x-real-ip") || "";
}

function isPrivateIP(ip: string): boolean {
  return !ip || /^(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::1$|fc|fd|localhost)/i.test(ip);
}

// كشف الدولة عبر ipwho.is (مجاني، https، بلا مفتاح). يرجّع رمز ISO-2 أو null.
async function lookupCountry(ip: string): Promise<{ code: string | null; note: string }> {
  if (isPrivateIP(ip)) return { code: null, note: "private_ip" };
  try {
    const r = await fetch(`https://ipwho.is/${encodeURIComponent(ip)}?fields=success,country_code`, {
      signal: AbortSignal.timeout(4000),
    });
    const j = await r.json();
    if (j && j.success && j.country_code) return { code: String(j.country_code).toUpperCase(), note: "ok" };
    return { code: null, note: "geo_no_result" };
  } catch (_e) {
    return { code: null, note: "geo_error" };
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);

  const ip = clientIP(req);
  const ua = req.headers.get("user-agent") || "";
  const supa = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const logAttempt = async (row: Record<string, unknown>) => {
    try { await supa.from("auth_log").insert(row); } catch (_e) { /* السجل best-effort */ }
  };

  try {
    const body = await req.json();
    const password = body?.password;
    const deviceToken = typeof body?.device_token === "string" ? body.device_token.trim() : "";
    const source = typeof body?.source === "string" ? body.source.trim() : "";
    if (typeof password !== "string" || password.length === 0) {
      return json({ ok: false, error: "كلمة السر مطلوبة" }, 400);
    }

    const expected = Deno.env.get("APP_PASSWORD");
    if (!expected) return json({ ok: false, error: "النظام غير مهيّأ" }, 500);
    const passOk = safeEquals(password, expected);

    // كشف الدولة + تحميل الإعدادات والقائمة + الجهاز الموثوق بالتوازي
    const [geo, settingsRes, allowedRes, deviceRes] = await Promise.all([
      lookupCountry(ip),
      supa.from("security_settings").select("enforce_country, fail_open_geo").eq("id", 1).single(),
      supa.from("security_allowed_countries").select("code"),
      deviceToken
        ? supa.from("trusted_devices").select("id, approved").eq("device_token", deviceToken).maybeSingle()
        : Promise.resolve({ data: null }),
    ]);
    const enforce = settingsRes.data?.enforce_country ?? false;
    const failOpen = settingsRes.data?.fail_open_geo ?? true;
    const allowed = (allowedRes.data || []).map((r: { code: string }) => String(r.code).toUpperCase());

    const geoKnown = !!geo.code;
    const deviceTrusted = !!(deviceRes?.data && deviceRes.data.approved);
    // الجهاز الموثوق يتخطّى حصر الدولة من أي مكان
    const countryAllowed = deviceTrusted ? true : (geoKnown ? allowed.includes(geo.code!) : failOpen);

    // تحديث آخر ظهور للجهاز الموثوق (best-effort)
    if (deviceTrusted) {
      try { await supa.from("trusted_devices").update({ last_seen: new Date().toISOString(), last_ip: ip, last_country: geo.code }).eq("device_token", deviceToken); } catch (_e) { /* */ }
    }
    const devNote = deviceTrusted ? "trusted_device" : geo.note;

    // القرار
    if (!passOk) {
      await logAttempt({ event: "login_fail", ip, country: geo.code, country_allowed: countryAllowed, success: false, user_agent: ua, detail: devNote });
      return json({ ok: false, error: "كلمة سر غير صحيحة" }, 401);
    }
    if (enforce && !countryAllowed) {
      await logAttempt({ event: geoKnown ? "blocked_country" : "geo_unknown", ip, country: geo.code, country_allowed: false, success: false, user_agent: ua, detail: devNote });
      return json({ ok: false, error: "الدخول غير مسموح من موقعك الحالي. تواصلي مع الإدارة." }, 403);
    }
    // ⛔ إنفاذ توثيق الجهاز لداشبورد الواتساب: لا دخول إلا بجهاز معتمد (حتى لو كلمة السر صحيحة).
    if (source === "whatsapp" && !deviceTrusted) {
      // أنشئ طلب توثيق معلّق إن لم يوجد سجل لهذا الجهاز، ليظهر للإدارة في companies-admin.
      if (!deviceRes?.data && deviceToken) {
        try {
          await supa.from("trusted_devices").insert({
            device_token: deviceToken, label: "جهاز جديد (واتساب) — بانتظار التوثيق", user_agent: ua,
            approved: false, source: "whatsapp", last_ip: ip, last_country: geo.code,
          });
        } catch (_e) { /* موجود مسبقاً */ }
      }
      await logAttempt({ event: "wa_device_unapproved", ip, country: geo.code, country_allowed: countryAllowed, success: false, user_agent: ua, detail: "device_pending" });
      return json({ ok: false, error: "🔒 جهازك غير معتمد بعد. أُرسل طلب توثيق للإدارة تلقائيًا — انتظري الموافقة ثم حاولي مجدداً.", device_pending: true }, 403);
    }
    // نجاح (في وضع المراقبة قد تكون الدولة غير مدرجة — نسجّلها لتظهر في اللوحة)
    await logAttempt({ event: "login_ok", ip, country: geo.code, country_allowed: countryAllowed, success: true, user_agent: ua, detail: devNote });
    return json({ ok: true, device_trusted: deviceTrusted }, 200);
  } catch (e) {
    return json({ ok: false, error: (e as Error).message }, 500);
  }
});
