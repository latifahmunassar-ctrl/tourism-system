// 🛍️ Fancy Sense — نظام المصروفات والمنتجات (fancy-books.html)
// 🔐 نفس دخول نظام العز: مفتاح النظام (متغيّر بيئة سرّي) أو جلسة من acc_sessions (المالكة أو موظف عنده تبويب "fancy")
// 💾 التخزين: جدول fs_app_docs (coll, id, data jsonb) — مستند لكل مصروف/منتج + مستند meta للإعدادات والقوائم
import { createClient } from 'jsr:@supabase/supabase-js@2';

const ACCESS_KEY = Deno.env.get('FS_ACCESS_KEY') || Deno.env.get('ACC_ACCESS_KEY') || '';
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-acc-key, x-acc-token, content-type, apikey',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};
const J = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

const COLLS = new Set(['expenses', 'recurring', 'products', 'meta', 'stock_log']);
const MAX_DOC = 3_000_000;   // حد حجم المستند الواحد (مرفقات/صور مضغوطة)
const MAX_BATCH = 1500;

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  const url = new URL(req.url);
  const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

  // ===== المصادقة =====
  let who = '';
  const key = req.headers.get('x-acc-key') || '';
  if (ACCESS_KEY && key === ACCESS_KEY) who = 'المالكة';
  if (!who) {
    const tok = req.headers.get('x-acc-token') || '';
    if (tok) {
      const { data: s } = await db.from('acc_sessions').select('expires_at,is_owner,allowed_tabs,staff_name').eq('token', tok).maybeSingle();
      if (s && (!s.expires_at || new Date(s.expires_at).getTime() > Date.now())) {
        const tabs = Array.isArray(s.allowed_tabs) ? s.allowed_tabs : [];
        if (s.is_owner || tabs.includes('fancy')) who = s.staff_name || (s.is_owner ? 'المالكة' : 'موظف');
      }
    }
  }
  if (!who) return J({ error: 'unauthorized' }, 401);

  // ===== GET: كل المستندات (أو المتغيّرة منذ since) =====
  if (req.method === 'GET') {
    const since = url.searchParams.get('since');
    const out: any[] = [];
    const page = 1000;
    for (let from = 0; ; from += page) {
      let q = db.from('fs_app_docs').select('coll,id,data,deleted,updated_at').order('updated_at', { ascending: true }).range(from, from + page - 1);
      q = since ? q.gt('updated_at', since) : q.eq('deleted', false);
      const { data, error } = await q;
      if (error) return J({ error: error.message }, 500);
      out.push(...(data || []));
      if (!data || data.length < page) break;
    }
    return J({ user: who, now: new Date().toISOString(), docs: out });
  }

  // ===== POST: حفظ / حذف =====
  if (req.method === 'POST') {
    let body: any;
    try { body = await req.json(); } catch { return J({ error: 'bad json' }, 400); }
    if (body.action === 'whoami') return J({ user: who });
    const now = new Date().toISOString();
    if (body.action === 'put') {
      const docs = Array.isArray(body.docs) ? body.docs : [];
      if (docs.length > MAX_BATCH) return J({ error: 'too many docs' }, 400);
      const rows = [];
      for (const d of docs) {
        if (!COLLS.has(d?.coll) || typeof d?.id !== 'string' || !d.id || d.id.length > 80) return J({ error: 'bad doc' }, 400);
        if (JSON.stringify(d.data ?? null).length > MAX_DOC) return J({ error: 'doc too large: ' + d.id }, 413);
        rows.push({ coll: d.coll, id: d.id, data: d.data, deleted: false, updated_at: now, updated_by: who });
      }
      for (let i = 0; i < rows.length; i += 500) {
        const { error } = await db.from('fs_app_docs').upsert(rows.slice(i, i + 500), { onConflict: 'coll,id' });
        if (error) return J({ error: error.message }, 500);
      }
      return J({ ok: true, n: rows.length, now });
    }
    if (body.action === 'del') {
      const items = Array.isArray(body.items) ? body.items : [];
      if (items.length > MAX_BATCH) return J({ error: 'too many' }, 400);
      for (const it of items) {
        if (!COLLS.has(it?.coll) || typeof it?.id !== 'string') return J({ error: 'bad item' }, 400);
        const { error } = await db.from('fs_app_docs').update({ deleted: true, data: {}, updated_at: now, updated_by: who }).eq('coll', it.coll).eq('id', it.id);
        if (error) return J({ error: error.message }, 500);
      }
      return J({ ok: true, n: items.length, now });
    }
    return J({ error: 'unknown action' }, 400);
  }
  return J({ error: 'method' }, 405);
});
