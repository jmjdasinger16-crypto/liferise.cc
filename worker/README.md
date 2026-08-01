# LifeRise contact form Worker

This Worker saves contact-form submissions to Cloudflare D1 and sends a notification email to `support@liferise.cc`.

## Cloudflare setup

1. From this `worker` directory, install Wrangler:
   `npm install -D wrangler`
2. Log in:
   `npx wrangler login`
3. Create the database:
   `npx wrangler d1 create liferise-leads`
4. Copy the returned database ID into `wrangler.jsonc`, replacing `REPLACE_WITH_D1_DATABASE_ID`.
5. Apply the schema:
   `npx wrangler d1 execute liferise-leads --remote --file=./schema.sql`
6. In Cloudflare, onboard `liferise.cc` under **Compute > Email Service > Email Sending** and confirm the required DNS records.
7. Deploy:
   `npx wrangler deploy`
8. In the Worker dashboard, add a route for:
   `liferise.cc/api/*`

The website form posts to `/api/leads`, so the route must point that path to this Worker.
