# CeleriTech Marketing Dashboard

Marketing reporting dashboard for CeleriTech, deployed at [reportingdashboardceleritech.vercel.app](https://reportingdashboardceleritech.vercel.app).

Leads from **GoHighLevel** with tags **`meta`** or **`meta fda`** sync automatically into the dashboard via webhook.

## GoHighLevel setup

### 1. Deploy to Vercel

1. Push this repo to GitHub and import the project in [Vercel](https://vercel.com).
2. In the Vercel project → **Storage** → create a **KV** (or Upstash Redis) database and connect it to the project. This sets `KV_REST_API_URL` and `KV_REST_API_TOKEN`.
3. Redeploy after storage is linked.

### 2. Optional webhook secret

In Vercel → **Settings → Environment Variables**, add:

| Variable | Description |
|----------|-------------|
| `WEBHOOK_SECRET` | Optional shared secret. GHL must send it as header `x-webhook-secret` or query `?secret=` |

### 3. Create GHL workflows

Create **two** workflows (or one with OR logic) in GoHighLevel:

**Workflow A — tag `meta`**

- **Trigger:** Contact Tag Added → tag is `meta`
- **Action:** Webhook (POST)
- **URL:** `https://YOUR-DOMAIN.vercel.app/api/webhook`
- **Body:** send full contact payload (default GHL webhook fields are fine)

**Workflow B — tag `meta fda`**

- **Trigger:** Contact Tag Added → tag is `meta fda`
- **Action:** Same webhook URL as above

If you set `WEBHOOK_SECRET`, add a custom header `x-webhook-secret: YOUR_SECRET` in the webhook action.

### 4. Backfill existing contacts (optional)

For contacts already tagged before the webhook existed, run each contact through the workflow once (remove and re-add the tag), or POST sample payloads to `/api/webhook` with curl.

### What gets synced

| GHL tag | Dashboard pipeline |
|---------|-------------------|
| `meta` | Meta Lead |
| `meta fda` | FDA |

Other tags are ignored. The dashboard merges GHL leads with existing historical data and deduplicates by contact id or email.

## Local development

```bash
npm install
npx vercel dev
```

Open `http://localhost:3000`. API routes need Vercel dev (or linked env vars) for `/api/leads` and `/api/webhook`.

## API

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/webhook` | POST | Receives GoHighLevel contact webhooks |
| `/api/leads` | GET | Returns all stored GHL leads for the dashboard |

## Repository

[github.com/edorfanini00/reportingdashboardceleritech](https://github.com/edorfanini00/reportingdashboardceleritech.git)
