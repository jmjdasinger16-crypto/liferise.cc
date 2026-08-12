const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const root = __dirname;
const port = Number(process.env.PORT || 3000);
const maxBodyBytes = 32 * 1024;
const conversations = new Map();
const rateBuckets = new Map();

const stages = {
  DISCOVERY: 'discovery',
  OUTCOME: 'desired_outcome',
  NAME: 'name',
  CONTACT_METHOD: 'contact_method',
  CONTACT_DETAILS: 'contact_details',
  AVAILABILITY: 'availability',
  CONSENT: 'consent',
  CHECKOUT: 'checkout'
};

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

const systemPrompt = `You are the LifeRise virtual assistant. LifeRise provides empathetic lifestyle coaching and practical accountability across mindset, health, nutrition, money, career, parenting, relationships, routines, confidence, purpose, and social connection.

Conversation style:
- Sound warm, calm, human, and respectful, while clearly remaining an AI assistant.
- Acknowledge the visitor's feelings or situation before asking a question.
- Ask only one useful question at a time.
- Do not interrogate, pressure, shame, diagnose, or make unrealistic promises.
- Keep most replies between 2 and 5 sentences.
- Help the visitor identify the smallest useful next step.
- Gradually collect contact details only after providing value and building trust.
- Never claim to be a therapist, doctor, lawyer, financial adviser, or emergency service.

LifeRise facts:
- LifeRise offers lifestyle coaching, education, accountability, and practical support.
- It is not medical, mental-health, legal, or financial professional care.
- Membership is $18 every two weeks after a 3-day trial.
- A representative may contact the visitor to continue the conversation and build a game plan.

Lead collection:
The server supplies the current conversation stage. Stay within that stage, acknowledge what the visitor said, and ask only the next stage's one question. Never skip ahead or recommend the trial before the checkout stage.
Collect: primary life area during discovery, desired outcome, name, preferred contact method and matching details, availability, and finally explicit consent to have a LifeRise representative contact them. Do not ask for information already present.

Safety:
If the visitor appears in immediate danger, mentions suicide, self-harm, harming someone else, abuse requiring urgent protection, overdose, or a medical emergency, respond compassionately and direct them to call 911 or their local emergency number now. Encourage them to contact a trusted person nearby. Do not continue ordinary coaching or sales questions in that response.

Return only valid JSON with this exact shape:
{
  "reply": "string",
  "lead": {
    "name": null,
    "email": null,
    "phone": null,
    "preferred_contact": null,
    "primary_area": null,
    "desired_outcome": null,
    "availability": null,
    "summary": null,
    "consent_to_contact": false
  },
  "options": [],
  "show_checkout": false,
  "lead_ready": false,
  "risk_level": "normal"
}`;

function safePath(urlPath) {
  const decoded = decodeURIComponent(urlPath.split('?')[0]);
  const normalized = path.normalize(decoded).replace(/^([.][.][/\\])+/, '');
  return path.join(root, normalized);
}

function addArticlesNavigation(html) {
  return html.replace(/<nav>([\s\S]*?)<\/nav>/g, (fullNav, links) => {
    let updatedLinks = links.replace(/(<a\b[^>]*href=["'][^"']*(?:resources\/|\.\/)[^"']*["'][^>]*>)Resources(<\/a>)/i, '$1Articles$2');

    if (/href=["']\/resources\/?["']/i.test(updatedLinks) || />Articles<\/a>/i.test(updatedLinks)) {
      return `<nav>${updatedLinks}</nav>`;
    }

    const articlesLink = '<a href="/resources/">Articles</a>';
    const faqPattern = /(<a\b[^>]*>FAQ<\/a>)/i;

    if (faqPattern.test(updatedLinks)) {
      updatedLinks = updatedLinks.replace(faqPattern, `$1${articlesLink}`);
    } else {
      updatedLinks += articlesLink;
    }

    return `<nav>${updatedLinks}</nav>`;
  });
}


function addClientPortalLink(html) {
  return html.replace(/<div class="navright">([\s\S]*?)<\/div>/, (full, links) => {
    if (/portal\//i.test(links) || />Client Login<\/a>/i.test(links)) return full;
    const portalLink = '<a class="text-link" href="/portal/">Client Login</a>';
    return `<div class="navright">${portalLink}${links}</div>`;
  });
}

function sendJson(res, status, payload) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(JSON.stringify(payload));
}

function getClientIp(req) {
  return String(req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown')
    .split(',')[0]
    .trim();
}

function isRateLimited(req) {
  const key = getClientIp(req);
  const now = Date.now();
  const windowMs = 60 * 1000;
  const limit = 20;
  const bucket = rateBuckets.get(key) || [];
  const recent = bucket.filter(timestamp => now - timestamp < windowMs);
  recent.push(now);
  rateBuckets.set(key, recent);
  return recent.length > limit;
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > maxBodyBytes) {
        reject(new Error('Request too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function detectUrgentRisk(message) {
  return /\b(suicide|kill myself|end my life|self[- ]?harm|hurt myself|kill someone|hurt someone|overdose|can't breathe|medical emergency|immediate danger)\b/i.test(message);
}

function fallbackReply(message, lead) {
  if (!message) {
    return {
      reply: 'I’m glad you reached out. You do not have to sort out everything at once. What part of life feels heaviest or most stuck right now?',
      options: ['Mindset or stress', 'Health or energy', 'Money or career', 'Relationships or family', 'Something else']
    };
  }

  if (detectUrgentRisk(message)) {
    return {
      reply: 'I’m really sorry you’re facing this. Please call 911 or your local emergency number now if you or someone else may be in immediate danger, and contact a trusted person who can stay with you. I’m an AI coaching assistant and cannot provide emergency help.',
      options: []
    };
  }

  const stage = getStage(lead);
  if (stage === stages.DISCOVERY) {
    return {
      reply: 'Thank you for sharing that. It sounds like this has been taking up a lot of your energy, and we can take it one piece at a time. Which part of that situation feels most important to talk through first?',
      options: ['Mindset or stress', 'Health or energy', 'Money or career', 'Relationships or family', 'Something else']
    };
  }

  const replies = {
    [stages.OUTCOME]: ['That makes sense, and it helps to name what you want rather than trying to fix everything at once. If things improved, what would a meaningful result look like for you?', []],
    [stages.NAME]: ['That sounds like a worthwhile direction. What name would you like us to use?', []],
    [stages.CONTACT_METHOD]: [`Thanks${lead.name ? `, ${lead.name}` : ''}. If you decide you want follow-up, would email or phone be more comfortable for you?`, ['Email', 'Phone call', 'Text message']],
    [stages.CONTACT_DETAILS]: [`Got it. What ${lead.preferred_contact === 'email' ? 'email address' : 'phone number'} should we use?`, []],
    [stages.AVAILABILITY]: ['Thank you. What days or times are usually easiest for a brief conversation?', ['Weekday mornings', 'Weekday afternoons', 'Weekday evenings', 'Weekends']],
    [stages.CONSENT]: [`I appreciate you walking me through this. To confirm, may a LifeRise representative contact you by ${lead.preferred_contact || 'your preferred method'} to discuss a simple game plan?`, ['Yes, I consent', 'No, not right now']],
    [stages.CHECKOUT]: ['Thank you—I have what the team needs to follow up thoughtfully. If you would also like to explore the 3-day trial now, you can use the optional checkout link below; there is no need to decide today.', ['View the 3-day trial', 'I have another question']]
  };
  const [reply, options] = replies[stage];
  return { reply, options, show_checkout: stage === stages.CHECKOUT };
}

function normalizeLead(value = {}) {
  return {
    name: value.name || null,
    email: value.email || null,
    phone: value.phone || null,
    preferred_contact: value.preferred_contact || null,
    primary_area: value.primary_area || null,
    desired_outcome: value.desired_outcome || null,
    availability: value.availability || null,
    summary: value.summary || null,
    consent_to_contact: value.consent_to_contact === true
  };
}

function mergeLead(existing, incoming) {
  const normalized = normalizeLead(incoming);
  return Object.fromEntries(Object.entries(existing).map(([key, value]) => [key, normalized[key] ?? value]));
}

function hasContactDetails(lead) {
  return lead.preferred_contact === 'email' ? Boolean(lead.email) : Boolean(lead.phone);
}

function getStage(lead) {
  if (!lead.primary_area) return stages.DISCOVERY;
  if (!lead.desired_outcome) return stages.OUTCOME;
  if (!lead.name) return stages.NAME;
  if (!lead.preferred_contact) return stages.CONTACT_METHOD;
  if (!hasContactDetails(lead)) return stages.CONTACT_DETAILS;
  if (!lead.availability) return stages.AVAILABILITY;
  if (!lead.consent_to_contact) return stages.CONSENT;
  return stages.CHECKOUT;
}

function extractLeadFromMessage(message, stage) {
  const value = message.trim();
  const lead = {};
  const email = value.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0];
  const phone = value.match(/(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/)?.[0];

  if (stage === stages.DISCOVERY && value) lead.primary_area = value;
  if (stage === stages.OUTCOME && value) lead.desired_outcome = value;
  if (stage === stages.NAME && /^[a-z][a-z .'-]{1,79}$/i.test(value)) lead.name = value.replace(/^(?:i(?:'m| am)|my name is)\s+/i, '').trim();
  if (stage === stages.CONTACT_METHOD) {
    if (/email/i.test(value)) lead.preferred_contact = 'email';
    else if (/text|sms/i.test(value)) lead.preferred_contact = 'text';
    else if (/phone|call/i.test(value)) lead.preferred_contact = 'phone';
  }
  if (stage === stages.CONTACT_DETAILS) {
    if (email) lead.email = email;
    if (phone) lead.phone = phone;
  }
  if (stage === stages.AVAILABILITY && value) lead.availability = value;
  if (stage === stages.CONSENT && /\b(yes|i consent|you may|okay|sure)\b/i.test(value) && !/\b(no|not|don't|do not)\b/i.test(value)) {
    lead.consent_to_contact = true;
  }
  return lead;
}

function leadIsReady(lead) {
  return Boolean(lead.primary_area && lead.desired_outcome && lead.name && lead.preferred_contact && hasContactDetails(lead) && lead.availability && lead.consent_to_contact);
}

function canShowCheckout(lead, requested, checkoutUrl) {
  return Boolean(getStage(lead) === stages.CHECKOUT && leadIsReady(lead) && requested && checkoutUrl);
}

function extractJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    return match ? JSON.parse(match[0]) : null;
  }
}

async function callAi(messages, stage, lead) {
  const apiKey = process.env.AI_API_KEY || process.env.OPENAI_API_KEY;
  const endpoint = process.env.AI_API_URL || 'https://api.openai.com/v1/chat/completions';
  const model = process.env.AI_MODEL || 'gpt-4.1-mini';
  if (!apiKey) return null;

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      temperature: 0.6,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'system', content: `Server-controlled stage: ${stage}. Collected lead data: ${JSON.stringify(lead)}. Do not ask about later stages. show_checkout and lead_ready must be false unless stage is checkout.` },
        ...messages
      ]
    }),
    signal: AbortSignal.timeout(20000)
  });

  if (!response.ok) {
    throw new Error(`AI provider returned ${response.status}`);
  }

  const payload = await response.json();
  const content = payload.choices?.[0]?.message?.content;
  return content ? extractJson(content) : null;
}

async function handleChat(req, res) {
  if (isRateLimited(req)) {
    sendJson(res, 429, { reply: 'You’ve sent several messages quickly. Please wait a moment and try again.' });
    return;
  }

  try {
    const body = await readJson(req);
    const message = String(body.message || '').trim().slice(0, 2000);
    const conversationId = String(body.conversation_id || crypto.randomUUID());
    const current = conversations.get(conversationId) || {
      messages: [],
      lead: normalizeLead(),
      createdAt: Date.now()
    };

    const urgentRisk = detectUrgentRisk(message);
    if (!urgentRisk) {
      const stageBeforeMessage = getStage(current.lead);
      current.lead = mergeLead(current.lead, extractLeadFromMessage(message, stageBeforeMessage));
    }

    if (message) current.messages.push({ role: 'user', content: message });
    current.messages = current.messages.slice(-16);

    let result;
    if (urgentRisk) {
      result = {
        reply: 'I’m really sorry you’re facing this. Please call 911 or your local emergency number now if you or someone else may be in immediate danger, and contact a trusted person who can stay with you. I’m an AI coaching assistant and cannot provide emergency help.',
        lead: current.lead,
        options: [],
        show_checkout: false,
        lead_ready: false,
        risk_level: 'urgent'
      };
    } else {
      try {
        result = await callAi(current.messages, getStage(current.lead), current.lead);
      } catch (error) {
        console.error('AI chat error:', error.message);
      }

      if (!result) {
        const fallback = fallbackReply(message, current.lead);
        result = {
          ...fallback,
          lead: current.lead,
          show_checkout: Boolean(fallback.show_checkout),
          lead_ready: false,
          risk_level: 'normal'
        };
      }
    }

    // The model may summarize, but only server-side parsing can advance stages or grant consent.
    if (typeof result.lead?.summary === 'string' && result.lead.summary.trim()) {
      current.lead.summary = result.lead.summary.trim().slice(0, 1000);
    }
    current.messages.push({ role: 'assistant', content: String(result.reply || '') });
    current.messages = current.messages.slice(-16);
    conversations.set(conversationId, current);

    const checkoutUrl = process.env.STRIPE_CHECKOUT_URL || '';
    const leadReady = leadIsReady(current.lead);
    const stage = getStage(current.lead);

    sendJson(res, 200, {
      conversation_id: conversationId,
      reply: String(result.reply || 'What would you like help working through today?'),
      options: Array.isArray(result.options) ? result.options.slice(0, 5).map(String) : [],
      stage,
      show_checkout: canShowCheckout(current.lead, result.show_checkout, checkoutUrl),
      checkout_url: checkoutUrl || undefined,
      lead_ready: leadReady,
      risk_level: result.risk_level || 'normal'
    });
  } catch (error) {
    sendJson(res, 400, { error: error.message || 'Invalid request', reply: 'I could not understand that request. Please try again.' });
  }
}

function sendFile(res, filePath) {
  fs.stat(filePath, (statError, stat) => {
    if (statError) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }

    let resolvedPath = filePath;
    if (stat.isDirectory()) resolvedPath = path.join(filePath, 'index.html');

    fs.readFile(resolvedPath, (readError, data) => {
      if (readError) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Not found');
        return;
      }

      const ext = path.extname(resolvedPath).toLowerCase();
      const body = ext === '.html' ? Buffer.from(addClientPortalLink(addArticlesNavigation(data.toString('utf8')))) : data;
      res.writeHead(200, {
        'Content-Type': mimeTypes[ext] || 'application/octet-stream',
        'Cache-Control': ext === '.xml' ? 'no-cache' : 'public, max-age=300',
        'X-Content-Type-Options': 'nosniff'
      });
      res.end(body);
    });
  });
}

const server = http.createServer(async (req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;

  if (req.method === 'POST' && pathname === '/api/chat') {
    await handleChat(req, res);
    return;
  }

  if (pathname.startsWith('/api/')) {
    sendJson(res, 404, { error: 'API route not found' });
    return;
  }

  const requestPath = pathname === '/' ? '/index.html' : pathname;
  const filePath = safePath(requestPath);

  if (!filePath.startsWith(root)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Forbidden');
    return;
  }

  sendFile(res, filePath);
});

if (require.main === module) {
  server.listen(port, '0.0.0.0', () => {
    console.log(`LifeRise server listening on port ${port}`);
    console.log(`AI chat ${process.env.AI_API_KEY || process.env.OPENAI_API_KEY ? 'enabled' : 'running in fallback mode'}`);
  });
}

module.exports = { server, getStage, extractLeadFromMessage, leadIsReady, canShowCheckout, stages };
