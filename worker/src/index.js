const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  }
});

const clean = (value, max = 2000) => String(value ?? "").trim().slice(0, max);
const escapeHtml = (value) => clean(value).replace(/[&<>'"]/g, (char) => ({
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  "'": "&#39;",
  '"': "&quot;"
}[char]));

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/api/health") {
      return json({ ok: true, service: "liferise-form-api" });
    }

    if (request.method !== "POST" || url.pathname !== "/api/leads") {
      return json({ error: "Not found" }, 404);
    }

    let data;
    try {
      data = await request.json();
    } catch {
      return json({ error: "Invalid request body." }, 400);
    }

    const name = clean(data.name, 120);
    const email = clean(data.email, 254).toLowerCase();
    const phone = clean(data.phone, 40);
    const area = clean(data.area, 160);
    const message = clean(data.message, 4000);
    const comfort = clean(data.comfort, 240);

    if (!name || !email || !phone) {
      return json({ error: "Name, email, and phone number are required." }, 400);
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return json({ error: "Please enter a valid email address." }, 400);
    }

    const submittedAt = new Date().toISOString();
    const ip = request.headers.get("CF-Connecting-IP") || null;
    const userAgent = clean(request.headers.get("User-Agent"), 500) || null;

    const result = await env.DB.prepare(`
      INSERT INTO coaching_leads
        (name, email, phone, area, message, comfort, status, submitted_at, ip_address, user_agent)
      VALUES (?, ?, ?, ?, ?, ?, 'new', ?, ?, ?)
    `).bind(name, email, phone, area, message, comfort, submittedAt, ip, userAgent).run();

    const leadId = result.meta?.last_row_id;

    ctx.waitUntil(
      env.EMAIL.send({
        from: "LifeRise Forms <notifications@liferise.cc>",
        to: "support@liferise.cc",
        replyTo: email,
        subject: `New LifeRise coaching request — ${name}`,
        text: [
          `New LifeRise coaching request`,
          `Lead ID: ${leadId ?? "Pending"}`,
          `Submitted: ${submittedAt}`,
          `Name: ${name}`,
          `Email: ${email}`,
          `Phone: ${phone}`,
          `Support area: ${area || "Not specified"}`,
          `Preferred first step: ${comfort || "Not specified"}`,
          `Message: ${message || "No message provided"}`
        ].join("\n"),
        html: `
          <h2>New LifeRise coaching request</h2>
          <p><strong>Lead ID:</strong> ${escapeHtml(leadId ?? "Pending")}</p>
          <p><strong>Submitted:</strong> ${escapeHtml(submittedAt)}</p>
          <p><strong>Name:</strong> ${escapeHtml(name)}</p>
          <p><strong>Email:</strong> <a href="mailto:${escapeHtml(email)}">${escapeHtml(email)}</a></p>
          <p><strong>Phone:</strong> <a href="tel:${escapeHtml(phone)}">${escapeHtml(phone)}</a></p>
          <p><strong>Support area:</strong> ${escapeHtml(area || "Not specified")}</p>
          <p><strong>Preferred first step:</strong> ${escapeHtml(comfort || "Not specified")}</p>
          <p><strong>Message:</strong><br>${escapeHtml(message || "No message provided").replace(/\n/g, "<br>")}</p>
        `
      }).catch((error) => console.error("Email notification failed", error))
    );

    return json({
      success: true,
      message: "Thank you. Your request has been received and a LifeRise representative will contact you soon."
    }, 201);
  }
};
