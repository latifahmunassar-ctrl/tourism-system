/**
 * webauthn — تسجيل ودخول الموظفات بمفاتيح المرور (Passkey / بصمة / Face ID)
 *
 * الإجراءات (body.action):
 *   register     {name, phone}                  → إنشاء حساب pending (تسجيل ذاتي)
 *   reg_start    {phone}                         → خيارات تسجيل بصمة (لمستخدم مُعتمد)
 *   reg_finish   {phone, challengeId, response}  → التحقّق وحفظ المفتاح
 *   auth_start   {phone?}                        → خيارات دخول بالبصمة
 *   auth_finish  {challengeId, response}         → التحقّق وإرجاع نجاح الدخول
 *
 * RP: madartrip.com  (origin: https://madartrip.com)
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from "https://esm.sh/@simplewebauthn/server@13";

const RP_ID = "madartrip.com";
const RP_NAME = "Madar Trip";
const ORIGIN = "https://madartrip.com";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Content-Type": "application/json",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: CORS_HEADERS });

function b64url(buf: ArrayBuffer | Uint8Array): string {
  const b = new Uint8Array(buf as ArrayBuffer);
  let s = ""; for (const c of b) s += String.fromCharCode(c);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function unb64url(s: string): Uint8Array {
  s = s.replace(/-/g, "+").replace(/_/g, "/"); while (s.length % 4) s += "=";
  const bin = atob(s); const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u;
}
const normPhone = (p: string) => String(p || "").replace(/[\s\-()]/g, "").trim();

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const supa = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  try {
    const body = await req.json();
    const action = String(body.action || "");

    // ── تسجيل ذاتي: إنشاء حساب pending ──
    if (action === "register") {
      const name = String(body.name || "").trim();
      const phone = normPhone(body.phone);
      if (!name) return json({ error: "الاسم مطلوب" }, 400);
      if (phone.length < 7) return json({ error: "رقم جوال غير صالح" }, 400);
      const { data: dup } = await supa.from("app_users").select("id, status").eq("phone", phone).maybeSingle();
      if (dup) return json({ ok: true, status: dup.status, already: true });
      const { error } = await supa.from("app_users").insert({ name, phone, status: "pending" });
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true, status: "pending" });
    }

    // ── بدء تسجيل البصمة (للمستخدم المُعتمد active) ──
    if (action === "reg_start") {
      const phone = normPhone(body.phone);
      const { data: user } = await supa.from("app_users").select("id, name, phone, status").eq("phone", phone).maybeSingle();
      if (!user) return json({ error: "لا يوجد حساب بهذا الرقم — سجّلي أولاً" }, 404);
      if (user.status === "pending") return json({ error: "حسابك بانتظار موافقة الإدارة" }, 403);
      if (user.status !== "active") return json({ error: "الحساب موقوف" }, 403);
      const { data: existing } = await supa.from("user_passkeys").select("credential_id, transports").eq("user_id", user.id);
      const opts = await generateRegistrationOptions({
        rpName: RP_NAME, rpID: RP_ID,
        userID: new TextEncoder().encode(String(user.id)),
        userName: user.phone, userDisplayName: user.name,
        attestationType: "none",
        excludeCredentials: (existing || []).map((c: any) => ({ id: c.credential_id, transports: c.transports ? c.transports.split(",") : undefined })),
        authenticatorSelection: { residentKey: "preferred", userVerification: "preferred" },
      });
      const challengeId = crypto.randomUUID();
      await supa.from("webauthn_challenges").insert({ id: challengeId, user_id: user.id, challenge: opts.challenge, kind: "reg", expires_at: new Date(Date.now() + 300000).toISOString() });
      return json({ ok: true, challengeId, options: opts });
    }

    // ── إنهاء تسجيل البصمة ──
    if (action === "reg_finish") {
      const phone = normPhone(body.phone);
      const challengeId = String(body.challengeId || "");
      const { data: ch } = await supa.from("webauthn_challenges").select("*").eq("id", challengeId).maybeSingle();
      if (!ch || ch.kind !== "reg" || new Date(ch.expires_at) < new Date()) return json({ error: "انتهت صلاحية الطلب، حاولي مجدداً" }, 400);
      const { data: user } = await supa.from("app_users").select("id").eq("phone", phone).maybeSingle();
      if (!user || user.id !== ch.user_id) return json({ error: "تعذّر التحقّق" }, 400);
      let verification;
      try {
        verification = await verifyRegistrationResponse({ response: body.response, expectedChallenge: ch.challenge, expectedOrigin: ORIGIN, expectedRPID: RP_ID });
      } catch (e) { return json({ error: "فشل التحقّق: " + (e as Error).message }, 400); }
      await supa.from("webauthn_challenges").delete().eq("id", challengeId);
      if (!verification.verified || !verification.registrationInfo) return json({ error: "لم يُقبل المفتاح" }, 400);
      const cred = verification.registrationInfo.credential;
      const { error } = await supa.from("user_passkeys").insert({
        user_id: user.id, credential_id: cred.id, public_key: b64url(cred.publicKey),
        counter: cred.counter || 0, transports: (cred.transports || []).join(","),
        device_label: String(body.device_label || "").slice(0, 80) || null,
      });
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }

    // ── بدء الدخول بالبصمة ──
    if (action === "auth_start") {
      const phone = normPhone(body.phone);
      let allow: any[] = [];
      let userId: number | null = null;
      if (phone) {
        const { data: user } = await supa.from("app_users").select("id, status").eq("phone", phone).maybeSingle();
        if (!user) return json({ error: "لا يوجد حساب بهذا الرقم" }, 404);
        if (user.status !== "active") return json({ error: "الحساب غير مفعّل" }, 403);
        userId = user.id;
        const { data: keys } = await supa.from("user_passkeys").select("credential_id, transports").eq("user_id", user.id);
        if (!keys || !keys.length) return json({ error: "لا توجد بصمة مسجّلة لهذا الحساب" }, 404);
        allow = keys.map((c: any) => ({ id: c.credential_id, transports: c.transports ? c.transports.split(",") : undefined }));
      }
      const opts = await generateAuthenticationOptions({ rpID: RP_ID, allowCredentials: allow, userVerification: "preferred" });
      const challengeId = crypto.randomUUID();
      await supa.from("webauthn_challenges").insert({ id: challengeId, user_id: userId, challenge: opts.challenge, kind: "auth", expires_at: new Date(Date.now() + 300000).toISOString() });
      return json({ ok: true, challengeId, options: opts });
    }

    // ── إنهاء الدخول بالبصمة ──
    if (action === "auth_finish") {
      const challengeId = String(body.challengeId || "");
      const { data: ch } = await supa.from("webauthn_challenges").select("*").eq("id", challengeId).maybeSingle();
      if (!ch || ch.kind !== "auth" || new Date(ch.expires_at) < new Date()) return json({ error: "انتهت صلاحية الطلب، حاولي مجدداً" }, 400);
      const credId = String(body.response?.id || "");
      const { data: key } = await supa.from("user_passkeys").select("*").eq("credential_id", credId).maybeSingle();
      if (!key) return json({ error: "بصمة غير معروفة" }, 404);
      const { data: user } = await supa.from("app_users").select("id, name, phone, status").eq("id", key.user_id).maybeSingle();
      if (!user || user.status !== "active") return json({ error: "الحساب غير مفعّل" }, 403);
      let verification;
      try {
        verification = await verifyAuthenticationResponse({
          response: body.response, expectedChallenge: ch.challenge, expectedOrigin: ORIGIN, expectedRPID: RP_ID,
          credential: { id: key.credential_id, publicKey: unb64url(key.public_key), counter: Number(key.counter) || 0, transports: key.transports ? key.transports.split(",") : undefined },
        });
      } catch (e) { return json({ error: "فشل التحقّق: " + (e as Error).message }, 400); }
      await supa.from("webauthn_challenges").delete().eq("id", challengeId);
      if (!verification.verified) return json({ error: "فشل الدخول بالبصمة" }, 401);
      await supa.from("user_passkeys").update({ counter: verification.authenticationInfo.newCounter, last_used_at: new Date().toISOString() }).eq("id", key.id);
      await supa.from("app_users").update({ last_login_at: new Date().toISOString() }).eq("id", user.id);
      // المستخدم أثبت هويته بالبصمة → نسلّمه مفتاح صندوق الطلبات تلقائياً
      // (نفس CLIENT_ADMIN_SECRET) فلا يُطلب منه إدخاله يدوياً.
      return json({ ok: true, user: { name: user.name, phone: user.phone }, admin_secret: Deno.env.get("CLIENT_ADMIN_SECRET") || "" });
    }

    return json({ error: "unknown action" }, 400);
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
