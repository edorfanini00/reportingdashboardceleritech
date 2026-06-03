# CeleriTech Marketing Dashboard

Marketing reporting dashboard for CeleriTech, deployed at [reportingdashboardceleritech.vercel.app](https://reportingdashboardceleritech.vercel.app).

## Dashboards

| Page | URL | Purpose |
|------|-----|---------|
| Production | `/index.html` | Historical data + live GHL leads merged |
| **GHL test** | `/ghl.html` | GHL-only view; import all past leads via API |

## GoHighLevel sync (two ways)

1. **Webhook (real-time)** — workflow POSTs to `/api/webhook` when tag `meta` or `meta fda` is added.
2. **Bulk import (all past leads)** — open **GHL Test Dashboard** → **Import all from GHL**, or `POST /api/sync`.

Leads are bucketed into **calendar weeks (Sun–Sat)** from each contact’s `dateAdded` / created date. New weeks appear automatically in the week picker.

## Vercel environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `KV_REST_API_URL` | Yes (auto) | From Vercel Storage / Upstash Redis |
| `KV_REST_API_TOKEN` | Yes (auto) | From Vercel Storage |
| `GHL_API_KEY` or `GHL_ACCESS_TOKEN` | For bulk import | Private integration token from GHL |
| `GHL_LOCATION_ID` | For bulk import | Location ID (from GHL URL when viewing contacts) |
| `WEBHOOK_SECRET` | Optional | Secures `/api/webhook` |
| `SYNC_SECRET` | Optional | Secures `/api/sync` (falls back to `WEBHOOK_SECRET`) |

**Do not use Blob storage** — use Redis/KV.

### Get GHL API credentials

1. GHL → **Settings → Private Integrations** (or Developer Marketplace app).
2. Create a token with **contacts.readonly** (or contacts scope).
3. Copy **Location ID** from your dashboard URL when viewing Contacts.

## GHL workflow (webhook)

- **Trigger:** Contact Tag Added → `meta` or `meta fda`
- **Action:** Webhook POST → `https://reportingdashboardceleritech.vercel.app/api/webhook`

## API

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/webhook` | POST | Ingest one contact from GHL workflow |
| `/api/sync` | POST/GET | Pull **all** contacts tagged meta / meta fda from GHL API |
| `/api/leads` | GET | List stored leads for dashboards |

## Repository

[github.com/edorfanini00/reportingdashboardceleritech](https://github.com/edorfanini00/reportingdashboardceleritech.git)
