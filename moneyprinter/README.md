# MoneyPrinterTurbo video microservice

auto-post-gen generates videos with [MoneyPrinterTurbo](https://github.com/harry0703/MoneyPrinterTurbo)
(MIT, Python/FastAPI + ffmpeg). Supabase Edge Functions **cannot** run Python
or ffmpeg, so MoneyPrinterTurbo runs as a **separate container** and our
`generate-video` / `video-status` Edge Functions talk to its REST API.

We use it as a **pure generation engine** — its built-in "Upload-Post"
publishing module stays **disabled**. All publishing is done by auto-post-gen
(`publish-post`, see Mission 3).

```
Frontend (Videos page)
      │  invoke generate-video
      ▼
generate-video (Edge Fn) ── POST /api/v1/videos ──▶ MoneyPrinterTurbo (this container)
      │  creates video_jobs row (pending → processing)                    │ renders
      ▼                                                                    ▼
video-status (Edge Fn)  ── GET /api/v1/tasks/{id} ──▶  (poll) ── GET /api/v1/download/... 
      │  on done: download file → upload to Supabase Storage → status=done
      ▼
video_jobs.video_url  ──▶ frontend preview + (Mission 3) publish
```

## What you must provide

| Item | Where | Notes |
| --- | --- | --- |
| Pexels API key | `config.toml` → `pexels_api_keys` | Free at https://www.pexels.com/api/ |
| LLM key | `config.toml` → `openai_api_key` | Reuse your OpenRouter key (base `https://openrouter.ai/api/v1`) |
| `MONEYPRINTER_API_URL` | Supabase secret | Public URL of this deployed service (e.g. `https://xxx.up.railway.app`) |
| `MONEYPRINTER_API_KEY` | Supabase secret *(optional)* | Only if you put the service behind an auth proxy |

## 1. Configure

```bash
cp moneyprinter/config.example.toml config.toml   # then edit the TODOs
```

Place `config.toml` where MoneyPrinterTurbo expects it (repo root of the
MoneyPrinterTurbo checkout). This repo only stores the **example**; never
commit real keys.

## 2. Deploy the container

MoneyPrinterTurbo ships its own `Dockerfile` — use it as-is. Two easy hosts:

### Option A — Railway (recommended to start)

1. Create a new project → *Deploy from GitHub repo* → fork/point to
   `harry0703/MoneyPrinterTurbo`.
2. Railway detects the `Dockerfile`. In **Settings → Networking**, enable a
   public domain. MoneyPrinterTurbo's API listens on port `8080` (set
   `listen_port` to Railway's `$PORT` or expose `8080`).
3. Add your `config.toml` (commit it to your private fork, or mount it as a
   Railway "Config File" / volume at the repo root).
4. Add a **volume** mounted at the app's storage/output dir so rendered files
   survive between the render request and the download poll.
5. Deploy. Copy the public URL → set it as the Supabase secret
   `MONEYPRINTER_API_URL`.

### Option B — Fly.io

```bash
fly launch --dockerfile Dockerfile --no-deploy   # generates fly.toml
fly volumes create mpt_data --size 3             # persist rendered files
# in fly.toml: [[mounts]] source="mpt_data" destination="/app/storage"
#              [http_service] internal_port = 8080
fly secrets set PEXELS_API_KEY=...               # if you prefer env over config.toml
fly deploy
```

Copy the `https://<app>.fly.dev` URL → Supabase secret `MONEYPRINTER_API_URL`.

> Scale-to-zero (Fly `auto_stop_machines`) is fine — the first request just
> cold-starts. Give the machine ≥ 2 GB RAM; ffmpeg montage is memory-hungry.

## 3. Wire it to Supabase

In the Supabase dashboard → **Edge Functions → Secrets**:

```
MONEYPRINTER_API_URL = https://<your-service-url>
# MONEYPRINTER_API_KEY = <optional shared secret if behind a proxy>
```

Deploy the Edge Functions and apply the migration (see `../DEPLOYMENT.md`).

## 4. Smoke test

```bash
# The service is up and the API answers:
curl -s "$MONEYPRINTER_API_URL/api/v1/musics" | head

# End-to-end from Supabase is exercised by the Videos page in the app, or:
curl -s -X POST "$MONEYPRINTER_API_URL/api/v1/videos" \
  -H 'Content-Type: application/json' \
  -d '{"video_subject":"3 astuces marketing","video_aspect":"9:16"}'
# → { "data": { "task_id": "..." } }   then GET /api/v1/tasks/{task_id}
```
