const STRIPE_URL = "https://buy.stripe.com/5kQ3cu0rQ9ssbIG2NR6sw04";
const SESSION_COOKIE = "liferise_admin";
const SESSION_TTL_SECONDS = 60 * 60 * 8;
const json = (body, status = 200, extraHeaders = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extraHeaders } });
const clean = (value, max = 2000) => String(value ?? "").trim().slice(0, max);
const validEmail = (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
const validPhone = (value) => String(value ?? "").replace(/\D/g, "").length >= 10;
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

async function getRecentMessages(env, conversationId, limit = 12) {
  const result = await env.DB.prepare("SELECT role, content FROM chat_messages WHERE conversation_id=? ORDER BY created_at DESC LIMIT ?")
    .bind(conversationId, limit).all();
  return (result.results || []).reverse();
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

/* ── Safety detection (deterministic, runs before AI) ── */
function detectUrgentRisk(message) {
  return /\b(suicide|kill myself|end my life|self[- ]?harm|hurt myself|kill someone|hurt someone|overdose|can't breathe|medical emergency|immediate danger)\b/i.test(message);
}

const safetyReply = "I'm really sorry you're facing this. Please call 911 or your local emergency number now if you or someone else may be in immediate danger, and contact a trusted person who can stay with you. I'm an AI coaching assistant and cannot provide emergency help.";

/* ── Lead readiness (computed server-side, never trusted to AI) ── */
const REQUIRED_FIELDS = ["area", "concern", "name", "phone", "email", "preferred_contact", "best_contact_time", "sms_consent"];

function missingFields(c) {
  const row = c || {};
  return REQUIRED_FIELDS.filter(f => {
    const val = row[f];
    if (f === "sms_consent") return val !== 1;
    if (f === "email") return !validEmail(val);
    if (f === "phone") return !validPhone(val);
    return !val || !String(val).trim();
  });
}

function leadIsReady(c) {
  return missingFields(c).length === 0;
}

/* ── AI-extracted lead validation (server-side enforcement) ── */
function validateAndMergeLead(existing, incoming) {
  const merged = { ...existing };
  if (!merged) return merged;

  if (incoming.name && !merged.name && /^[a-z][a-z .'-]{1,79}$/i.test(incoming.name)) {
    merged.name = clean(incoming.name, 120).replace(/^(?:i(?:'m| am)|my name is)\s+/i, "").trim();
  }
  if (incoming.area && !merged.area) merged.area = clean(incoming.area, 160);
  if (incoming.concern && !merged.concern) merged.concern = clean(incoming.concern, 4000);
  if (incoming.preferred_contact && !merged.preferred_contact) {
    const pc = clean(incoming.preferred_contact, 40).toLowerCase();
    if (["phone call", "phone", "text message", "text", "sms", "email", "no preference"].includes(pc)) {
      merged.preferred_contact = pc;
    }
  }
  if (incoming.best_contact_time && !merged.best_contact_time) {
    merged.best_contact_time = clean(incoming.best_contact_time, 120);
  }
  if (incoming.email && !validEmail(merged.email) && validEmail(incoming.email)) {
    merged.email = clean(incoming.email, 254).toLowerCase();
  }
  if (incoming.phone && !validPhone(merged.phone) && validPhone(incoming.phone)) {
    merged.phone = clean(incoming.phone, 40);
  }
  if (incoming.summary && !merged.summary) {
    merged.summary = clean(incoming.summary, 1000);
  }
  // sms_consent: only set to 1 if AI detects explicit consent AND it wasn't already set
  if (incoming.sms_consent === true && merged.sms_consent !== 1) {
    merged.sms_consent = 1;
  }
  return merged;
}

/* ── Empathetic AI system prompt ── */
const chatSystemPrompt = `You are the LifeRise virtual assistant. LifeRise provides empathetic lifestyle coaching and practical accountability across mindset, health, nutrition, money, career, parenting, relationships, routines, confidence, purpose, and social connection.

Conversation style:
- Sound warm, calm, human, and respectful. Acknowledge the visitor's feelings or situation before asking a question.
- Ask only one useful question at a time. Do not interrogate, pressure, shame, diagnose, or make unrealistic promises.
- Keep most replies between 2 and 5 sentences. Help the visitor identify the smallest useful next step.
- Gradually collect contact details only after providing value and building trust.
- Never claim to be a therapist, doctor, lawyer, financial adviser, or emergency service.

LifeRise facts:
- LifeRise offers lifestyle coaching, education, accountability, and practical support.
- It is not medical, mental-health, legal, or financial professional care.
- Membership is $18 every two weeks after a 3-day trial.
- A representative may contact the visitor to continue the conversation and build a game plan.

Lead collection:
- Naturally work toward collecting: primary life area, what they want to improve (concern), name, phone number, email, preferred contact method, best contact time, and consent to be contacted.
- Extract any of these fields the visitor shares naturally — do not force a rigid order.
- Do not ask for information already collected (listed in the context below).
- Do not recommend the trial or checkout until all lead fields are collected and consent is given.

Safety:
- If the visitor appears in immediate danger, mentions suicide, self-harm, harming someone else, abuse requiring urgent protection, overdose, or a medical emergency, respond compassionately, direct them to call 911 or their local emergency number now, and set risk_level to "urgent". Do not continue ordinary coaching or sales questions.

Return ONLY valid JSON with this exact shape:
{
  "reply": "your empathetic response",
  "options": [],
  "lead": {
    "area": null,
    "concern": null,
    "name": null,
    "phone": null,
    "email": null,
    "preferred_contact": null,
    "best_contact_time": null,
    "sms_consent": null,
    "summary": null
  },
  "show_checkout": false,
  "risk_level": "normal"
}

Only populate lead fields that the visitor explicitly shared in their latest message. Use null for everything else. Set show_checkout to true ONLY if all lead fields are collected and consent was given. Keep options as an array of short strings (max 4) for quick-reply buttons, or empty array if a free-text response is more appropriate.`;

/* ── AI chat function (Workers AI) ── */
async function aiChat(env, c, userMessage, recentMessages, pagePath) {
  const missing = missingFields(c);
  const leadContext = `Collected lead data so far:
- area: ${c.area || "(not yet collected)"}
- concern: ${c.concern || "(not yet collected)"}
- name: ${c.name || "(not yet collected)"}
- phone: ${c.phone || "(not yet collected)"}
- email: ${c.email || "(not yet collected)"}
- preferred_contact: ${c.preferred_contact || "(not yet collected)"}
- best_contact_time: ${c.best_contact_time || "(not yet collected)"}
- sms_consent: ${c.sms_consent === 1 ? "consented" : "(not yet collected)"}

Missing fields: ${missing.length ? missing.join(", ") : "none — all collected"}
Stage: ${leadIsReady(c) ? "ready for checkout" : "collecting"}`;

  const conversationContext = recentMessages.length
    ? recentMessages.map(m => `${m.role}: ${m.content}`).join("\n")
    : "(no prior messages — this is the start of the conversation)";

  const userPrompt = `Conversation so far:
${conversationContext}

${leadContext}

Current page: ${pagePath || "/"}
Latest visitor message: ${userMessage || "(conversation just started — greet the visitor warmly)"}

Respond to the visitor with empathy. If they shared any lead information (name, phone, email, area of life, preferred contact method, best time, etc.), extract it into the lead object. Remember: only extract what they actually said — never guess or fabricate information.`;

  try {
    const out = await env.AI.run("@cf/meta/llama-3.1-8b-fast-v2", {
      messages: [
        { role: "system", content: chatSystemPrompt },
        { role: "user", content: userPrompt }
      ],
      response_format: { type: "json_object" },
      max_tokens: 500
    });
    const raw = out.response || out.result || out;
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    return {
      reply: clean(parsed.reply, 1200) || "I'm here to listen. What's been on your mind lately?",
      options: Array.isArray(parsed.options) ? parsed.options.slice(0, 4).map(o => clean(o, 60)) : [],
      lead: parsed.lead || {},
      show_checkout: Boolean(parsed.show_checkout),
      risk_level: clean(parsed.risk_level, 20) || "normal"
    };
  } catch (error) {
    console.error("AI chat error:", error?.message || error);
    return null;
  }
}

/* ── Fallback: rigid prompt flow (used if AI fails) ── */
function nextPrompt(c) {
  if (!c.area) return { field: "area", reply: "What would you most like help improving right now?", options: ["Mindset or emotional wellness","Health, nutrition, or energy","Relationships or parenting","Money, work, or career","Routines and organization","I'm not sure"] };
  if (!c.concern) return { field: "concern", reply: "Tell me a little about what has been feeling difficult. There is no perfect way to explain it." };
  if (!c.name) return { field: "name", reply: "Thank you for sharing that. What name should your LifeRise representative use?" };
  if (!c.phone) return { field: "phone", reply: "What is the best phone number for your representative to reach you?" };
  if (!c.email) return { field: "email", reply: "What email address should we use for updates about your request?" };
  if (!c.preferred_contact) return { field: "preferred_contact", reply: "How would you prefer we contact you?", options: ["Phone call","Text message","Email","No preference"] };
  if (!c.best_contact_time) return { field: "best_contact_time", reply: "When would you generally prefer to be contacted?", options: ["Morning","Afternoon","Evening","Anytime"] };
  if (!c.sms_consent) return { field: "sms_consent", reply: "By continuing, you agree that LifeRise may contact you by phone, text, and email about your request. Message and data rates may apply. Consent is not a condition of purchase. Do you agree?", options: ["I agree","Email only"] };
  return null;
}

/* ── AI closing (after lead is saved) ── */
async function aiClose(env, c, userMessage) {
  const system = `You are the LifeRise virtual assistant. The lead has already been saved. Your goal is to help the person decide whether to start a 3-day trial for LifeRise lifestyle coaching, then $18 every two weeks. Be warm, concise, truthful and non-pushy. Never guarantee outcomes, create urgency, shame, diagnose, or claim licensed professional status. Clearly disclose price and trial. Cancellation is subject to the posted LifeRise Terms of Service; do not promise anything beyond them. If the user declines, respect it. If they mention crisis, self-harm, abuse, immediate danger or a medical emergency, stop selling and tell them to contact emergency services or an appropriate crisis resource. Return JSON only with keys reply, show_checkout, stage. stage must be closing, follow_up, declined, or safety.`;
  const prompt = `Lead context: name=${c.name}; area=${c.area}; concern=${c.concern}; preferred contact=${c.preferred_contact}. Latest user message: ${clean(userMessage, 1000)}. Respond to their concern and decide whether to display checkout.`;
  try {
    const out = await env.AI.run("@cf/meta/llama-3.1-8b-fast-v2", { messages: [{ role: "system", content: system }, { role: "user", content: prompt }], response_format: { type: "json_object" }, max_tokens: 350 });
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
        const now = new Date();
        const defaultFrom = new Date(now.getTime() - 30 * 86400000);
        const fromRaw = url.searchParams.get("from");
        const toRaw = url.searchParams.get("to");
        const page = clean(url.searchParams.get("page"), 500);
        const fromDate = fromRaw ? new Date(fromRaw) : defaultFrom;
        const toDate = toRaw ? new Date(toRaw) : now;
        if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime())) return json({ error: "Invalid date range." }, 400);
        if (fromDate > toDate) return json({ error: "The start date must be before the end date." }, 400);
        const from = fromDate.toISOString();
        const to = toDate.toISOString();
        const pageClause = page ? " AND page_path = ?" : "";
        const eventBindings = page ? [from, to, page] : [from, to];

        const metrics = await env.DB.prepare(`SELECT
          SUM(CASE WHEN event_name='page_view' THEN 1 ELSE 0 END) visits,
          COUNT(DISTINCT CASE WHEN event_name='page_view' THEN session_id END) unique_visitors,
          SUM(CASE WHEN event_name='chatbot_open' THEN 1 ELSE 0 END) chatbot_opens,
          SUM(CASE WHEN event_name='stripe_click' THEN 1 ELSE 0 END) stripe_clicks
          FROM site_events WHERE occurred_at >= ? AND occurred_at <= ?${pageClause}`).bind(...eventBindings).first();
        const leadCount = await env.DB.prepare("SELECT COUNT(*) total FROM coaching_leads WHERE submitted_at >= ? AND submitted_at <= ?").bind(from, to).first();
        const leads = await env.DB.prepare(`SELECT id,name,email,phone,area,message,comfort,status,assigned_representative,representative_notes,next_follow_up_at,submitted_at,contacted_at,updated_at,lead_source,preferred_contact,best_contact_time,chat_summary,sms_consent,conversation_id FROM coaching_leads WHERE submitted_at >= ? AND submitted_at <= ? ORDER BY submitted_at DESC LIMIT 250`).bind(from, to).all();
        const events = await env.DB.prepare(`SELECT id,event_name,page_path,session_id,lead_id,conversation_id,metadata,occurred_at FROM site_events WHERE occurred_at >= ? AND occurred_at <= ?${pageClause} ORDER BY occurred_at DESC LIMIT 500`).bind(...eventBindings).all();
        const pages = await env.DB.prepare(`SELECT page_path,
          SUM(CASE WHEN event_name='page_view' THEN 1 ELSE 0 END) views,
          COUNT(DISTINCT CASE WHEN event_name='page_view' THEN session_id END) unique_visitors,
          MAX(occurred_at) last_activity
          FROM site_events WHERE page_path IS NOT NULL AND page_path <> ''${pageClause}
          GROUP BY page_path ORDER BY views DESC, last_activity DESC`).bind(...eventBindings).all();
        const pagePaths = await env.DB.prepare("SELECT DISTINCT page_path FROM site_events WHERE page_path IS NOT NULL AND page_path <> '' ORDER BY page_path").all();
        return json({
          metrics: { ...metrics, leads: leadCount?.total || 0 },
          pages: pages.results || [],
          page_paths: (pagePaths.results || []).map(row => row.page_path),
          leads: leads.results || [],
          events: events.results || [],
          range: { from, to, page: page || null }
        });
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

    /* ── AI-powered chat handler ── */
    if (request.method === "POST" && url.pathname === "/api/chat") {
      try {
      let body; try { body = await request.json(); } catch { return json({ error: "Invalid request body." }, 400); }
      const conversationId = clean(body.conversation_id, 80) || uuid();
      const userMessage = clean(body.message, 2000);
      const pagePath = clean(body.page_path, 500);
      const now = new Date().toISOString();

      // Load or create conversation
      let c = await env.DB.prepare("SELECT * FROM chat_conversations WHERE id=?").bind(conversationId).first();
      if (!c) {
        await env.DB.prepare("INSERT INTO chat_conversations (id,stage,created_at,updated_at) VALUES (?,'collecting',?,?)").bind(conversationId, now, now).run();
        c = { id: conversationId, stage: "collecting" };
      }

      // Save user message
      if (userMessage) await saveMessage(env, conversationId, "user", userMessage);

      // ── Safety check (deterministic, always runs first) ──
      if (detectUrgentRisk(userMessage)) {
        await saveMessage(env, conversationId, "assistant", safetyReply);
        await env.DB.prepare("UPDATE chat_conversations SET stage='safety',updated_at=? WHERE id=?").bind(now, conversationId).run();
        return json({ conversation_id: conversationId, reply: safetyReply, options: [], lead_saved: Boolean(c.lead_id), show_checkout: false, stage: "safety", risk_level: "urgent" });
      }

      // ── Closing / follow-up stage (lead already saved) ──
      if (c.stage === "closing" || c.stage === "follow_up" || c.stage === "declined") {
        const ai = await aiClose(env, c, userMessage);
        await saveMessage(env, conversationId, "assistant", ai.reply);
        await env.DB.prepare("UPDATE chat_conversations SET stage=?,updated_at=? WHERE id=?").bind(ai.stage, now, conversationId).run();
        return json({ conversation_id: conversationId, reply: ai.reply, options: [], lead_saved: Boolean(c.lead_id), show_checkout: ai.show_checkout, checkout_url: STRIPE_URL, stage: ai.stage });
      }

      // ── Collecting stage: AI-driven empathetic conversation ──
      const recentMessages = await getRecentMessages(env, conversationId, 12);
      const aiResult = await aiChat(env, c, userMessage, recentMessages, pagePath);

      let reply, options = [];

      if (aiResult) {
        reply = aiResult.reply;
        options = aiResult.options;

        // Validate and merge AI-extracted lead data (server-side enforcement)
        const validated = validateAndMergeLead(c, aiResult.lead || {});

        // Persist any newly collected fields to D1
        const fieldsToUpdate = ["area", "concern", "name", "phone", "email", "preferred_contact", "best_contact_time", "sms_consent", "summary"];
        const updates = [];
        const values = [];
        for (const f of fieldsToUpdate) {
          if (validated[f] !== undefined && validated[f] !== c[f] && validated[f] !== null && validated[f] !== "") {
            updates.push(`${f}=?`);
            values.push(validated[f]);
            c[f] = validated[f]; // update in-memory copy
          }
        }
        if (updates.length > 0) {
          values.push(now, conversationId);
          await env.DB.prepare(`UPDATE chat_conversations SET ${updates.join(",")},updated_at=? WHERE id=?`).bind(...values).run();
        }
      } else {
        // ── Fallback: rigid prompt flow (if AI fails) ──
        if (userMessage) {
          const expected = nextPrompt(c);
          if (expected) {
            let accepted = true; let value = userMessage;
            if (expected.field === "email") { value = userMessage.toLowerCase(); accepted = validEmail(value); }
            if (expected.field === "phone") accepted = validPhone(userMessage);
            if (!accepted) {
              const fallbackReply = expected.field === "email" ? "Please enter a valid email address." : "Please enter a valid phone number with at least 10 digits.";
              await saveMessage(env, conversationId, "assistant", fallbackReply);
              return json({ conversation_id: conversationId, reply: fallbackReply, field: expected.field });
            }
            if (expected.field === "sms_consent") value = userMessage.toLowerCase().includes("agree") ? 1 : 2;
            await env.DB.prepare(`UPDATE chat_conversations SET ${expected.field}=?,updated_at=? WHERE id=?`).bind(value, now, conversationId).run();
            c[expected.field] = value;
          }
        }
        const next = nextPrompt(c);
        if (next) {
          reply = next.reply;
          options = next.options || [];
        } else {
          reply = "Your information has been saved. A LifeRise representative will reach out soon.";
        }
      }

      // ── Check if lead is ready (server-side computed) ──
      if (leadIsReady(c) && !c.lead_id) {
        const smsConsent = c.sms_consent === 1;
        const summary = `${c.area}: ${c.concern}`;
        const lead = { name: c.name, email: c.email, phone: c.phone, area: c.area, concern: c.concern, preferred_contact: c.preferred_contact, best_contact_time: c.best_contact_time, summary, sms_consent: smsConsent, conversation_id: conversationId };
        const leadId = await saveLead(env, request, lead, "chatbot");
        await env.DB.prepare("UPDATE chat_conversations SET lead_id=?,summary=?,stage='closing',updated_at=? WHERE id=?").bind(leadId, summary, now, conversationId).run();
        c.lead_id = leadId; c.summary = summary; c.stage = "closing";
        ctx.waitUntil(Promise.all([notify(env, lead), saveEvent(env, request, { event_name: "lead_submitted", page_path: pagePath, session_id: clean(body.session_id, 120), lead_id: leadId, conversation_id: conversationId, metadata: { source: "chatbot" } })]));

        // Use AI for the closing message
        const ai = await aiClose(env, c, "The lead information has just been saved. Introduce the trial naturally.");
        await saveMessage(env, conversationId, "assistant", ai.reply);
        return json({ conversation_id: conversationId, reply: ai.reply, options: [], lead_saved: true, show_checkout: ai.show_checkout, checkout_url: STRIPE_URL, stage: ai.stage });
      }

      // ── Normal response ──
      await saveMessage(env, conversationId, "assistant", reply);
      return json({ conversation_id: conversationId, reply, options, lead_saved: Boolean(c.lead_id), show_checkout: false, stage: c.stage || "collecting" });
      } catch (error) {
        console.error("Chat handler error:", error);
        const fallbackReply = "I'm here to help. Could you tell me a little about what's been on your mind?";
        return json({ conversation_id: body?.conversation_id || uuid(), reply: fallbackReply, options: [], lead_saved: false, show_checkout: false, stage: "collecting" });
      }
    }

    return json({ error: "Not found" }, 404);
  }
};
