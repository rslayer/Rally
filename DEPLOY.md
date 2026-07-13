# Deploying Rally

Rally's deployable surface is the **control-tower dashboard** (`apps/web`) — a
stateless Node HTTP server with no build step, no database, and no writable
filesystem. It renders server-side (running the simulation) and caches the
result per seed, warming the default view at startup so requests are instant.

- **Start command:** `npm start` (→ `tsx apps/web/src/server.ts`)
- **Port:** reads `$PORT`, defaults to `8137`, binds `0.0.0.0`
- **Health check:** `GET /healthz` → `200 ok`
- **State:** none (in-memory only) — safe on ephemeral / read-only hosts

Pick whichever host you have an account on. All four read configs already in the repo.

## Render (one-click blueprint) — recommended

1. Push is already done (`rslayer/Rally` is public).
2. In the [Render dashboard](https://dashboard.render.com): **New → Blueprint**,
   connect the `rslayer/Rally` repo. Render reads [`render.yaml`](render.yaml).
3. Click **Apply**. First boot runs `npm install` then `npm start`.

Free plan sleeps after inactivity (first hit cold-starts ~10–20 s).

## Fly.io (CLI)

```bash
brew install flyctl        # if needed
fly auth login             # interactive — you do this
fly launch --copy-config --name <your-unique-name>   # uses fly.toml + Dockerfile
fly deploy
```

`fly.toml` already sets `internal_port = 8137`, the `/healthz` check, and a
512 MB shared VM that scales to zero.

## Railway

- **New Project → Deploy from GitHub → `rslayer/Rally`.**
- Railway detects the [`Procfile`](Procfile) (`web: npm start`) and injects `$PORT`.
- No build command needed.

## Docker (any container host — Cloud Run, ECS, a VPS)

```bash
docker build -t rally .
docker run -p 8137:8137 rally
# → http://localhost:8137
```

The [`Dockerfile`](Dockerfile) installs runtime deps only (`npm ci --omit=dev`)
on `node:22-slim`. Set `PORT` via `-e PORT=8080` if your platform requires it.

---

### Notes

- **Performance:** the first render of a seed is a few seconds of CPU (it runs
  the scorecard + control-tower sims); every subsequent hit is cached. The
  default view (`/`) is pre-warmed at boot.
- **`tsx` is a runtime dependency** (the app runs TypeScript directly), so
  `npm install` / `npm ci --omit=dev` is all the "build" there is.
- **Custom seed:** `/?seed=4006` renders a different scenario; results are
  deterministic and reproducible.
