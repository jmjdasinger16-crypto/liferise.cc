# LifeRise contact form Worker

This Worker saves contact-form submissions to Cloudflare D1, sends a notification email to `support@liferise.cc`, powers the marketing AI chatbot, the admin dashboard, and the **client portal** (Stripe-gated client accounts, notes, goals, call requests, and the goal-coaching AI chat).

## Cloudflare setup

1. From this `worker` directory, install Wrangler:
   `npm install -D wrangler`
2. Log in:
   `npx wrangler login`
3. Create the database:
   `npx wrangler d1 create liferise-leads`
4. Copy the returned database ID into `wrangler.jsonc`, replacing `REPLACE_WITH_D1_DATABASE_ID`.
5. Apply the schema (safe to re-run — all statements use `IF NOT EXISTS`):
   `npx wrangler d1 execute liferise-leads --remote --file=./schema.sql`
6. In Cloudflare, onboard `liferise.cc` under **Compute > Email Service > Email Sending** and confirm the required DNS records.
7. Set the required secrets (see **Secrets** below).
8. Deploy:
   `npx wrangler deploy`
9. In the Worker dashboard, add a route for:
   `liferise.cc/api/*`

The website form posts to `/api/leads`, so the route must point that path to this Worker.

## Secrets

Set each with `npx wrangler secret put SECRET_NAME`:

- `ADMIN_PASSWORD` — password for the admin dashboard (`/admin.html`).
- `ADMIN_SESSION_SECRET` — random string used to sign admin session cookies.
- `CLIENT_SESSION_SECRET` — random string used to sign client-portal session cookies (new — required for the client portal to work). Generate one with `openssl rand -hex 32`.
- `STRIPE_SECRET_KEY` — your Stripe secret key (`sk_live_...` or `sk_test_...`). Used server-side to verify checkout sessions during activation and to look up session details. Only needs read access to Checkout Sessions.
- `STRIPE_WEBHOOK_SECRET` — the signing secret for the Stripe webhook endpoint below (`whsec_...`).

## Client portal setup (Stripe → trial → portal access)

The client portal unlocks automatically once someone completes checkout via your Stripe Payment Link.

1. **Configure a webhook endpoint** in the Stripe Dashboard (Developers → Webhooks) pointing to:
   `https://liferise.cc/api/stripe/webhook`
   Subscribe to these events: `checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted`.
   Copy the generated signing secret into `STRIPE_WEBHOOK_SECRET`.
2. **Update the Payment Link's post-payment redirect.** In the Stripe Dashboard, edit the Payment Link (`https://buy.stripe.com/5kQ3cu0rQ9ssbIG2NR6sw04`) → **After payment** → choose "Redirect customers to your website" and set the URL to:
   `https://liferise.cc/portal/activate.html?session_id={CHECKOUT_SESSION_ID}`
   Stripe automatically substitutes `{CHECKOUT_SESSION_ID}` with the real session ID on redirect — this is a supported, documented Stripe feature.
3. Once a customer pays, the webhook creates a `clients` row (status `trial`, 3-day trial), and the redirect lets them set a password immediately at `/portal/activate.html`. If they close the browser before setting a password, an admin can generate a fresh activation link at any time from **Admin → Clients → Reset password** (`POST /api/admin/clients/:id/reset-password`), which returns a shareable `https://liferise.cc/portal/activate.html?token=...` link.
4. Client status stays in sync automatically as the subscription changes (`trialing` → `trial`, `active` → `active`, `past_due`/`unpaid`/`incomplete_expired` → `past_due`, `canceled` → `canceled`) via the `customer.subscription.updated`/`deleted` events.

### Client portal routes

- Public: `/api/stripe/webhook`, `/api/portal/activate`, `/api/portal/set-password`, `/api/portal/login`, `/api/portal/logout`
- Client (cookie-authenticated): `/api/portal/me`, `/api/portal/notes`, `/api/portal/goals`, `/api/portal/call-requests`, `/api/portal/chat`, `/api/portal/chat/history`
- Admin (existing admin cookie): `/api/admin/clients`, `/api/admin/clients/:id`, `/api/admin/clients/:id/notes`, `/api/admin/clients/:id/goals`, `/api/admin/call-requests`, `/api/admin/clients/:id/reset-password`

Static portal pages live in `/portal/` at the repo root (served by the Railway `server.js` static host, same as the rest of the site) — `portal/index.html` (login), `portal/activate.html` (set password after Stripe checkout or an admin-issued link), and `portal/dashboard.html` (notes, goals, call requests, AI chat).
