# Instagram API Setup — Post from Content-Sprout

This guide walks you through connecting your **Instagram Professional** account
so the UI can publish feed posts (single image or carousel) via the Meta Graph API.

**Time:** ~20–30 minutes the first time.

---

## What you need before starting

| Requirement | Status |
|---|---|
| Instagram **Professional** account (Business or Creator) | You converted yours ✓ |
| Instagram linked to a **Facebook Page** | Do this in Instagram → Settings → Account Centre |
| A **Facebook** account (admin on that Page) | Required for login |
| A **Meta Developer** app | Created below |
| **Public HTTPS URL** for images | ngrok tunnel — see Step 5 |

Instagram feed posts only support **portrait**, **square**, and **landscape**
formats from this app (not story).

---

## Step 1 — Link Instagram to a Facebook Page

If you did not connect a Page when converting to Professional:

1. Instagram app → **Profile** → **☰** → **Settings and privacy**
2. **Account Centre** → **Sharing to other apps** (or **Linked accounts**)
3. Connect or create a **Facebook Page**

Verify in [Meta Business Suite](https://business.facebook.com/) that the Page
shows your Instagram account.

---

## Step 2 — Create a Meta Developer app

1. Go to [developers.facebook.com](https://developers.facebook.com/) and register.
2. **My Apps → Create App** → choose **Business**.
3. Add the **Instagram** product → **Instagram API with Facebook Login**.
4. Open **App settings → Basic** and note:
   - **App ID**
   - **App Secret** (click Show)

Leave the app in **Development** mode — that is enough to post to **your own**
account while you build.

---

## Step 3 — Configure Content-Sprout

**Option A — use the UI (recommended)**

1. Start the UI: `./start-ui.sh`
2. Click **Instagram setup** in the header
3. Fill in App ID, App Secret, public ngrok URL, etc.
4. Click **Save settings**, then **Run check**

**Option B — edit `config.yaml` manually**

Edit `config.yaml` (or use environment variables):

```yaml
instagram:
  enabled: true
  app_id: "YOUR_APP_ID"
  app_secret: "YOUR_APP_SECRET"
  oauth_redirect_uri: http://127.0.0.1:17829/api/instagram/callback
  public_base_url: ""   # filled in Step 5
```

Or export secrets without putting them in the file:

```bash
export META_APP_ID="your_app_id"
export META_APP_SECRET="your_app_secret"
```

### Add the OAuth redirect URI in Meta

In your Meta app → **Facebook Login → Settings** (or **Instagram → API setup**):

- **Valid OAuth Redirect URIs:**  
  `http://127.0.0.1:17829/api/instagram/callback`

Use the same port you run the UI on (`start-ui.sh` defaults to **17829**).

---

## Step 4 — Add yourself as an app user

In Development mode, only app **Admins**, **Developers**, and **Testers** can log in.

1. Meta app → **App roles → Roles**
2. Add your Facebook account as **Administrator** (or Developer)

---

## Step 5 — Expose the UI over public HTTPS (required for publishing)

Meta downloads your images from a URL. It **cannot** reach `localhost`.

### Option A — ngrok (quickest for local dev)

```bash
# Terminal 1 — UI + watcher (if not already running)
cd /Users/sridhar/Documents/Projects/CtrlFabric/personal_projects/Content-Sprout
./start-ui.sh

# Terminal 2 — tunnel to the UI port
ngrok http 17829
```

Copy the **https** URL ngrok prints (e.g. `https://abc123.ngrok-free.app`).

Set it in `config.yaml`:

```yaml
instagram:
  public_base_url: "https://abc123.ngrok-free.app"
```

Or:

```bash
export CONTENT_SPROUT_PUBLIC_BASE_URL="https://abc123.ngrok-free.app"
```

Restart the UI after changing config.

> **Note:** If ngrok restarts, the URL changes — update `public_base_url` each time
> unless you use a fixed ngrok domain.

### Option B — Deploy the UI to a server with HTTPS

Point `public_base_url` at your deployed origin (e.g. `https://content-sprout.example.com`).

---

## Step 6 — Connect Instagram in the UI

1. Start the UI: `./start-ui.sh`
2. Click **Connect Instagram** in the header (or inside the post dialog).
3. Log in with Facebook and approve permissions:
   - `instagram_basic`
   - `instagram_content_publish`
   - `pages_show_list`
   - `pages_read_engagement`
4. You should return to the UI with “Instagram connected” and your `@username`.

Tokens are saved locally in `cache/instagram_session.json` (gitignored).

---

## Step 7 — Publish your first post

1. Process at least one photo (drop into `input/` while watch mode runs).
2. Click **Post to Instagram** in the Output panel (or open a group → **Post to Instagram**).
3. Select one or more images (up to **10** for a carousel).
4. Enter a **title** and **description**, or click **Suggest text**.
5. Click **Publish**.

The app:

1. Builds public image URLs from `public_base_url`
2. Creates media container(s) on the Graph API
3. Publishes to your feed

---

## Permissions reference

| Permission | Used for |
|---|---|
| `instagram_basic` | Profile + listing media |
| `instagram_content_publish` | Creating and publishing posts |
| `pages_show_list` | Finding your Facebook Pages |
| `pages_read_engagement` | Page token for IG account |

For **other people's accounts** (production / SaaS), you must submit **App Review**
with a screencast per permission. For **your own account** in Development mode,
review is not required.

---

## Troubleshooting

### “API not configured” in the UI

Set `instagram.app_id` and `instagram.app_secret` (or `META_APP_ID` / `META_APP_SECRET`).

### “Connect Instagram first”

Click **Connect Instagram** and complete the Facebook OAuth flow.

### `instagram.public_base_url is not set`

Run ngrok (or set a deployed HTTPS URL) and update config.

### `Media download has failed`

- `public_base_url` must match your live tunnel exactly (https, no trailing slash issues).
- Image must be reachable without login.
- Restart ngrok → update URL if it changed.

### `No Instagram Professional account linked to your Facebook Pages`

Re-link Instagram to a Page in the Instagram app, then disconnect and reconnect in the UI.

### `(#10) Application does not have permission`

Re-authorize via **Connect Instagram**. Confirm app roles and Development mode.

### OAuth redirect mismatch

`oauth_redirect_uri` in `config.yaml` must **exactly** match the URI in the Meta app settings (including port).

---

## Security notes

- Never commit `app_secret` or `cache/instagram_session.json`.
- Use environment variables for secrets in production.
- Long-lived tokens expire (~60 days); reconnect when publish starts failing with auth errors.

---

## What’s next

- **List existing posts** — `GET /{ig-user-id}/media` (future UI)
- **Promote posts / ad campaigns** — Meta Marketing API (separate setup; see project docs)
