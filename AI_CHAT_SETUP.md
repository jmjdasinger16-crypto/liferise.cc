# LifeRise AI Chat Setup

The LifeRise chat bubble calls `POST /api/chat`, handled by a Cloudflare Worker. The entire conversation is now powered by Cloudflare Workers AI (`@cf/meta/llama-3.1-8b-instruct`) for empathetic, natural conversation — not a rigid form wizard.

## Architecture

- **AI-driven conversation**: Every message in the collecting stage goes through Workers AI with an empathetic system prompt.
- **Natural lead extraction**: The AI extracts lead fields (name, email, phone, area, etc.) from the natural flow of conversation — no fixed question order.
- **Server-side validation**: All AI-extracted data is validated before saving to D1 (email format, phone digits, field whitelists).
- **Server-side readiness**: Lead readiness is computed deterministically — never trusted to the AI.
- **Safety detection**: Urgent-risk language (suicide, self-harm, etc.) is detected deterministically before AI runs. Crisis responses override all other logic.
- **Checkout gating**: The Stripe checkout link is only shown after a lead is saved and the conversation reaches the closing stage.
- **Graceful fallback**: If Workers AI fails or times out, the chat falls back to a rigid prompt flow so the conversation never breaks.
- **Conversation history**: Recent messages are fetched from D1 for context (not in-memory state).

## Cloudflare Worker bindings

- `DB`: D1 database binding for `chat_conversations`, `chat_messages`, `coaching_leads`, and `site_events` tables.
- `AI`: Workers AI binding for `@cf/meta/llama-3.1-8b-instruct`.
- `EMAIL`: Email binding (e.g., SendGrid) for lead notifications to `support@liferise.cc`.

## Worker environment variables

- `ADMIN_PASSWORD`: secret for admin dashboard login.
- `ADMIN_SESSION_SECRET`: secret for signing admin session cookies.

No external AI API key is needed — Workers AI is used directly via the `env.AI` binding.

## Conversation stages

1. **collecting** — AI-driven empathetic conversation that naturally gathers lead info.
2. **closing** — Lead saved; AI introduces the 3-day trial and checkout.
3. **follow_up** — Visitor has follow-up questions after checkout is shown.
4. **declined** — Visitor declined the trial; conversation ends gracefully.
5. **safety** — Urgent risk detected; crisis resources provided, no lead collection.

## Verification

After deploying, open the LifeRise site and test:

1. A normal coaching conversation — the AI should respond empathetically and naturally.
2. Sharing a name, phone, and email in natural sentences — the AI should extract them.
3. Asking about price and the 3-day trial.
4. Completing all lead fields — the checkout link should appear.
5. An urgent safety phrase to confirm that crisis response overrides normal flow.
6. The fallback flow (if Workers AI is temporarily unavailable).
