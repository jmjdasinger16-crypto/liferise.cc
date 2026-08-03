const STRIPE_URL = "https://buy.stripe.com/5kQ3cu0rQ9ssbIG2NR6sw04";
const SESSION_COOKIE = "liferise_admin";
const SESSION_TTL_SECONDS = 60 * 60 * 8;
const CLIENT_SESSION_COOKIE = "liferise_client";
const CLIENT_SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;
const ACTIVATION_TTL_MS = 30 * 60 * 1000;
const TRIAL_DAYS = 3;
const json = (body, status = 200, extraHeaders = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extraHeaders } });
const clean = (value, max = 2000) => String(value ?? "").trim().slice(0, max);
const validEmail = (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
const validPhone = (value) => String(value ?? "").replace(/\D/g, "").length >= 10;
const uuid = () => crypto.randomUUID();
const encoder = new TextEncoder();

const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
const b64urlText = (text) => b64url(encoder.encode(text));
const b64urlToBytes = (str) => {
  const normalized = String(str || "").replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
};
const toHex = (bytes) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
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

/* ══════════════════════════════ CLIENT PORTAL ══════════════════════════════ */

async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await crypto.subtle.importKey("raw", encoder.encode(password), { name: "PBKDF2" }, false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" }, keyMaterial, 256);
  return `pbkdf2$100000$${b64url(salt)}$${b64url(new Uint8Array(bits))}`;
}

async function verifyPassword(password, stored) {
  const parts = String(stored || "").split("$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2") return false;
  const iterations = Number(parts[1]) || 100000;
  const salt = b64urlToBytes(parts[2]);
  const expected = b64url(b64urlToBytes(parts[3]));
  const keyMaterial = await crypto.subtle.importKey("raw", encoder.encode(password), { name: "PBKDF2" }, false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations, hash: "SHA-256" }, keyMaterial, 256);
  return timingSafeEqual(b64url(new Uint8Array(bits)), expected);
}

async function createClientSessionToken(env, clientId) {
  const payload = b64urlText(JSON.stringify({ cid: clientId, exp: Math.floor(Date.now() / 1000) + CLIENT_SESSION_TTL_SECONDS, nonce: uuid() }));
  return `${payload}.${await hmac(env.CLIENT_SESSION_SECRET, payload)}`;
}

function clientCookieHeader(token, maxAge = CLIENT_SESSION_TTL_SECONDS) {
  return `${CLIENT_SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;
}

async function getAuthedClient(request, env) {
  const token = parseCookies(request)[CLIENT_SESSION_COOKIE];
  if (!token || !env.CLIENT_SESSION_SECRET) return null;
  const [payload, signature] = token.split(".");
  if (!payload || !signature) return null;
  if (!timingSafeEqual(signature, await hmac(env.CLIENT_SESSION_SECRET, payload))) return null;
  try {
    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
    const decoded = JSON.parse(atob(normalized + "=".repeat((4 - normalized.length % 4) % 4)));
    if (!decoded.exp || decoded.exp <= Math.floor(Date.now() / 1000) || !decoded.cid) return null;
    return await env.DB.prepare("SELECT * FROM clients WHERE id=?").bind(decoded.cid).first();
  } catch { return null; }
}

function mapSubscriptionStatus(stripeStatus) {
  if (stripeStatus === "trialing") return "trial";
  if (stripeStatus === "active") return "active";
  if (["past_due", "unpaid", "incomplete", "incomplete_expired"].includes(stripeStatus)) return "past_due";
  if (stripeStatus === "canceled") return "canceled";
  return null;
}

async function stripeApi(env, path) {
  if (!env.STRIPE_SECRET_KEY) return { ok: false, status: 503, data: { error: "Stripe is not configured." } };
  const res = await fetch(`https://api.stripe.com/v1/${path}`, { headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` } });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

async function verifyStripeSignature(rawBody, sigHeader, secret) {
  if (!sigHeader || !secret) return false;
  const parts = Object.fromEntries(sigHeader.split(",").map((p) => { const i = p.indexOf("="); return [p.slice(0, i), p.slice(i + 1)]; }));
  if (!parts.t || !parts.v1) return false;
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(`${parts.t}.${rawBody}`));
  return timingSafeEqual(toHex(signature), parts.v1);
}

async function findClientById(env, id) {
  return env.DB.prepare("SELECT * FROM clients WHERE id=?").bind(id).first();
}

async function upsertClientFromCheckoutSession(env, session) {
  const email = clean(session.customer_details?.email || session.customer_email || "", 254).toLowerCase();
  if (!validEmail(email)) return null;
  const name = clean(session.customer_details?.name || "", 120) || null;
  const phone = clean(session.customer_details?.phone || "", 40) || null;
  const customerId = session.customer || null;
  const subscriptionId = session.subscription || null;
  const now = new Date().toISOString();
  const trialEnds = new Date(Date.now() + TRIAL_DAYS * 24 * 60 * 60 * 1000).toISOString();

  const existing = await env.DB.prepare("SELECT * FROM clients WHERE email=? OR (stripe_customer_id IS NOT NULL AND stripe_customer_id=?)").bind(email, customerId).first();
  if (existing) {
    await env.DB.prepare("UPDATE clients SET stripe_customer_id=COALESCE(stripe_customer_id,?), stripe_subscription_id=COALESCE(?,stripe_subscription_id), name=COALESCE(name,?), phone=COALESCE(phone,?), updated_at=? WHERE id=?")
      .bind(customerId, subscriptionId, name, phone, now, existing.id).run();
    return findClientById(env, existing.id);
  }

  const lead = await env.DB.prepare("SELECT id FROM coaching_leads WHERE email=? ORDER BY submitted_at DESC LIMIT 1").bind(email).first();
  const result = await env.DB.prepare(`INSERT INTO clients
    (stripe_customer_id, stripe_subscription_id, email, phone, name, status, trial_ends_at, source_lead_id, created_at, updated_at)
    VALUES (?,?,?,?,?,'trial',?,?,?,?)`)
    .bind(customerId, subscriptionId, email, phone, name, trialEnds, lead?.id || null, now, now).run();
  return findClientById(env, result.meta?.last_row_id);
}

async function issueActivationToken(env, clientId) {
  const token = uuid().replace(/-/g, "") + uuid().replace(/-/g, "");
  const expires = new Date(Date.now() + ACTIVATION_TTL_MS).toISOString();
  await env.DB.prepare("UPDATE clients SET activation_nonce=?, activation_nonce_expires=?, updated_at=? WHERE id=?").bind(token, expires, new Date().toISOString(), clientId).run();
  return token;
}

const goalCoachSystemPrompt = (client, goals, notes) => `You are the LifeRise Coaching Assistant inside the private client portal. You are talking with ${client.name || "a LifeRise client"}, who is already an enrolled LifeRise member. Your job is to help them stay motivated and take practical next steps on the goals their human coach has set for them — not to replace their coach.

Rules:
- Be warm, encouraging, and specific. Keep most replies to 2-5 sentences.
- Ground every response in the client's actual goals listed below. Do not invent new goals; help them work toward the ones their coach set.
- Offer small, realistic next steps, encouragement, and reflection questions. Celebrate progress.
- If the client wants to change a goal, adjust a plan, or needs to talk to a human, gently suggest they use the "Request a call with your coach" feature in the portal.
- Never diagnose, prescribe, or act as a medical, mental-health, legal, or financial professional.
- If the client expresses thoughts of self-harm, suicide, abuse, or describes a medical emergency, respond with care, urge them to call 911 or a crisis line immediately, and stop normal coaching for that reply.

Client's current goals (set by their coach):
${goals.length ? goals.map((g, i) => `${i + 1}. ${g.title}${g.description ? ` — ${g.description}` : ""}${g.target_date ? ` (target: ${g.target_date})` : ""}`).join("\n") : "No goals have been set yet — encourage the client to request a call with their coach to set some."}

Recent notes from the coach that are visible to this client:
${notes.length ? notes.map((n) => `- ${n.content}`).join("\n") : "(none yet)"}

Respond only with plain conversational text (not JSON).`;

async function portalChat(env, client, userMessage, recentMessages) {
  const goals = (await env.DB.prepare("SELECT title, description, target_date FROM client_goals WHERE client_id=? AND status='active' ORDER BY created_at DESC").bind(client.id).all()).results || [];
  const notes = (await env.DB.prepare("SELECT content FROM client_notes WHERE client_id=? AND visibility='client' ORDER BY created_at DESC LIMIT 5").bind(client.id).all()).results || [];
  const system = goalCoachSystemPrompt(client, goals, notes);
  const messages = [{ role: "system", content: system }, ...recentMessages.map((m) => ({ role: m.role, content: m.content })), { role: "user", content: userMessage }];
  try {
    const out = await env.AI.run("@cf/meta/llama-3.1-8b-fast-v2", { messages, max_tokens: 400 });
    const text = clean(out.response || out.result || (typeof out === "string" ? out : ""), 2000);
    return text || "I'm here to help you work toward your goals. What would you like to focus on today?";
  } catch (error) {
    console.error("Portal chat AI error:", error?.message || error);
    return "I'm having trouble responding right now. In the meantime, you can review your goals above or request a call with your coach.";
  }
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

async function notifyCallRequest(env, client, callRequest) {
  try {
    await env.EMAIL.send({
      from: "LifeRise Portal <notifications@liferise.cc>", to: "support@liferise.cc", replyTo: client.email,
      subject: `Client call request — ${client.name || client.email}`,
      text: `Client: ${client.name || "(no name)"}\nEmail: ${client.email}\nPhone: ${client.phone || "n/a"}\nPreferred time: ${callRequest.preferred_time || "n/a"}\nReason: ${callRequest.reason || "n/a"}`
    });
  } catch (error) { console.error("Call request email notification failed", error); }
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
  if (incoming.sms_consent === true && merged.sms_consent !== 1) {
    merged.sms_consent = 1;
  }
  return merged;
}

/* ── Focused AI system prompt ── */
const chatSystemPrompt = `You are the LifeRise virtual assistant. Your primary goal is to warmly collect lead information and guide visitors toward starting a 3-day trial. LifeRise provides lifestyle coaching across mindset, health, nutrition, money, career, parenting, relationships, routines, confidence, purpose, and social connection.

Conversation rules — follow these strictly:
- Be warm and acknowledge feelings, but keep replies SHORT: 1-3 sentences max.
- Acknowledge what the visitor said in ONE sentence, then immediately ask for the next missing piece of lead information.
- Do NOT ask open-ended follow-up questions like "tell me more about that" or "what else is going on." Those derail the conversation.
- Do NOT offer coaching advice, tips, or suggestions during the collection phase. Your job is to collect lead info and close the trial, not to coach.
- Every reply must move the conversation toward collecting the next missing field. Never reply without advancing toward a lead field or checkout.
- If the visitor goes off-topic, gently redirect: acknowledge briefly, then ask for the next needed field.
- Use quick-reply options whenever possible to reduce typing friction.

Lead collection order (follow this priority when possible):
1. area — What area of life they want help with
2. concern — Briefly what's going on (1-2 sentences is enough, do not probe deeply)
3. name — What to call them
4. phone — Best phone number
5. email — Email address
6. preferred_contact — Phone call, text, or email
7. best_contact_time — Morning, afternoon, evening, or anytime
8. sms_consent — Agree to be contacted by phone, text, and email

Once all fields are collected and consent is given, transition to closing:
- Recommend the 3-day trial naturally.
- Mention membership is $18 every two weeks after the trial.
- Set show_checkout to true.
- Do not push hard or create false urgency. One clear recommendation, then let them decide.

LifeRise facts:
- Lifestyle coaching, education, accountability, and practical support.
- Not medical, mental-health, legal, or financial professional care.
- Membership is $18 every two weeks after a 3-day trial.
- A representative may contact them to continue the conversation.

Safety:
- If the visitor mentions suicide, self-harm, harming someone, abuse, overdose, or a medical emergency, respond compassionately, tell them to call 911 now, and set risk_level to "urgent". Do not continue collecting lead info in that response.

Return ONLY valid JSON with this exact shape:
{
  "reply": "your response",
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

Only populate lead fields the visitor explicitly shared in their latest message. Use null for everything else. Set show_checkout to true ONLY when all fields are collected and consent is given. Keep options as an array of short quick-reply strings (max 4), or empty array if free-text is more appropriate.`;

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
Latest visitor message: ${userMessage || "(conversation just started — greet the visitor warmly and ask what area of life they want help with)"}

Respond to the visitor. If they shared any lead information, extract it into the lead object. Ask for the NEXT missing field only. Remember: only extract what they actually said — never guess or fabricate information.`;

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

    /* ══════════════ PUBLIC CLIENT-PORTAL ROUTES ══════════════ */

    if (request.method === "POST" && url.pathname === "/api/stripe/webhook") {
      if (!env.STRIPE_WEBHOOK_SECRET) return json({ error: "Stripe webhook is not configured." }, 503);
      const rawBody = await request.text();
      const sig = request.headers.get("Stripe-Signature");
      if (!(await verifyStripeSignature(rawBody, sig, env.STRIPE_WEBHOOK_SECRET))) return json({ error: "Invalid signature." }, 400);
      let event; try { event = JSON.parse(rawBody); } catch { return json({ error: "Invalid payload." }, 400); }

      try {
        if (event.type === "checkout.session.completed") {
          const session = event.data?.object || {};
          const client = await upsertClientFromCheckoutSession(env, session);
          if (client) await issueActivationToken(env, client.id);
        } else if (event.type === "customer.subscription.updated" || event.type === "customer.subscription.deleted") {
          const sub = event.data?.object || {};
          const status = event.type === "customer.subscription.deleted" ? "canceled" : mapSubscriptionStatus(sub.status);
          if (status && sub.customer) {
            await env.DB.prepare("UPDATE clients SET status=?, stripe_subscription_id=COALESCE(stripe_subscription_id,?), updated_at=? WHERE stripe_customer_id=?")
              .bind(status, sub.id || null, new Date().toISOString(), sub.customer).run();
          }
        }
      } catch (error) { console.error("Stripe webhook processing error:", error?.message || error); }

      return json({ received: true });
    }

    if (request.method === "POST" && url.pathname === "/api/portal/activate") {
      let data; try { data = await request.json(); } catch { return json({ error: "Invalid request body." }, 400); }
      const sessionId = clean(data.session_id, 200);
      const token = clean(data.token, 200);
      let client = null;

      if (token) {
        client = await env.DB.prepare("SELECT * FROM clients WHERE activation_nonce=?").bind(token).first();
        if (!client || !client.activation_nonce_expires || new Date(client.activation_nonce_expires).getTime() < Date.now()) {
          return json({ error: "This activation link is invalid or has expired. Please contact your coach for a new link." }, 400);
        }
      } else if (sessionId) {
        const stripeRes = await stripeApi(env, `checkout/sessions/${encodeURIComponent(sessionId)}`);
        if (!stripeRes.ok) return json({ error: "We couldn't verify your checkout session. Please contact support@liferise.cc." }, 400);
        if (stripeRes.data.payment_status !== "paid" && stripeRes.data.status !== "complete") {
          return json({ error: "Your checkout has not finished processing yet. Please try again in a moment." }, 400);
        }
        client = await upsertClientFromCheckoutSession(env, stripeRes.data);
        if (!client) return json({ error: "We couldn't find an email on this checkout session. Please contact support@liferise.cc." }, 400);
        if (!client.activation_nonce || !client.activation_nonce_expires || new Date(client.activation_nonce_expires).getTime() < Date.now()) {
          await issueActivationToken(env, client.id);
          client = await findClientById(env, client.id);
        }
      } else {
        return json({ error: "Missing activation session or token." }, 400);
      }

      return json({
        activation_token: client.activation_nonce,
        email: client.email,
        name: client.name,
        already_has_password: Boolean(client.password_hash)
      });
    }

    if (request.method === "POST" && url.pathname === "/api/portal/set-password") {
      let data; try { data = await request.json(); } catch { return json({ error: "Invalid request body." }, 400); }
      const token = clean(data.token, 200);
      const password = String(data.password || "");
      if (!token) return json({ error: "Missing activation token." }, 400);
      if (password.length < 8) return json({ error: "Password must be at least 8 characters." }, 400);

      const client = await env.DB.prepare("SELECT * FROM clients WHERE activation_nonce=?").bind(token).first();
      if (!client || !client.activation_nonce_expires || new Date(client.activation_nonce_expires).getTime() < Date.now()) {
        return json({ error: "This activation link is invalid or has expired. Please contact your coach for a new link." }, 400);
      }

      const passwordHash = await hashPassword(password);
      const now = new Date().toISOString();
      await env.DB.prepare("UPDATE clients SET password_hash=?, activation_nonce=NULL, activation_nonce_expires=NULL, last_login_at=?, updated_at=? WHERE id=?")
        .bind(passwordHash, now, now, client.id).run();

      const sessionToken = await createClientSessionToken(env, client.id);
      return json({ success: true }, 200, { "set-cookie": clientCookieHeader(sessionToken) });
    }

    if (request.method === "POST" && url.pathname === "/api/portal/login") {
      let data; try { data = await request.json(); } catch { return json({ error: "Invalid request body." }, 400); }
      if (!env.CLIENT_SESSION_SECRET) return json({ error: "Client portal is not configured." }, 503);
      const email = clean(data.email, 254).toLowerCase();
      const password = String(data.password || "");
      if (!validEmail(email) || !password) return json({ error: "Please provide a valid email and password." }, 400);

      const client = await env.DB.prepare("SELECT * FROM clients WHERE email=?").bind(email).first();
      if (!client || !client.password_hash || !(await verifyPassword(password, client.password_hash))) {
        return json({ error: "Incorrect email or password." }, 401);
      }
      await env.DB.prepare("UPDATE clients SET last_login_at=? WHERE id=?").bind(new Date().toISOString(), client.id).run();
      const token = await createClientSessionToken(env, client.id);
      return json({ success: true }, 200, { "set-cookie": clientCookieHeader(token) });
    }

    if (request.method === "POST" && url.pathname === "/api/portal/logout") {
      return json({ success: true }, 200, { "set-cookie": clientCookieHeader("", 0) });
    }

    /* ══════════════ AUTHENTICATED CLIENT-PORTAL ROUTES ══════════════ */

    if (url.pathname.startsWith("/api/portal/") && !["/api/portal/activate", "/api/portal/set-password", "/api/portal/login", "/api/portal/logout"].includes(url.pathname)) {
      const client = await getAuthedClient(request, env);
      if (!client) return json({ error: "Unauthorized." }, 401);

      if (request.method === "GET" && url.pathname === "/api/portal/me") {
        return json({ client: { id: client.id, email: client.email, name: client.name, phone: client.phone, status: client.status, trial_ends_at: client.trial_ends_at } });
      }

      if (request.method === "GET" && url.pathname === "/api/portal/notes") {
        const notes = await env.DB.prepare("SELECT id, author, content, created_at, updated_at FROM client_notes WHERE client_id=? AND visibility='client' ORDER BY created_at DESC LIMIT 200").bind(client.id).all();
        return json({ notes: notes.results || [] });
      }

      if (request.method === "GET" && url.pathname === "/api/portal/goals") {
        const goals = await env.DB.prepare("SELECT id, title, description, target_date, status, created_at, updated_at FROM client_goals WHERE client_id=? ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'completed' THEN 1 ELSE 2 END, created_at DESC LIMIT 200").bind(client.id).all();
        return json({ goals: goals.results || [] });
      }

      if (request.method === "GET" && url.pathname === "/api/portal/call-requests") {
        const requests = await env.DB.prepare("SELECT id, reason, preferred_time, status, scheduled_at, created_at FROM call_requests WHERE client_id=? ORDER BY created_at DESC LIMIT 100").bind(client.id).all();
        return json({ call_requests: requests.results || [] });
      }

      if (request.method === "POST" && url.pathname === "/api/portal/call-requests") {
        let data; try { data = await request.json(); } catch { return json({ error: "Invalid request body." }, 400); }
        const reason = clean(data.reason, 1000);
        const preferredTime = clean(data.preferred_time, 200);
        const now = new Date().toISOString();
        const result = await env.DB.prepare("INSERT INTO call_requests (client_id, reason, preferred_time, status, created_at, updated_at) VALUES (?,?,?,'pending',?,?)")
          .bind(client.id, reason, preferredTime, now, now).run();
        const callRequest = { id: result.meta?.last_row_id, reason, preferred_time: preferredTime, status: "pending", created_at: now };
        ctx.waitUntil(notifyCallRequest(env, client, callRequest));
        return json({ success: true, call_request: callRequest }, 201);
      }

      if (request.method === "GET" && url.pathname === "/api/portal/chat/history") {
        const history = await env.DB.prepare("SELECT role, content, created_at FROM portal_chat_messages WHERE client_id=? ORDER BY created_at ASC LIMIT 200").bind(client.id).all();
        return json({ messages: history.results || [] });
      }

      if (request.method === "POST" && url.pathname === "/api/portal/chat") {
        let data; try { data = await request.json(); } catch { return json({ error: "Invalid request body." }, 400); }
        const userMessage = clean(data.message, 2000);
        if (!userMessage) return json({ error: "Message cannot be empty." }, 400);
        const now = new Date().toISOString();

        const recent = (await env.DB.prepare("SELECT role, content FROM portal_chat_messages WHERE client_id=? ORDER BY created_at DESC LIMIT 12").bind(client.id).all()).results || [];
        recent.reverse();

        await env.DB.prepare("INSERT INTO portal_chat_messages (client_id, role, content, created_at) VALUES (?,'user',?,?)").bind(client.id, userMessage, now).run();
        const reply = await portalChat(env, client, userMessage, recent);
        await env.DB.prepare("INSERT INTO portal_chat_messages (client_id, role, content, created_at) VALUES (?,'assistant',?,?)").bind(client.id, reply, new Date().toISOString()).run();

        return json({ reply });
      }

      return json({ error: "Not found" }, 404);
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

      if (request.method === "GET" && url.pathname === "/api/admin/clients") {
        const clients = await env.DB.prepare(`SELECT id, email, name, phone, status, trial_ends_at, created_at, last_login_at,
          (SELECT COUNT(*) FROM call_requests cr WHERE cr.client_id = clients.id AND cr.status='pending') pending_call_requests
          FROM clients ORDER BY created_at DESC LIMIT 500`).all();
        return json({ clients: clients.results || [] });
      }

      const clientDetailMatch = url.pathname.match(/^\/api\/admin\/clients\/(\d+)$/);
      if (request.method === "GET" && clientDetailMatch) {
        const id = Number(clientDetailMatch[1]);
        const client = await findClientById(env, id);
        if (!client) return json({ error: "Client not found." }, 404);
        const notes = await env.DB.prepare("SELECT id, author, content, visibility, created_at, updated_at FROM client_notes WHERE client_id=? ORDER BY created_at DESC LIMIT 200").bind(id).all();
        const goals = await env.DB.prepare("SELECT id, title, description, target_date, status, created_at, updated_at FROM client_goals WHERE client_id=? ORDER BY created_at DESC LIMIT 200").bind(id).all();
        const callRequests = await env.DB.prepare("SELECT id, reason, preferred_time, status, scheduled_at, coach_notes, created_at, updated_at FROM call_requests WHERE client_id=? ORDER BY created_at DESC LIMIT 200").bind(id).all();
        const { password_hash, activation_nonce, ...safeClient } = client;
        return json({ client: safeClient, notes: notes.results || [], goals: goals.results || [], call_requests: callRequests.results || [] });
      }

      if (request.method === "PATCH" && clientDetailMatch) {
        let data; try { data = await request.json(); } catch { return json({ error: "Invalid request body." }, 400); }
        const id = Number(clientDetailMatch[1]);
        const allowedStatuses = ["trial", "active", "past_due", "canceled"];
        const client = await findClientById(env, id);
        if (!client) return json({ error: "Client not found." }, 404);
        const status = allowedStatuses.includes(clean(data.status, 30)) ? clean(data.status, 30) : client.status;
        const name = data.name !== undefined ? clean(data.name, 120) : client.name;
        const phone = data.phone !== undefined ? clean(data.phone, 40) : client.phone;
        await env.DB.prepare("UPDATE clients SET status=?, name=?, phone=?, updated_at=? WHERE id=?")
          .bind(status, name, phone, new Date().toISOString(), id).run();
        return json({ success: true, client: await findClientById(env, id) });
      }

      const clientNotesMatch = url.pathname.match(/^\/api\/admin\/clients\/(\d+)\/notes$/);
      if (request.method === "POST" && clientNotesMatch) {
        let data; try { data = await request.json(); } catch { return json({ error: "Invalid request body." }, 400); }
        const clientId = Number(clientNotesMatch[1]);
        const content = clean(data.content, 5000);
        if (!content) return json({ error: "Note content is required." }, 400);
        const visibility = data.visibility === "internal" ? "internal" : "client";
        const now = new Date().toISOString();
        const result = await env.DB.prepare("INSERT INTO client_notes (client_id, author, content, visibility, created_at, updated_at) VALUES (?,'coach',?,?,?,?)")
          .bind(clientId, content, visibility, now, now).run();
        return json({ success: true, note: { id: result.meta?.last_row_id, author: "coach", content, visibility, created_at: now } }, 201);
      }

      const noteMatch = url.pathname.match(/^\/api\/admin\/clients\/(\d+)\/notes\/(\d+)$/);
      if (request.method === "PATCH" && noteMatch) {
        let data; try { data = await request.json(); } catch { return json({ error: "Invalid request body." }, 400); }
        const [, clientId, noteId] = noteMatch;
        const content = clean(data.content, 5000);
        const visibility = data.visibility === "internal" ? "internal" : "client";
        if (!content) return json({ error: "Note content is required." }, 400);
        await env.DB.prepare("UPDATE client_notes SET content=?, visibility=?, updated_at=? WHERE id=? AND client_id=?")
          .bind(content, visibility, new Date().toISOString(), noteId, clientId).run();
        return json({ success: true });
      }

      const clientGoalsMatch = url.pathname.match(/^\/api\/admin\/clients\/(\d+)\/goals$/);
      if (request.method === "POST" && clientGoalsMatch) {
        let data; try { data = await request.json(); } catch { return json({ error: "Invalid request body." }, 400); }
        const clientId = Number(clientGoalsMatch[1]);
        const title = clean(data.title, 200);
        if (!title) return json({ error: "Goal title is required." }, 400);
        const description = clean(data.description, 2000);
        const targetDate = clean(data.target_date, 40) || null;
        const now = new Date().toISOString();
        const result = await env.DB.prepare("INSERT INTO client_goals (client_id, title, description, target_date, status, created_at, updated_at) VALUES (?,?,?,?,'active',?,?)")
          .bind(clientId, title, description, targetDate, now, now).run();
        return json({ success: true, goal: { id: result.meta?.last_row_id, title, description, target_date: targetDate, status: "active", created_at: now } }, 201);
      }

      const goalMatch = url.pathname.match(/^\/api\/admin\/clients\/(\d+)\/goals\/(\d+)$/);
      if (request.method === "PATCH" && goalMatch) {
        let data; try { data = await request.json(); } catch { return json({ error: "Invalid request body." }, 400); }
        const [, clientId, goalId] = goalMatch;
        const allowedStatuses = ["active", "completed", "archived"];
        const title = clean(data.title, 200);
        const description = clean(data.description, 2000);
        const targetDate = clean(data.target_date, 40) || null;
        const status = allowedStatuses.includes(clean(data.status, 30)) ? clean(data.status, 30) : "active";
        await env.DB.prepare("UPDATE client_goals SET title=?, description=?, target_date=?, status=?, updated_at=? WHERE id=? AND client_id=?")
          .bind(title, description, targetDate, status, new Date().toISOString(), goalId, clientId).run();
        return json({ success: true });
      }

      if (request.method === "GET" && url.pathname === "/api/admin/call-requests") {
        const status = clean(url.searchParams.get("status"), 30);
        const clause = status ? " WHERE cr.status = ?" : "";
        const bindings = status ? [status] : [];
        const requests = await env.DB.prepare(`SELECT cr.id, cr.client_id, cr.reason, cr.preferred_time, cr.status, cr.scheduled_at, cr.coach_notes, cr.created_at,
          c.name AS client_name, c.email AS client_email, c.phone AS client_phone
          FROM call_requests cr JOIN clients c ON c.id = cr.client_id${clause} ORDER BY cr.created_at DESC LIMIT 200`).bind(...bindings).all();
        return json({ call_requests: requests.results || [] });
      }

      const callRequestMatch = url.pathname.match(/^\/api\/admin\/call-requests\/(\d+)$/);
      if (request.method === "PATCH" && callRequestMatch) {
        let data; try { data = await request.json(); } catch { return json({ error: "Invalid request body." }, 400); }
        const id = Number(callRequestMatch[1]);
        const allowedStatuses = ["pending", "scheduled", "completed", "canceled"];
        const status = allowedStatuses.includes(clean(data.status, 30)) ? clean(data.status, 30) : "pending";
        const scheduledAt = clean(data.scheduled_at, 50) || null;
        const coachNotes = clean(data.coach_notes, 5000);
        await env.DB.prepare("UPDATE call_requests SET status=?, scheduled_at=?, coach_notes=?, updated_at=? WHERE id=?")
          .bind(status, scheduledAt, coachNotes, new Date().toISOString(), id).run();
        return json({ success: true });
      }

      const resetPasswordMatch = url.pathname.match(/^\/api\/admin\/clients\/(\d+)\/reset-password$/);
      if (request.method === "POST" && resetPasswordMatch) {
        const id = Number(resetPasswordMatch[1]);
        const client = await findClientById(env, id);
        if (!client) return json({ error: "Client not found." }, 404);
        const token = await issueActivationToken(env, id);
        return json({ success: true, activation_url: `https://liferise.cc/portal/activate.html?token=${token}` });
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
      let body;
      try {
      body = await request.json();
      } catch { return json({ error: "Invalid request body." }, 400); }
      try {
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

      // ── Collecting stage: AI-driven conversation ──
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
            c[f] = validated[f];
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
