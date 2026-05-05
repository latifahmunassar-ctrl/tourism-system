/**
 * auth-check — التحقّق من كلمة مرور التطبيق
 *
 * البيئة المطلوبة (Supabase Secrets):
 *   APP_PASSWORD → كلمة المرور المشتركة بين الموظفات
 *
 * التغيير: لتغيير كلمة السر، شغّلي على الترمنال:
 *   supabase secrets set APP_PASSWORD=الكلمة_الجديدة --project-ref ofotvacszlmrqxzfjmtn
 * أو غيّريها من Supabase Dashboard → Project Settings → Edge Functions → Secrets
 *
 * بمجرّد تغيير كلمة السر، الموظفات اللاتي عندهنّ الكلمة القديمة لن يستطعن الدخول.
 */

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Content-Type": "application/json",
};

// مقارنة آمنة من timing-attacks (constant-time)
function safeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ ok: false, error: "Method not allowed" }), {
      status: 405,
      headers: CORS_HEADERS,
    });
  }

  try {
    const { password } = await req.json();
    if (typeof password !== "string" || password.length === 0) {
      return new Response(JSON.stringify({ ok: false, error: "كلمة السر مطلوبة" }), {
        status: 400,
        headers: CORS_HEADERS,
      });
    }

    const expected = Deno.env.get("APP_PASSWORD");
    if (!expected) {
      return new Response(JSON.stringify({ ok: false, error: "النظام غير مهيّأ" }), {
        status: 500,
        headers: CORS_HEADERS,
      });
    }

    if (safeEquals(password, expected)) {
      return new Response(JSON.stringify({ ok: true }), { headers: CORS_HEADERS });
    } else {
      return new Response(JSON.stringify({ ok: false, error: "كلمة سر غير صحيحة" }), {
        status: 401,
        headers: CORS_HEADERS,
      });
    }
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: e.message }), {
      status: 500,
      headers: CORS_HEADERS,
    });
  }
});
