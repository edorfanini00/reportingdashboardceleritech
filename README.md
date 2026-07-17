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
| `oil and gas` / `meta oil and gas lead` | Oil & Gas |
| `metodo campaign` | Metodo |
| `metodo alimentacion` | Metodo Alimentacion |
| `metodo oil&gas campaign` | Metodo Oil & Gas |
| `metodo contenedores` | Metodo Contenedores |
| `en miami neighborhoods` / `es miami neighborhood` | Miami Neighborhood |

A `... meeting booked` tag (e.g. `metodo meeting booked`) also marks the lead as *Meeting Booked* in the funnel. Other tags are ignored. The dashboard merges GHL leads with existing historical data and deduplicates by contact id or email.

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
| `/api/sync` | GET/POST | Bulk-imports tagged contacts from GoHighLevel |
| `/api/agent` | POST | AI assistant: Claude agent that operates on GoHighLevel via tool use |

## AI Assistant (dashboard chat)

The dashboard has an **AI Assistant** tab (left panel) — a ChatGPT-style chat where
an Anthropic Claude agent can search, tag, update, and create contacts &
opportunities in GoHighLevel via the API. **Write actions are confirmation-gated**:
the agent always describes the change and waits for you to approve before it
mutates anything (enforced server-side in `api/_lib/agent-tools.js`).

To enable it, add to Vercel → Settings → Environment Variables:

| Variable | Description |
|----------|-------------|
| `ANTHROPIC_API_KEY` | Anthropic API key (required for the assistant) |
| `ANTHROPIC_MODEL` | Optional, defaults to `claude-sonnet-4-6` |

It reuses the existing `GHL_API_KEY` / `GHL_LOCATION_ID` for all CRM actions.

## Tagging contacts John shared by email (`sentbyjhon`)

`scripts/tag-sentbyjhon.js` scans **your Outlook/Microsoft 365 inbox** for emails
**from John**, extracts the contacts he wrote in the email bodies (email / phone /
name / company), matches them against the GoHighLevel CRM, and adds a
`sentbyjhon` tag to each match.

It is a **dry run by default** (reports what it found, changes nothing). Add
`--apply` to actually write the tag. Only email/phone matches are auto-tagged;
name-only matches are listed for manual review.

### 1. Create an Azure App Registration (one time)

1. Go to [portal.azure.com](https://portal.azure.com) → **Microsoft Entra ID**
   → **App registrations** → **New registration**.
2. Name it e.g. `sentbyjohn-tagger`. Under **Supported account types** pick
   *Accounts in this organizational directory only* (or multitenant if unsure).
   Leave Redirect URI blank. Click **Register**.
3. On the app **Overview**, copy the **Application (client) ID** → `MS_CLIENT_ID`
   and the **Directory (tenant) ID** → `MS_TENANT_ID`.
4. Go to **Authentication** → **Advanced settings** → set **Allow public client
   flows** to **Yes** → **Save**. (Required for device-code sign-in.)
5. Go to **API permissions** → **Add a permission** → **Microsoft Graph** →
   **Delegated permissions** → search **`Mail.Read`** → add it. If your tenant
   shows "admin consent required", click **Grant admin consent** (or ask an
   admin). `offline_access` is included automatically.

### 2. Configure env vars

```bash
cp scripts/.env.example scripts/.env
# then edit scripts/.env with MS_CLIENT_ID, MS_TENANT_ID, JOHN_EMAIL,
# GHL_API_KEY, GHL_LOCATION_ID
```

### 3. Run

```bash
npm install
npm run tag:sentbyjohn          # dry run: shows what would be tagged
npm run tag:sentbyjohn:apply    # actually applies the sentbyjhon tag
```

On first run it prints a URL and a code — open the URL, sign in with **your**
Microsoft 365 account, and the script continues automatically.

### "Synced Jhon" tab (dashboard)

The **Synced Jhon** sidebar tab and **Sync John** button use a review-first workflow:

1. **Sync John** — scans John's emails and imports leads into a dashboard queue (no GoHighLevel writes).
2. **Review** — pending leads show checkboxes. Contacts from the same company are flagged so you can pick the right one (avoids duplicate uploads).
3. **Send Selected** — uploads only the leads you chose to GoHighLevel:
   - **New contacts** → create contact + opportunity in **Enterpryze** / **ERP Qualified**, assigned to **Natalie**, source **Enterpryze**, tag **sentbyjhon**
   - **Existing contacts** → tag + source only (no duplicate opportunity)

If there are no pending leads, the tab shows **No new contacts**.

Because the deployed button can't do an interactive Microsoft login, seed a refresh
token once: after a local login, copy `refresh_token` from `scripts/.ms-token.json`
into a Vercel env var **`MS_REFRESH_TOKEN`** (plus the existing `MS_CLIENT_ID`,
`MS_TENANT_ID`, `JOHN_EMAIL`). The token rotates automatically into KV afterward; if
it ever expires (~90 days unused), re-run the local login and reseed.

## Repository

[github.com/edorfanini00/reportingdashboardceleritech](https://github.com/edorfanini00/reportingdashboardceleritech.git)
