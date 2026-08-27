// wa-bridge — broker between the local Baileys bridge and the tourism dashboard.
//
// Message queue table: public.outgoing_messages ("to", body, source, status).
//
// Bridge actions (require x-bridge-token = WA_BRIDGE_TOKEN secret):
//   pull        -> claim pending rows (status pending -> processing)
//   ack         -> mark a row sent/failed (status -> sent | failed)
//   sync-groups -> upsert the group list
//   heartbeat   -> update connection status
//
// Dashboard actions (anon key like the rest of the app):
//   groups      -> list groups (searchable)
//   status      -> bridge online/offline
//   enqueue     -> queue message(s): {targets:[{jid,name}]} or {to, body}
//   offers      -> list saved offers
//   save-offer  -> add a saved offer
//   delete-offer-> remove a saved offer
//   outbox      -> recent send history

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const BRIDGE_TOKEN = Deno.env.get("WA_BRIDGE_TOKEN") ?? "";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-bridge-token",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

const BRIDGE_ACTIONS = new Set(["pull", "ack", "sync-groups", "heartbeat", "next-invite-targets", "save-invite", "mark-non-admin", "sync-groups-new", "save-inbound", "next-join-targets", "save-join", "sync-groups-acct"]);
const ACCOUNT = "601111136864"; // the bridge account — groups it created (jid prefix) => admin

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  let payload: Record<string, unknown> = {};
  try { payload = await req.json(); } catch { /* empty body */ }
  const action = String(payload.action ?? "");

  if (BRIDGE_ACTIONS.has(action)) {
    const token = req.headers.get("x-bridge-token") ?? "";
    if (!BRIDGE_TOKEN || token !== BRIDGE_TOKEN) return json({ error: "unauthorized" }, 401);
  }

  try {
    switch (action) {
      // ---------- Bridge side ----------
      case "heartbeat": {
        const { data: st } = await db.from("wa_bridge_status")
          .update({
            online: payload.online !== false,
            account: payload.account ?? null,
            groups_count: payload.groups_count ?? null,
            last_heartbeat: new Date().toISOString(),
          }).eq("id", 1).select("sync_requested").single();
        return json({ ok: true, sync_requested: !!st?.sync_requested });
      }
      case "sync-groups": {
        const groups = (payload.groups ?? []) as Array<{ jid: string; name?: string; size?: number }>;
        if (groups.length) {
          // NOTE: upsert only sets jid/name/size/updated_at — it never touches
          // excluded/reviewed, so past exclusions and approvals are preserved.
          const rows = groups.map((g) => ({
            jid: g.jid, name: g.name ?? null, size: g.size ?? null, updated_at: new Date().toISOString(),
          }));
          for (let i = 0; i < rows.length; i += 500) {
            await db.from("wa_bridge_groups").upsert(rows.slice(i, i + 500), { onConflict: "jid" });
          }
        }
        // clear the on-demand sync request now that a fresh sync landed
        await db.from("wa_bridge_status").update({ sync_requested: false }).eq("id", 1);
        return json({ ok: true, count: groups.length });
      }
      case "pull": {
        const limit = Number(payload.limit ?? 5);
        const account = String(payload.account ?? "601111136864");
        const { data: pending } = await db.from("outgoing_messages")
          .select("*").eq("status", "pending").eq("account", account).lte("send_after", new Date().toISOString())
          .order("send_after", { ascending: true }).limit(limit);
        const claimed: Array<Record<string, unknown>> = [];
        for (const row of pending ?? []) {
          const { data: upd } = await db.from("outgoing_messages")
            .update({ status: "processing" }).eq("id", row.id).eq("status", "pending").select();
          if (upd && upd.length) claimed.push(upd[0]);
        }
        return json({ messages: claimed });
      }
      case "ack": {
        const id = payload.id;
        const ok = payload.ok === true;
        await db.from("outgoing_messages").update({
          status: ok ? "sent" : "failed",
          error: ok ? null : String(payload.error ?? "unknown"),
          sent_at: ok ? new Date().toISOString() : null,
        }).eq("id", id);
        return json({ ok: true });
      }

      // ---------- Dashboard side ----------
      case "groups": {
        // approved sending list only: excluded=false AND reviewed=true
        const q = String(payload.q ?? "").trim();
        let query = db.from("wa_bridge_groups").select("jid,name,size").eq("excluded", false).eq("reviewed", true).order("name", { ascending: true }).limit(50);
        if (q) query = query.ilike("name", `%${q}%`);
        const { data } = await query;
        let countQ = db.from("wa_bridge_groups").select("jid", { count: "exact", head: true }).eq("excluded", false).eq("reviewed", true);
        if (q) countQ = countQ.ilike("name", `%${q}%`);
        const { count } = await countQ;
        return json({ groups: data ?? [], total: count ?? (data?.length ?? 0) });
      }
      case "next-join-targets": {
        // groups with a harvested invite link that the NEW number hasn't joined yet
        const limit = Number(payload.limit ?? 1);
        const { data } = await db.from("wa_bridge_groups").select("jid,name,invite_link")
          .not("invite_link", "is", null).is("joined_new", null).eq("excluded", false)
          .order("size", { ascending: false, nullsFirst: false }).limit(limit);
        return json({ targets: data ?? [] });
      }
      case "save-join": {
        const jid = String(payload.jid ?? "");
        if (!jid) return json({ error: "jid required" }, 400);
        await db.from("wa_bridge_groups").update({ joined_new: String(payload.status ?? "joined") }).eq("jid", jid);
        return json({ ok: true });
      }
      case "join-progress": {
        const { count: joined } = await db.from("wa_bridge_groups").select("jid", { count: "exact", head: true }).eq("joined_new", "joined");
        const { count: remaining } = await db.from("wa_bridge_groups").select("jid", { count: "exact", head: true }).not("invite_link", "is", null).is("joined_new", null).eq("excluded", false);
        const { count: failed } = await db.from("wa_bridge_groups").select("jid", { count: "exact", head: true }).eq("joined_new", "failed");
        return json({ joined: joined ?? 0, remaining: remaining ?? 0, failed: failed ?? 0 });
      }
      case "save-inbound": {
        // a group message the owner starred (⭐ reaction) — a tourism request
        const { error } = await db.from("wa_group_requests").insert({
          account: payload.account ?? null,
          group_jid: payload.group_jid ?? null,
          group_name: payload.group_name ?? null,
          sender: payload.sender ?? null,
          sender_name: payload.sender_name ?? null,
          body: payload.body ?? null,
          matched: payload.matched ?? '⭐',
        });
        if (error) return json({ error: error.message }, 500);
        return json({ ok: true });
      }
      case "group-requests": {
        const { data } = await db.from("wa_group_requests")
          .select("*").order("created_at", { ascending: false }).limit(100);
        const newCount = (data ?? []).filter((r: Record<string, unknown>) => r.status === 'new').length;
        return json({ requests: data ?? [], new_count: newCount });
      }
      case "mark-request": {
        await db.from("wa_group_requests").update({ status: String(payload.status ?? 'handled') }).eq("id", payload.id);
        return json({ ok: true });
      }
      case "sync-groups-acct": {
        // per-account group sync for employee sender numbers
        const account = String(payload.account ?? "");
        const groups = (payload.groups ?? []) as Array<{ jid: string; name?: string; size?: number }>;
        if (account && groups.length) {
          const rows = groups.map((g) => ({ account, jid: g.jid, name: g.name ?? null, size: g.size ?? null, updated_at: new Date().toISOString() }));
          for (let i = 0; i < rows.length; i += 500) {
            await db.from("wa_account_groups").upsert(rows.slice(i, i + 500), { onConflict: "account,jid" });
          }
        }
        return json({ ok: true, count: groups.length });
      }
      case "groups-acct-all": {
        // list a specific account's groups (dashboard picker for employee numbers)
        const account = String(payload.account ?? "");
        const q = String(payload.q ?? "").trim();
        const all: unknown[] = [];
        const PAGE = 1000;
        for (let from = 0; from < 5000; from += PAGE) {
          let query = db.from("wa_account_groups").select("jid,name,size").eq("account", account).order("name", { ascending: true }).range(from, from + PAGE - 1);
          if (q) query = query.ilike("name", `%${q}%`);
          const { data, error } = await query;
          if (error) return json({ error: error.message }, 500);
          all.push(...(data ?? []));
          if (!data || data.length < PAGE) break;
        }
        return json({ groups: all });
      }
      case "sync-groups-new": {
        // groups the NEW sending number is a member of
        const groups = (payload.groups ?? []) as Array<{ jid: string; name?: string; size?: number }>;
        if (groups.length) {
          const rows = groups.map((g) => ({ jid: g.jid, name: g.name ?? null, size: g.size ?? null, updated_at: new Date().toISOString() }));
          for (let i = 0; i < rows.length; i += 500) {
            await db.from("wa_new_groups").upsert(rows.slice(i, i + 500), { onConflict: "jid" });
          }
        }
        return json({ ok: true, count: groups.length });
      }
      case "groups-new-all": {
        // full list of the NEW number's groups (for the dashboard picker)
        const q = String(payload.q ?? "").trim();
        const all: unknown[] = [];
        const PAGE = 1000;
        for (let from = 0; from < 5000; from += PAGE) {
          let query = db.from("wa_new_groups").select("jid,name,size").order("name", { ascending: true }).range(from, from + PAGE - 1);
          if (q) query = query.ilike("name", `%${q}%`);
          const { data, error } = await query;
          if (error) return json({ error: error.message }, 500);
          all.push(...(data ?? []));
          if (!data || data.length < PAGE) break;
        }
        return json({ groups: all });
      }
      case "groups-all": {
        // approved sending list (excluded=false AND reviewed=true) — paginate past
        // the PostgREST 1000-row cap so nothing is dropped.
        const q = String(payload.q ?? "").trim();
        const all: unknown[] = [];
        const PAGE = 1000;
        for (let from = 0; from < 5000; from += PAGE) {
          let query = db.from("wa_bridge_groups").select("jid,name,size").eq("excluded", false).eq("reviewed", true)
            .order("name", { ascending: true }).range(from, from + PAGE - 1);
          if (q) query = query.ilike("name", `%${q}%`);
          const { data, error } = await query;
          if (error) return json({ error: error.message }, 500);
          all.push(...(data ?? []));
          if (!data || data.length < PAGE) break;
        }
        return json({ groups: all });
      }
      case "new-groups": {
        // groups arrived since baseline, awaiting approval: reviewed=false AND excluded=false
        const { data } = await db.from("wa_bridge_groups").select("jid,name,size")
          .eq("reviewed", false).eq("excluded", false).order("updated_at", { ascending: false }).limit(500);
        return json({ groups: data ?? [] });
      }
      case "approve-group": {
        const jid = String(payload.jid ?? "");
        if (!jid) return json({ error: "jid required" }, 400);
        await db.from("wa_bridge_groups").update({ reviewed: true, excluded: false }).eq("jid", jid);
        return json({ ok: true });
      }
      case "approve-all-new": {
        await db.from("wa_bridge_groups").update({ reviewed: true }).eq("reviewed", false).eq("excluded", false);
        return json({ ok: true });
      }
      case "request-sync": {
        await db.from("wa_bridge_status").update({ sync_requested: true }).eq("id", 1);
        return json({ ok: true });
      }
      case "status": {
        const { data } = await db.from("wa_bridge_status").select("*").eq("id", 1).single();
        const last = data?.last_heartbeat ? new Date(data.last_heartbeat).getTime() : 0;
        const fresh = Date.now() - last < 90_000;
        const { count: newCount } = await db.from("wa_bridge_groups")
          .select("jid", { count: "exact", head: true }).eq("reviewed", false).eq("excluded", false);
        return json({ online: !!data?.online && fresh, account: data?.account, groups_count: data?.groups_count, last_heartbeat: data?.last_heartbeat, new_count: newCount ?? 0, sync_requested: !!data?.sync_requested });
      }
      case "enqueue": {
        // Accept multi-target {targets:[{jid,name}], body} or single {to, body}.
        // Optional throttling: batch_size targets every interval_minutes.
        const body = String(payload.body ?? "").trim();
        if (!body) return json({ error: "body required" }, 400);
        const source = String(payload.source ?? payload.created_by ?? "dashboard");
        const account = String(payload.account ?? "601111136864");
        let jids: string[] = [];
        if (Array.isArray(payload.targets) && payload.targets.length) {
          jids = (payload.targets as Array<{ jid: string }>).map((t) => t.jid).filter(Boolean);
        } else if (payload.to) {
          jids = [String(payload.to)];
        }
        if (!jids.length) return json({ error: "targets or to required" }, 400);

        const batchSize = Math.max(0, Number(payload.batch_size ?? 0));
        const intervalMin = Math.max(0, Number(payload.interval_minutes ?? 0));
        const now = Date.now();
        const rows = jids.map((jid, i) => {
          let sendAfter = new Date(now).toISOString();
          if (batchSize > 0 && intervalMin > 0) {
            const batchIndex = Math.floor(i / batchSize);
            sendAfter = new Date(now + batchIndex * intervalMin * 60_000).toISOString();
          }
          return { to: jid, body, source, account, caption: payload.caption ?? null, send_after: sendAfter };
        });

        let queued = 0;
        for (let i = 0; i < rows.length; i += 500) {
          const { data, error } = await db.from("outgoing_messages").insert(rows.slice(i, i + 500)).select("id");
          if (error) return json({ error: error.message, queued }, 500);
          queued += data?.length ?? 0;
        }
        const batches = batchSize > 0 ? Math.ceil(jids.length / batchSize) : 1;
        const etaMin = batchSize > 0 && intervalMin > 0 ? (batches - 1) * intervalMin : 0;
        return json({ ok: true, queued, batches, eta_minutes: etaMin });
      }
      case "upload-pdf": {
        // dashboard uploads a generated program PDF (base64) -> public URL for the bridge to send
        const b64 = String(payload.pdf_base64 ?? "").replace(/^data:.*;base64,/, "");
        if (!b64) return json({ error: "pdf_base64 required" }, 400);
        const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        const stamp = Date.now() + "-" + Math.floor(Math.random() * 1e6);
        const path = `program-${stamp}.pdf`;
        const { error } = await db.storage.from("wa-pdfs").upload(path, bytes, { contentType: "application/pdf", upsert: false });
        if (error) return json({ error: error.message }, 500);
        const { data } = db.storage.from("wa-pdfs").getPublicUrl(path);
        return json({ ok: true, url: data.publicUrl });
      }
      case "set-ad-pdf": {
        // ربط ملف PDF (رابط عام) بكود برنامج — طلال يرسله لأي عميل يجي من إعلان يحمل هذا الكود.
        const code = String(payload.code ?? "").trim().toUpperCase();
        const url = String(payload.url ?? "").trim();
        if (!code || !url) return json({ error: "code & url required" }, 400);
        const { error } = await db.from("wa_settings").upsert(
          { key: "ad_pdf:" + code, value: { url, saved_at: new Date().toISOString() } },
          { onConflict: "key" },
        );
        if (error) return json({ error: error.message }, 500);
        return json({ ok: true, code });
      }
      case "upload-media": {
        // dashboard uploads an image (base64) -> public URL for the bridge to send
        const b64 = String(payload.base64 ?? "").replace(/^data:.*;base64,/, "");
        if (!b64) return json({ error: "base64 required" }, 400);
        const ext = String(payload.ext ?? "jpg").replace(/[^a-z0-9]/gi, "").slice(0, 5) || "jpg";
        const contentType = String(payload.content_type ?? "image/jpeg");
        const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        const path = `media-${Date.now()}-${Math.floor(Math.random() * 1e6)}.${ext}`;
        const { error } = await db.storage.from("wa-pdfs").upload(path, bytes, { contentType, upsert: false });
        if (error) return json({ error: error.message }, 500);
        const { data } = db.storage.from("wa-pdfs").getPublicUrl(path);
        return json({ ok: true, url: data.publicUrl });
      }
      case "distribute": {
        // spread one message across several sender numbers with NO duplicate group.
        // each group is assigned to exactly one account that is a member of it.
        const body = String(payload.body ?? "").trim();
        if (!body) return json({ error: "body required" }, 400);
        const source = String(payload.source ?? "dashboard");
        const caption = payload.caption ?? null;
        const campaign = payload.campaign ? String(payload.campaign) : null;
        const accounts = (payload.accounts ?? []) as string[];
        const targets = ((payload.targets ?? []) as Array<string | { jid: string }>)
          .map((t) => (typeof t === "string" ? t : t.jid)).filter(Boolean);
        if (!accounts.length) return json({ error: "accounts required" }, 400);
        const batchSize = Math.max(0, Number(payload.batch_size ?? 0));
        const intervalMin = Math.max(0, Number(payload.interval_minutes ?? 0));
        const dryRun = payload.dry_run === true;
        const excludeJids = new Set(((payload.exclude_jids ?? []) as string[]).map(String));
        const caps = (payload.account_caps ?? {}) as Record<string, number>;
        const perAcctInterval = (payload.account_intervals ?? {}) as Record<string, number>;

        // permanent exclusion: groups whose name contains any excluded keyword never get campaigns
        const { data: kwRows } = await db.from("wa_excluded_keywords").select("keyword");
        const keywords = (kwRows ?? []).map((k: { keyword: string }) => String(k.keyword).toLowerCase()).filter(Boolean);
        const isExcluded = (name: string | null) => { const n = String(name ?? "").toLowerCase(); return keywords.some((k) => n.includes(k)); };

        // membership set per account (skipping excluded groups)
        async function memberJids(acct: string): Promise<Set<string>> {
          const s = new Set<string>();
          const PAGE = 1000;
          for (let from = 0; from < 5000; from += PAGE) {
            let data: Array<{ jid: string; name: string | null }> | null = null;
            if (acct === "601111136864") {
              const r = await db.from("wa_bridge_groups").select("jid,name").eq("excluded", false).range(from, from + PAGE - 1);
              data = r.data;
            } else if (acct === "96898072933") {
              const r = await db.from("wa_new_groups").select("jid,name").range(from, from + PAGE - 1);
              data = r.data;
            } else {
              const r = await db.from("wa_account_groups").select("jid,name").eq("account", acct).range(from, from + PAGE - 1);
              data = r.data;
            }
            (data ?? []).forEach((x) => { if (!isExcluded(x.name)) s.add(x.jid); });
            if (!data || data.length < PAGE) break;
          }
          return s;
        }
        const sets: Record<string, Set<string>> = {};
        for (const a of accounts) sets[a] = await memberJids(a);

        // no explicit targets -> send to the UNION of the chosen numbers' groups
        let targetList = targets;
        if (!targetList.length) {
          const u = new Set<string>();
          for (const a of accounts) sets[a].forEach((j) => u.add(j));
          targetList = Array.from(u);
        }
        // explicit per-group exclusions (e.g. groups the owner said never to send to)
        if (excludeJids.size) targetList = targetList.filter((j) => !excludeJids.has(j));
        // campaign memory: skip groups that already received THIS campaign
        let alreadyCount = 0;
        if (campaign) {
          const already = new Set<string>();
          const PAGE = 1000;
          for (let from = 0; from < 20000; from += PAGE) {
            const { data } = await db.from("outgoing_messages").select("to").eq("campaign", campaign).range(from, from + PAGE - 1);
            (data ?? []).forEach((r: { to: string }) => already.add(r.to));
            if (!data || data.length < PAGE) break;
          }
          const before = targetList.length;
          targetList = targetList.filter((j) => !already.has(j));
          alreadyCount = before - targetList.length;
        }
        if (!targetList.length) return json({ error: "no new target groups", already_sent: alreadyCount }, 400);

        // assign each target to the member-account with the fewest so far (balance)
        const counts: Record<string, number> = {};
        accounts.forEach((a) => (counts[a] = 0));
        const perAcct: Record<string, string[]> = {};
        accounts.forEach((a) => (perAcct[a] = []));
        const prefer = payload.prefer ? String(payload.prefer) : null;
        let unassigned = 0;
        for (const jid of targetList) {
          const cands = accounts.filter((a) => sets[a].has(jid));
          if (!cands.length) { unassigned++; continue; }
          // respect per-account caps (skip a capped account unless it's the only option)
          const uncapped = cands.filter((a) => caps[a] == null || counts[a] < caps[a]);
          const pool = uncapped.length ? uncapped : cands;
          let chosen: string;
          if (prefer && pool.includes(prefer)) chosen = prefer; // send shared groups from the preferred number
          else { pool.sort((x, y) => counts[x] - counts[y]); chosen = pool[0]; }
          perAcct[chosen].push(jid);
          counts[chosen]++;
        }
        // preview mode: return the plan without enqueuing anything
        if (dryRun) return json({ dry_run: true, planned: targetList.length, per_account: counts, unassigned, already_sent: alreadyCount });

        // enqueue per account with independent batch pacing
        const now = Date.now();
        let queued = 0;
        for (const acct of accounts) {
          const jids = perAcct[acct];
          const iv = perAcctInterval[acct] ?? intervalMin; // per-account pacing (Oman slower)
          const rows = jids.map((jid, i) => {
            let sendAfter = new Date(now).toISOString();
            if (batchSize > 0 && iv > 0) {
              sendAfter = new Date(now + Math.floor(i / batchSize) * iv * 60_000).toISOString();
            }
            return { to: jid, body, source, account: acct, caption, campaign, send_after: sendAfter };
          });
          for (let i = 0; i < rows.length; i += 500) {
            const { data, error } = await db.from("outgoing_messages").insert(rows.slice(i, i + 500)).select("id");
            if (error) return json({ error: error.message, queued }, 500);
            queued += data?.length ?? 0;
          }
        }
        return json({ ok: true, queued, per_account: counts, unassigned, already_sent: alreadyCount });
      }
      case "excluded-keywords": {
        const { data } = await db.from("wa_excluded_keywords").select("keyword").order("keyword");
        return json({ keywords: (data ?? []).map((k: { keyword: string }) => k.keyword) });
      }
      case "add-excluded-keyword": {
        const kw = String(payload.keyword ?? "").trim();
        if (!kw) return json({ error: "keyword required" }, 400);
        await db.from("wa_excluded_keywords").upsert({ keyword: kw }, { onConflict: "keyword" });
        return json({ ok: true });
      }
      case "remove-excluded-keyword": {
        await db.from("wa_excluded_keywords").delete().eq("keyword", String(payload.keyword ?? ""));
        return json({ ok: true });
      }
      case "preview-excluded": {
        // which groups (by name) match the exclusion keywords — for verification
        const { data: kwRows } = await db.from("wa_excluded_keywords").select("keyword");
        const kws = (kwRows ?? []).map((k: { keyword: string }) => String(k.keyword).toLowerCase());
        const matched = new Map<string, string>();
        const scan = (rows: Array<{ jid: string; name: string | null }> | null) =>
          (rows ?? []).forEach((g) => { const n = String(g.name ?? "").toLowerCase(); if (kws.some((k) => n.includes(k))) matched.set(g.jid, g.name ?? g.jid); });
        for (const t of ["wa_bridge_groups", "wa_new_groups", "wa_account_groups"]) {
          for (let from = 0; from < 6000; from += 1000) {
            const { data } = await db.from(t).select("jid,name").range(from, from + 999);
            scan(data);
            if (!data || data.length < 1000) break;
          }
        }
        return json({ count: matched.size, groups: Array.from(matched.values()).slice(0, 60) });
      }
      case "offers": {
        const { data } = await db.from("wa_bridge_offers").select("*").order("created_at", { ascending: false });
        return json({ offers: data ?? [] });
      }
      case "save-offer": {
        const title = String(payload.title ?? "").trim();
        const body = String(payload.body ?? "").trim();
        if (!title || !body) return json({ error: "title and body required" }, 400);
        const { data, error } = await db.from("wa_bridge_offers").insert({ title, body }).select().single();
        if (error) return json({ error: error.message }, 500);
        return json({ ok: true, offer: data });
      }
      case "delete-offer": {
        await db.from("wa_bridge_offers").delete().eq("id", payload.id);
        return json({ ok: true });
      }
      case "exclude-group": {
        const jid = String(payload.jid ?? "");
        if (!jid) return json({ error: "jid required" }, 400);
        await db.from("wa_bridge_groups").update({ excluded: true, reviewed: true }).eq("jid", jid);
        const { count } = await db.from("wa_bridge_groups").select("jid", { count: "exact", head: true }).eq("excluded", true);
        return json({ ok: true, excluded_count: count ?? 0 });
      }
      case "excluded-count": {
        const { count } = await db.from("wa_bridge_groups").select("jid", { count: "exact", head: true }).eq("excluded", true);
        return json({ excluded_count: count ?? 0 });
      }
      case "restore-all": {
        await db.from("wa_bridge_groups").update({ excluded: false }).eq("excluded", true);
        return json({ ok: true });
      }
      // ── slow invite-link harvesting (bridge, throttled ~20/hour) ──
      case "next-invite-targets": {
        const limit = Number(payload.limit ?? 1);
        // prefer groups the account created (jid prefix => admin) so useful links come first
        let { data } = await db.from("wa_bridge_groups").select("jid,name")
          .is("invite_status", null).eq("excluded", false).like("jid", `${ACCOUNT}-%`)
          .order("size", { ascending: false, nullsFirst: false }).limit(limit);
        if (!data || data.length < limit) {
          const need = limit - (data?.length ?? 0);
          const { data: more } = await db.from("wa_bridge_groups").select("jid,name")
            .is("invite_status", null).eq("excluded", false).not("jid", "like", `${ACCOUNT}-%`)
            .order("size", { ascending: false, nullsFirst: false }).limit(need);
          data = [...(data ?? []), ...(more ?? [])];
        }
        return json({ targets: data ?? [] });
      }
      case "mark-non-admin": {
        // mark groups the account is NOT admin of, so the harvester skips them.
        // only touches still-untried rows (never overwrites an already-generated link).
        const jids = (payload.jids ?? []) as string[];
        let marked = 0;
        for (let i = 0; i < jids.length; i += 500) {
          const { data } = await db.from("wa_bridge_groups").update({ invite_status: "not_admin" })
            .in("jid", jids.slice(i, i + 500)).is("invite_status", null).select("jid");
          marked += data?.length ?? 0;
        }
        return json({ ok: true, marked });
      }
      case "save-invite": {
        const jid = String(payload.jid ?? "");
        if (!jid) return json({ error: "jid required" }, 400);
        await db.from("wa_bridge_groups").update({
          invite_link: payload.link ? String(payload.link) : null,
          invite_status: String(payload.status ?? "error"),
          invite_tried_at: new Date().toISOString(),
        }).eq("jid", jid);
        return json({ ok: true });
      }
      case "invite-progress": {
        const { count: ok } = await db.from("wa_bridge_groups").select("jid", { count: "exact", head: true }).eq("invite_status", "ok");
        const { count: remaining } = await db.from("wa_bridge_groups").select("jid", { count: "exact", head: true }).is("invite_status", null).eq("excluded", false);
        return json({ ok_links: ok ?? 0, remaining: remaining ?? 0 });
      }
      case "invite-links": {
        const all: unknown[] = [];
        const PAGE = 1000;
        for (let from = 0; from < 5000; from += PAGE) {
          const { data, error } = await db.from("wa_bridge_groups").select("name,size,invite_link,invite_status")
            .eq("excluded", false).order("name", { ascending: true }).range(from, from + PAGE - 1);
          if (error) return json({ error: error.message }, 500);
          all.push(...(data ?? []));
          if (!data || data.length < PAGE) break;
        }
        return json({ groups: all });
      }
      case "excluded-groups": {
        // full list of excluded groups (paginated past the 1000-row cap)
        const q = String(payload.q ?? "").trim();
        const all: unknown[] = [];
        const PAGE = 1000;
        for (let from = 0; from < 5000; from += PAGE) {
          let query = db.from("wa_bridge_groups").select("jid,name,size").eq("excluded", true)
            .order("name", { ascending: true }).range(from, from + PAGE - 1);
          if (q) query = query.ilike("name", `%${q}%`);
          const { data, error } = await query;
          if (error) return json({ error: error.message }, 500);
          all.push(...(data ?? []));
          if (!data || data.length < PAGE) break;
        }
        return json({ groups: all });
      }
      case "restore-group": {
        const jid = String(payload.jid ?? "");
        if (!jid) return json({ error: "jid required" }, 400);
        await db.from("wa_bridge_groups").update({ excluded: false, reviewed: true }).eq("jid", jid);
        const { count } = await db.from("wa_bridge_groups").select("jid", { count: "exact", head: true }).eq("excluded", true);
        return json({ ok: true, excluded_count: count ?? 0 });
      }
      case "outbox": {
        const { data } = await db.from("outgoing_messages")
          .select("id,to,source,status,error,created_at,sent_at")
          .order("created_at", { ascending: false }).limit(30);
        // map to the shape the dashboard renderer expects
        const outbox = (data ?? []).map((o: Record<string, unknown>) => ({
          id: o.id, target_name: o.to, kind: o.source, status: o.status,
          error: o.error, created_at: o.created_at, sent_at: o.sent_at,
        }));
        return json({ outbox });
      }

      case "split-plan": {
        // read-only: overlap between the Malaysia(601) approved list and the Oman(969) groups
        const my = new Set<string>();
        for (let from = 0; ; from += 1000) {
          const { data } = await db.from("wa_bridge_groups")
            .select("jid").eq("excluded", false).eq("reviewed", true).range(from, from + 999);
          for (const r of data ?? []) my.add(String((r as { jid: unknown }).jid));
          if (!data || data.length < 1000) break;
        }
        const om = new Set<string>();
        for (let from = 0; ; from += 1000) {
          const { data } = await db.from("wa_new_groups").select("jid").range(from, from + 999);
          for (const r of data ?? []) om.add(String((r as { jid: unknown }).jid));
          if (!data || data.length < 1000) break;
        }
        let both = 0;
        for (const j of om) if (my.has(j)) both++;
        return json({
          malaysia_601: my.size,
          oman_969: om.size,
          in_both: both,
          only_601: my.size - both,
          only_969: om.size - both,
          union_distinct: my.size + om.size - both,
        });
      }

      case "groups-by-size": {
        // read-only: approved sending groups ordered by member count (largest first)
        const minSize = Math.max(0, Number(payload.min_size ?? 0));
        const limit = Math.min(500, Math.max(1, Number(payload.limit ?? 60)));
        let q = db.from("wa_bridge_groups")
          .select("jid,name,size,excluded,reviewed")
          .eq("excluded", false).eq("reviewed", true)
          .order("size", { ascending: false, nullsFirst: false }).limit(limit);
        if (minSize > 0) q = q.gte("size", minSize);
        const { data } = await q;
        // distribution buckets across ALL approved groups
        const buckets: Record<string, number> = { "1000+": 0, "500-999": 0, "256-499": 0, "100-255": 0, "under-100": 0, "unknown": 0 };
        for (let from = 0; ; from += 1000) {
          const { data: all } = await db.from("wa_bridge_groups")
            .select("size").eq("excluded", false).eq("reviewed", true).range(from, from + 999);
          for (const r of all ?? []) {
            const s = (r as { size: unknown }).size;
            if (s == null) buckets["unknown"]++;
            else if (Number(s) >= 1000) buckets["1000+"]++;
            else if (Number(s) >= 500) buckets["500-999"]++;
            else if (Number(s) >= 256) buckets["256-499"]++;
            else if (Number(s) >= 100) buckets["100-255"]++;
            else buckets["under-100"]++;
          }
          if (!all || all.length < 1000) break;
        }
        return json({ groups: data ?? [], distribution: buckets });
      }

      case "delivery-summary": {
        // read-only: delivery breakdown per account + failure reasons + approved-group total
        const cnt = async (filters: Record<string, string>) => {
          let q = db.from("outgoing_messages").select("id", { count: "exact", head: true });
          for (const [k, v] of Object.entries(filters)) q = q.eq(k, v);
          const { count } = await q; return count ?? 0;
        };
        const accounts = ["601111136864", "201011346081", "96898072933"];
        const perAccount: Record<string, unknown> = {};
        for (const a of accounts) {
          perAccount[a] = {
            sent: await cnt({ account: a, status: "sent" }),
            failed: await cnt({ account: a, status: "failed" }),
            pending: await cnt({ account: a, status: "pending" }),
            processing: await cnt({ account: a, status: "processing" }),
          };
        }
        // distinct groups that received at least one successful send — paginate past the 1000-row cap
        const sentGroups = new Set<string>();
        for (let from = 0; ; from += 1000) {
          const { data } = await db.from("outgoing_messages")
            .select("to").eq("status", "sent").range(from, from + 999);
          for (const r of data ?? []) sentGroups.add(String((r as { to: unknown }).to));
          if (!data || data.length < 1000) break;
        }
        // failure reasons
        const reasons: Record<string, number> = {};
        for (let from = 0; ; from += 1000) {
          const { data } = await db.from("outgoing_messages")
            .select("error").eq("status", "failed").range(from, from + 999);
          for (const r of data ?? []) { const e = String((r as { error: unknown }).error ?? "unknown"); reasons[e] = (reasons[e] ?? 0) + 1; }
          if (!data || data.length < 1000) break;
        }
        // approved sending list — paginate too
        const approvedJids = new Set<string>();
        for (let from = 0; ; from += 1000) {
          const { data } = await db.from("wa_bridge_groups")
            .select("jid").eq("excluded", false).eq("reviewed", true).range(from, from + 999);
          for (const r of data ?? []) approvedJids.add(String((r as { jid: unknown }).jid));
          if (!data || data.length < 1000) break;
        }
        let approvedReached = 0;
        for (const j of approvedJids) if (sentGroups.has(j)) approvedReached++;
        return json({
          per_account: perAccount,
          distinct_groups_received: sentGroups.size,
          failure_reasons: reasons,
          approved_groups: approvedJids.size,
          approved_reached: approvedReached,
          approved_not_reached: approvedJids.size - approvedReached,
        });
      }

      case "peek-pending": {
        // read-only diagnostic: earliest pending rows with their account, to spot stuck/mismatched-account rows
        const { data } = await db.from("outgoing_messages")
          .select("id,account,status,source,send_after").eq("status", "pending")
          .order("send_after", { ascending: true }).limit(10);
        // also account breakdown among all pending
        const { data: allP } = await db.from("outgoing_messages").select("account").eq("status", "pending");
        const byAcct: Record<string, number> = {};
        for (const r of allP ?? []) { const a = String((r as { account: unknown }).account ?? "NULL"); byAcct[a] = (byAcct[a] ?? 0) + 1; }
        const { data: proc } = await db.from("outgoing_messages").select("account").eq("status", "processing");
        const procByAcct: Record<string, number> = {};
        for (const r of proc ?? []) { const a = String((r as { account: unknown }).account ?? "NULL"); procByAcct[a] = (procByAcct[a] ?? 0) + 1; }
        return json({ earliest: data ?? [], pending_by_account: byAcct, processing_by_account: procByAcct });
      }

      case "recent-sends": {
        // read-only: last N actually-sent rows ordered by sent_at (to inspect real send rate)
        const lim = Math.min(200, Math.max(1, Number(payload.limit ?? 60)));
        const { data } = await db.from("outgoing_messages")
          .select("id,to,sent_at").eq("status", "sent")
          .order("sent_at", { ascending: false }).limit(lim);
        return json({ sends: data ?? [] });
      }

      case "queue-count": {
        // read-only: how many group sends are still waiting / in-flight / failed
        const cnt = async (status: string) => {
          const { count } = await db.from("outgoing_messages")
            .select("id", { count: "exact", head: true }).eq("status", status);
          return count ?? 0;
        };
        const [pending, processing, failed] = await Promise.all([
          cnt("pending"), cnt("processing"), cnt("failed"),
        ]);
        const { data: nextRow } = await db.from("outgoing_messages")
          .select("send_after").eq("status", "pending")
          .order("send_after", { ascending: true }).limit(1).maybeSingle();
        const { data: lastRow } = await db.from("outgoing_messages")
          .select("send_after").eq("status", "pending")
          .order("send_after", { ascending: false }).limit(1).maybeSingle();
        return json({ pending, processing, failed, remaining: pending + processing, next_send_after: nextRow?.send_after ?? null, last_send_after: lastRow?.send_after ?? null });
      }

      case "retry-failed": {
        // re-queue failed rows as their own stream. Default: start ~5min from now,
        // spaced 15min (~96/day) so combined with the existing queue stays under
        // the trusted-number ceiling (~200/day). Pass start:"after-tail" to append instead.
        const intervalMin = Math.min(60, Math.max(1, Number(payload.interval_minutes ?? 15)));
        const { data: failedRows } = await db.from("outgoing_messages")
          .select("id").eq("status", "failed").order("id", { ascending: true });
        if (!failedRows?.length) return json({ ok: true, retried: 0 });
        const now = Date.now();
        let base = now + 5 * 60_000; // small head start
        if (String(payload.start ?? "now") === "after-tail") {
          const { data: tail } = await db.from("outgoing_messages")
            .select("send_after").eq("status", "pending")
            .order("send_after", { ascending: false }).limit(1).maybeSingle();
          const t = tail?.send_after ? new Date(tail.send_after).getTime() : now;
          base = Math.max(now, t);
        }
        let retried = 0;
        for (let i = 0; i < failedRows.length; i++) {
          const sendAfter = new Date(base + (i + 1) * intervalMin * 60_000).toISOString();
          const { data: upd } = await db.from("outgoing_messages")
            .update({ status: "pending", error: null, sent_at: null, send_after: sendAfter })
            .eq("id", failedRows[i].id).eq("status", "failed").select("id");
          if (upd && upd.length) retried++;
        }
        const first = new Date(base + intervalMin * 60_000).toISOString();
        const last = new Date(base + retried * intervalMin * 60_000).toISOString();
        return json({ ok: true, retried, interval_minutes: intervalMin, first_send_after: first, last_send_after: last });
      }

      default:
        return json({ error: "unknown action" }, 400);
    }
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) }, 500);
  }
});
