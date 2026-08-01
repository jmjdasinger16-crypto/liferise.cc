const STRIPE_URL = "https://buy.stripe.com/5kQ3cu0rQ9ssbIG2NR6sw04";
const SESSION_COOKIE = "liferise_admin";
const SESSION_TTL_SECONDS = 60 * 60 * 8;
const json = (body, status = 200, extraHeaders = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extraHeaders } });
const clean = (value, max = 2000) => String(value ?? "").trim().slice(0, max);
const validEmail = (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
const validPhone = (value) => value.replace(/\D/g, "").length >= 10;
const uuid = () => crypto.randomUUID();
const encoder = new TextEncoder();

const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
const b64urlText = (text) => b64url(encoder.encode(text));
const parseCookies = (request) => Object.fromEntries((request.headers.get("Cookie") || "").split(";").map(v => v.trim()).filter(Boolean).map(v => { const i = v.indexOf("="); return [v.slice(0, i), decodeURIComponent(v.slice(i + 1))]; }));
const timingSafeEqual = (a, b) => {
  const aa = encoder.encode(String(a));
  const bb = encoder.encode(String(b));
  if (aa.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < aa.length; i++) diff |= aa[i] ^ bb[i];
  return diff === 0;
};

async function hmac(secret, value) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64url(new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(value))));
}

async function createSession(env) {
  const payload = b64urlText(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS, nonce: uuid() }));
  return `${payload}.${await hmac(env.ADMIN_SESSION_SECRET, payload)}`;
}

async function isAdmin(request, env) {
  const token = parseCookies(request)[SESSION_COOKIE];
  if (!token || !env.ADMIN_SESSION_SECRET) return false;
  const [payload, signature] = token.split(".");
  if (!payload || !signature) return false;
  if (!timingSafeEqual(signature, await hmac(env.ADMIN_SESSION_SECRET, payload))) return false;
  try {
    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
    const decoded = JSON.parse(atob(normalized + "=".repeat((4 - normalized.length % 4) % 4)));
    return decoded.exp > Math.floor(Date.now() / 1000);
  } catch { return false; }
}

async function saveMessage(env, conversationId, role, content) {
  await env.DB.prepare("INSERT INTO chat_messages (conversation_id, role, content, created_at) VALUES (?, ?, ?, ?)")
    .bind(conversationId, role, clean(content, 4000), new Date().toISOString()).run();
}

async function saveEvent(env, request, data) {
  const occurredAt = new Date().toISOString();
  await env.DB.prepare(`INSERT INTO site_events
    (event_name,page_path,session_id,lead_id,conversation_id,metadata,occurred_at,ip_address,user_agent)
    VALUES (?,?,?,?,?,?,?,?,?)`)
    .bind(clean(data.event_name,80), clean(data.page_path,500), clean(data.session_id,120), data.lead_id || null,
      clean(data.conversation_id,120) || null, JSON.stringify(data.metadata || {}), occurredAt,
      request.headers.get("CF-Connecting-IP"), clean(request.headers.get("User-Agent"),500)).run();
}

async function saveLead(env, request, data, source = "chatbot") {
  const submittedAt = new Date().toISOString();
  const result = await env.DB.prepare(`INSERT INTO coaching_leads
    (name,email,phone,area,message,comfort,status,submitted_at,ip_address,user_agent,lead_source,preferred_contact,best_contact_time,chat_summary,sms_consent,conversation_id)
    VALUES (?,?,?,?,?,?,'new',?,?,?,?,?,?,?,?,?)`)
    .bind(data.name, data.email, data.phone, data.area || "", data.concern || data.message || "", data.comfort || "", submittedAt,
      request.headers.get("CF-Connecting-IP"), clean(request.headers.get("User-Agent"), 500), source,
      data.preferred_contact || "", data.best_contact_time || "", data.summary || "", data.sms_consent ? 1 : 0, data.conversation_id || null).run();
  return result.meta?.last_row_id;
}

async function notify(env, lead) {
  try {
    await env.EMAIL.send({
      from: "LifeRise Forms <notifications@liferise.cc>", to: "support@liferise.cc", replyTo: lead.email,
      subject: `New LifeRise ${lead.lead_source || "website"} lead — ${lead.name}`,
      text: `Name: ${lead.name}\nEmail: ${lead.email}\nPhone: ${lead.phone}\nArea: ${lead.area}\nPreferred contact: ${lead.preferred_contact}\nBest time: ${lead.best_contact_time}\nSummary: ${lead.summary || lead.concern || ""}`
    });
  } catch (error) { console.error("Email notification failed", error); }
}

function nextPrompt(c) {
  if (!c.area) return { field: "area", reply: "What would you most like help improving right now?", options: ["Mindset or emotional wellness","Health, nutrition, or energy","Relationships or parenting","Money, work, or career","Routines and organization","I’m not sure"] };
  if (!c.concern) return { field: "concern", reply: "Tell me a little about what has been feeling difficult. There is no perfect way to explain it." };
  if (!c.name) return { field: "name", reply: "Thank you for sharing that. What name should your LifeRise representative use?" };
  if (!c.phone) return { field: "phone", reply: "What is the best phone number for your representative to reach you?" };
  if (!c.email) return { field: "email", reply: "What email address should we use for updates about your request?" };
  if (!c.preferred_contact) return { field: "preferred_contact", reply: "How would you prefer we contact you?", options: ["Phone call","Text message","Email","No preference"] };
  if (!c.best_contact_time) return { field: "best_contact_time", reply: "When would you generally prefer to be contacted?", options: ["Morning","Afternoon","Evening","Anytime"] };
  if (!c.sms_consent) return { field: "sms_consent", reply: "By continuing, you agree that LifeRise may contact you by phone, text, and email about your request. Message and data rates may apply. Consent is not a condition of purchase. Do you agree?", options: ["I agree","Email only"] };
  return null;
}

async function aiClose(env, c, userMessage) {
  const system = `You are the LifeRise virtual assistant. The lead has already been saved. Your goal is to help the person decide whether to start a 3-day trial for LifeRise lifestyle coaching, then $18 every two weeks. Be warm, concise, truthful and non-pushy. Never guarantee outcomes, create urgency, shame, diagnose, or claim licensed professional status. Clearly disclose price and trial. Cancellation is subject to the posted LifeRise Terms of Service; do not promise anything beyond them. If the user declines, respect it. If they mention crisis, self-harm, abuse, immediate danger or a medical emergency, stop selling and tell them to contact emergency services or an appropriate crisis resource. Return JSON only with keys reply, show_checkout, stage. stage must be closing, follow_up, declined, or safety.`;
  const prompt = `Lead context: name=${c.name}; area=${c.area}; concern=${c.concern}; preferred contact=${c.preferred_contact}. Latest user message: ${clean(userMessage, 1000)}. Respond to their concern and decide whether to display checkout.`;
  try {
    const out = await env.AI.run("@cf/meta/llama-3.1-8b-instruct", { messages: [{ role: "system", content: system }, { role: "user", content: prompt }], response_format: { type: "json_object" }, max_tokens: 350 });
    const raw = out.response || out.result || out;
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    return { reply: clean(parsed.reply, 1200), show_checkout: Boolean(parsed.show_checkout), stage: clean(parsed.stage, 30) || "closing" };
  } catch (error) {
    console.error("AI close failed", error);
    return { reply: `Based on what you shared, LifeRise can help you start with a realistic game plan and ongoing accountability. You can begin with a 3-day trial, then continue for $18 every two weeks. Membership cancellation is handled under the posted Terms of Service.`, show_checkout: true, stage: "closing" };
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/api/health") return json({ ok: true, service: "liferise-form-api" });

    if (request.method === "POST" && url.pathname === "/api/events") {
      let data; try { data = await request.json(); } catch { return json({ error: "Invalid request body." }, 400); }
      if (!clean(data.event_name,80)) return json({ error: "Event name is required." }, 400);
      ctx.waitUntil(saveEvent(env, request, data));
      return json({ success: true }, 202);
    }

    if (request.method === "POST" && url.pathname === "/api/admin/login") {
      let data; try { data = await request.json(); } catch { return json({ error: "Invalid request body." }, 400); }
      if (!env.ADMIN_PASSWORD || !env.ADMIN_SESSION_SECRET) return json({ error: "Admin secrets are not configured." }, 503);
      if (!timingSafeEqual(clean(data.password,500), env.ADMIN_PASSWORD)) return json({ error: "Incorrect password." }, 401);
      const token = await createSession(env);
      return json({ success: true }, 200, { "set-cookie": `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_TTL_SECONDS}` });
    }

    if (request.method === "POST" && url.pathname === "/api/admin/logout") {
      return json({ success: true }, 200, { "set-cookie": `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0` });
    }

    if (url.pathname.startsWith("/api/admin/")) {
      if (!(await isAdmin(request, env))) return json({ error: "Unauthorized." }, 401);

      if (request.method === "GET" && url.pathname === "/api/admin/dashboard") {
        const since30 = new Date(Date.now() - 30 * 86400000).toISOString();
        const metrics = await env.DB.prepare(`SELECT
          SUM(CASE WHEN event_name='page_view' THEN 1 ELSE 0 END) visits,
          COUNT(DISTINCT CASE WHEN event_name='page_view' THEN session_id END) unique_visitors,
          SUM(CASE WHEN event_name='chatbot_open' THEN 1 ELSE 0 END) chatbot_opens,
          SUM(CASE WHEN event_name='stripe_click' THEN 1 ELSE 0 END) stripe_clicks
          FROM site_events WHERE occurred_at >= ?`).bind(since30).first();
        const leadCount = await env.DB.prepare("SELECT COUNT(*) total FROM coaching_leads WHERE submitted_at >= ?").bind(since30).first();
        const leads = await env.DB.prepare(`SELECT id,name,email,phone,area,message,comfort,status,assigned_representative,representative_notes,next_follow_up_at,submitted_at,contacted_at,updated_at,lead_source,preferred_contact,best_contact_time,chat_summary,sms_consent,conversation_id FROM coaching_leads ORDER BY submitted_at DESC LIMIT 250`).all();
        const events = await env.DB.prepare(`SELECT id,event_name,page_path,session_id,lead_id,conversation_id,metadata,occurred_at FROM site_events ORDER BY occurred_at DESC LIMIT 200`).all();
        return json({ metrics: { ...metrics, leads: leadCount?.total || 0 }, leads: leads.results || [], events: events.results || [] });
      }

      const leadMatch = url.pathname.match(/^\/api\/admin\/leads\/(\d+)$/);
      if (request.method === "PATCH" && leadMatch) {
        let data; try { data = await request.json(); } catch { return json({ error: "Invalid request body." }, 400); }
        const id = Number(leadMatch[1]);
        const allowedStatuses = ["new","contacted","trial","active","closed"];
        const status = allowedStatuses.includes(clean(data.status,30)) ? clean(data.status,30) : "new";
        const assigned = clean(data.assigned_representative,120);
        const notes = clean(data.representative_notes,5000);
        const followUp = clean(data.next_follow_up_at,50) || null;
        const now = new Date().toISOString();
        await env.DB.prepare(`UPDATE coaching_leads SET status=?,assigned_representative=?,representative_notes=?,next_follow_up_at=?,updated_at=?,contacted_at=CASE WHEN ?='contacted' AND contacted_at IS NULL THEN ? ELSE contacted_at END WHERE id=?`)
          .bind(status,assigned,notes,followUp,now,status,now,id).run();
        const lead = await env.DB.prepare("SELECT * FROM coaching_leads WHERE id=?").bind(id).first();
        if (!lead) return json({ error: "Lead not found." }, 404);
        return json({ success: true, lead });
      }

      return json({ error: "Not found" }, 404);
    }

    if (request.method === "POST" && url.pathname === "/api/leads") {
      let data; try { data = await request.json(); } catch { return json({ error: "Invalid request body." }, 400); }
      const lead = { name: clean(data.name,120), email: clean(data.email,254).toLowerCase(), phone: clean(data.phone,40), area: clean(data.area,160), message: clean(data.message,4000), comfort: clean(data.comfort,240), lead_source: "contact_form" };
      if (!lead.name || !validEmail(lead.email) || !validPhone(lead.phone)) return json({ error: "Please provide a valid name, email, and phone number." }, 400);
      const id = await saveLead(env, request, lead, "contact_form");
      ctx.waitUntil(Promise.all([notify(env, lead), saveEvent(env, request, { event_name: "lead_submitted", page_path: clean(data.page_path,500), session_id: clean(data.session_id,120), lead_id: id, metadata: { source: "contact_form" } })]));
      return json({ success: true, lead_id: id, message: "Thank you. Your request has been received and a LifeRise representative will contact you soon.", checkout_url: STRIPE_URL }, 201);
    }

    if (request.method === "POST" && url.pathname === "/api/chat") {
      let body; try { body = await request.json(); } catch { return json({ error: "Invalid request body." }, 400); }
      const conversationId = clean(body.conversation_id,80) || uuid();
      const userMessage = clean(body.message,2000);
      const now = new Date().toISOString();
      let c = await env.DB.prepare("SELECT * FROM chat_conversations WHERE id=?").bind(conversationId).first();
      if (!c) {
        await env.DB.prepare("INSERT INTO chat_conversations (id,stage,created_at,updated_at) VALUES (?,'collecting',?,?)").bind(conversationId,now,now).run();
        c = { id: conversationId, stage: "collecting" };
      }
      if (userMessage) await saveMessage(env, conversationId, "user", userMessage);

      if (c.stage === "closing" || c.stage === "follow_up") {
        const ai = await aiClose(env, c, userMessage || "Please explain the trial.");
        await env.DB.prepare("UPDATE chat_conversations SET stage=?,updated_at=? WHERE id=?").bind(ai.stage,now,conversationId).run();
        await saveMessage(env, conversationId, "assistant", ai.reply);
        return json({ conversation_id: conversationId, reply: ai.reply, stage: ai.stage, show_checkout: ai.show_checkout, checkout_url: ai.show_checkout ? STRIPE_URL : null });
      }

      if (body.field && userMessage) {
        const field = clean(body.field,40);
        const allowed = ["area","concern","name","phone","email","preferred_contact","best_contact_time","sms_consent"];
        if (allowed.includes(field)) {
          let value = userMessage;
          if (field === "email") { value = value.toLowerCase(); if (!validEmail(value)) return json({ conversation_id: conversationId, reply: "Please enter a valid email address.", field: "email" }, 400); }
          if (field === "phone" && !validPhone(value)) return json({ conversation_id: conversationId, reply: "Please enter a valid phone number including area code.", field: "phone" }, 400);
          if (field === "sms_consent") value = /agree/i.test(value) ? 1 : 0;
          await env.DB.prepare(`UPDATE chat_conversations SET ${field}=?,updated_at=? WHERE id=?`).bind(value,now,conversationId).run();
          c[field] = value;
        }
      }

      const prompt = nextPrompt(c);
      if (prompt) { await saveMessage(env, conversationId, "assistant", prompt.reply); return json({ conversation_id: conversationId, stage: "collecting", ...prompt }); }

      if (!c.lead_id) {
        const summary = `${c.name} is seeking help with ${c.area}. Main concern: ${c.concern}`;
        const lead = { ...c, summary, conversation_id: conversationId, lead_source: "chatbot" };
        const leadId = await saveLead(env, request, lead, "chatbot");
        await env.DB.prepare("UPDATE chat_conversations SET lead_id=?,summary=?,stage='closing',updated_at=? WHERE id=?").bind(leadId,summary,now,conversationId).run();
        c.lead_id = leadId; c.summary = summary; c.stage = "closing";
        ctx.waitUntil(Promise.all([notify(env, lead), saveEvent(env, request, { event_name: "lead_submitted", page_path: clean(body.page_path,500), session_id: clean(body.session_id,120), lead_id: leadId, conversation_id: conversationId, metadata: { source: "chatbot" } })]));
      }
      const ai = await aiClose(env, c, "The lead information has just been saved. Introduce the trial naturally.");
      await saveMessage(env, conversationId, "assistant", ai.reply);
      return json({ conversation_id: conversationId, lead_saved: true, lead_id: c.lead_id, reply: ai.reply, stage: "closing", show_checkout: ai.show_checkout, checkout_url: ai.show_checkout ? STRIPE_URL : null });
    }

    return json({ error: "Not found" }, 404);
  }
};
