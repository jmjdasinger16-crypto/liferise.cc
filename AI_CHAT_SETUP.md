# LifeRise AI Chat Setup

The LifeRise chat bubble calls `POST /api/chat`. The Node server now supports empathetic AI conversations through an OpenAI-compatible chat-completions endpoint.

## Railway environment variables

Add these variables to the Railway service:

- `AI_API_KEY`: secret API key for the selected AI provider.
- `AI_API_URL`: optional OpenAI-compatible endpoint. Defaults to `https://api.openai.com/v1/chat/completions`.
- `AI_MODEL`: optional model name. Defaults to `gpt-4.1-mini`.
- `STRIPE_CHECKOUT_URL`: optional checkout URL shown only when the assistant recommends checkout.

A Cloudflare AI Gateway endpoint can be used as `AI_API_URL`, allowing the main website to remain on Railway while Cloudflare handles AI observability and gateway controls.

## Current behavior

- Empathetic, one-question-at-a-time conversation style.
- Structured internal lead extraction.
- Contact-consent requirement before a lead is considered ready.
- Emergency-language detection with immediate emergency guidance.
- Per-IP request throttling and request-size limits.
- A built-in non-AI fallback when the key or provider is unavailable.
- Conversation history is held in server memory and limited to recent messages.

## Important production limitation

Conversation and lead state currently lives in process memory. Railway restarts or multiple replicas will not share that state. Before relying on the assistant as the permanent lead system, connect it to a durable store such as Cloudflare D1, Railway Postgres, or another database and create the representative notification workflow.

## Verification

After deploying, open the LifeRise site and test:

1. A normal coaching conversation.
2. Asking about price and the 3-day trial.
3. Sharing a name and contact method.
4. Declining consent to contact.
5. An urgent safety phrase to confirm that ordinary lead collection stops.
6. Removing the API key temporarily to verify fallback mode.
