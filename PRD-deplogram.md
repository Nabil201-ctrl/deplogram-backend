# Deplogram — Product Requirements Document (PRD)

**Status:** MVP in development  
**Operator:** REKTINA  
**Sources:** `deplogram-backend` (NestJS API), `deplogram-web` (Next.js marketing site + "Your Galley" dashboard), `docs/BACKEND_ARCHITECTURE_AND_API_CONTRACT.txt`, `docs/product-blueprint.md`  
**Document date:** 2026-11-21

---

## 1. Product definition

**Deplogram** is a lightweight developer cloud focused on **deployment** as the core product. It is not positioned as a giant cloud provider or general-purpose website host.

The flow is: **source → runtime → configure → deploy → live**.

### MVP surface
| Area | Scope |
|------|-------|
| Deployment | Core product — connect a repo, pick a runtime, configure build/start/port/env, deploy, go live |
| Runtimes (8) | Vite, Next.js, Node.js, Python, PHP, Go, Static Sites, Docker |
| Galley | The workspace ("Your Galley"): Projects, Deployments, CodePad, Storage, Utilities, APIs, Settings |
| CodePad | In-browser editor (Monaco foundation): Run, Save, Deploy, Preview |
| Storage | Simple file/object storage: usage, folders, upload, new folder, search, sort, delete |
| Utilities | JSON formatter/validate/minify, JWT decode/expiry/validate, base64 encode/decode, regex test/validate, cron parse/readable, webhook test/received/clear, image transform/compress/convert, QR generate, OTP send/verify, email send |
| APIs | QR code (and utility endpoints exposed as HTTP APIs) |

**Removed from MVP (rescoped Oct 2026):** custom domains, pricing page, changelog, status page, docs, careers (all redirected to /roadmap or /about).

---

## 2. Current services & what is online

### 2.1 Service inventory

| Service | Repo | Stack | Hosting | Entry | Status |
|---------|------|-------|---------|-------|--------|
| Deplogram Backend API | `/root/deplogram-backend` | NestJS 12 + Express 5, TypeScript 6 (ESM) | Vercel serverless (`@vercel/node`, single `api/index.ts` function) | `https://deplogram-backend.vercel.app` | Reachable (500 on `/api/docs-json` — degraded or no env vars set) |
| Deplogram Web (marketing + dashboard) | `/root/deplogram-web` | Next.js (Turbopack), Bun | Render (`https://deplogram.onrender.com`) | `https://deplogram.onrender.com` | **Online (200)** |
| Local dev — backend | — | `npm run start:dev` | localhost:3000 | `http://localhost:3000` | Not running |
| Local dev — web | — | `bun dev` | localhost:3000 | `http://localhost:3000` | Not running |

### 2.2 What is online right now (2026-11-21)

- **Web frontend:** `https://deplogram.onrender.com` — online (HTTP 200). Marketing site + waitlist + roadmap.
- **Backend API:** `https://deplogram-backend.vercel.app` — reachable but returns 500 on `/api/docs-json`; no Vercel environment variables are configured (CORS reflects any origin, email defaults to `smtp.example.com` and would fail).
- **PM2-managed process on this host:** only `parley-voice` is online (uptime 28D). Neither `deplogram-backend` nor `deplogram-web` is running locally.
- **Integration status:** The frontend defaults to `NEXT_PUBLIC_API_MOCKING=enabled` (MSW mocks, 30 routes intercepted in-browser). No deployed frontend project points at the real backend yet. Frontend↔backend integration is **not yet done**.

### 2.3 Environment configuration

Backend (`.env`): `PORT=4000`, `NODE_ENV=production`, `JWT_SECRET` (dev secret), `CORS_ORIGIN=https://deplogram.onrender.com,https://n8n.devlaws.xyz,http://localhost:3000`, `SIGN_IN_ENABLED=true`, `VERCEL_URL=n8n.devlaws.xyz`.

Web (`.env.local`): `NEXT_PUBLIC_SITE_URL=http://localhost:3000`, `NEXT_PUBLIC_API_URL=http://localhost:3001`, `NEXT_PUBLIC_API_MOCKING=partial`. Production: `NEXT_PUBLIC_API_URL=https://deplogram-backend.vercel.app`, `NEXT_PUBLIC_API_MOCKING=partial`.

---

## 3. Backend API inventory

All `/v1/*` routes are public except `/v1/me*` (session cookie `deplogram_session`). Auth cookie: HttpOnly, Path=/, Max-Age=30d, Secure+SameSite=None in production.

### Auth
| Method | Path | Status | Notes |
|--------|------|--------|-------|
| POST | `/v1/auth/sign-up` | IMPLEMENTED | Creates account + session. Demo user: `owner@deplogram.app` / `password`. Passwords stored plain text. |
| POST | `/v1/auth/sign-in` | IMPLEMENTED | 403 when `SIGN_IN_ENABLED=false`. |
| POST | `/v1/auth/sign-out` | IMPLEMENTED | 204, clears cookie. |
| GET | `/v1/me` | IMPLEMENTED | Session required; 401 when signed out. |
| GET/PATCH/DELETE | `/v1/me/settings`, `/v1/me` | PARTIAL | No validation; DELETE only clears session. |

### Workspace / Usage / Traffic
| Method | Path | Status | Notes |
|--------|------|--------|-------|
| GET | `/v1/workspace` | SIMULATED | Always `ws_personal` / "Personal Galley" / free plan. |
| GET | `/v1/usage` | SIMULATED | Hard-coded plan limits; placeholder maths (bandwidth counts requests as bytes; storage = env var count MB). |
| GET | `/v1/traffic` | BUG | Always `{"requests":[],"liveProjects":2}` — `appendRequest()` has no callers; access log empty. |

### Projects
| Method | Path | Status | Notes |
|--------|------|--------|-------|
| GET | `/v1/projects` | IMPLEMENTED | Project summaries with latest deployment state. |
| POST | `/v1/projects` | PARTIAL/BUG | Creates project + QUEUED deployment but **never starts the build**. No name-uniqueness check. |
| GET/PATCH/DELETE | `/v1/projects/:id` | PARTIAL | Unknown id returns 200 empty (should be 404); DELETE returns 204 even if missing. |
| GET/PUT | `/v1/projects/:id/env` | PARTIAL | Keys only (values never echoed); plain text storage; no validation. |
| GET | `/v1/projects/:id/logs` | PARTIAL | Seeded line only; nothing appends live lines. |
| GET | `/v1/projects/:id/metrics` | SIMULATED | All zeros (feeds off empty traffic log). |
| GET | `/v1/projects/name-availability` | PARTIAL | `suggestion` always null; case-sensitive. |

### Deployments
| Method | Path | Status | Notes |
|--------|------|--------|-------|
| GET | `/v1/deployments` | BUG | Filters (`status`, `project`, `branch`, `trigger`) broken; comma-separated values not split; `pageSize` unbounded. |
| GET | `/v1/deployments/:id` | PARTIAL | Unknown id → 500 (should be 404); `durationSeconds` null for successful RUNNING deployments. |
| GET | `/v1/deployments/:id/logs` | PARTIAL | Seeded lines only; `steps: []` once done (steps deleted on finish). |
| POST | `/v1/deployments/:id/redeploy` | BUG | Returns QUEUED; never goes live (`markLive` never called); setTimeout build frozen on serverless. |
| POST | `/v1/deployments/:id/rollback` | BUG | Semantics inverted vs frontend; promotes `id.previousLiveId`, creates no new deployment. |

### Git (simulated)
| Method | Path | Status | Notes |
|--------|------|--------|-------|
| GET | `/v1/git/connection` | SIMULATED | Constant `princeion` / GitHub; no OAuth, no tokens. |
| GET | `/v1/git/repositories` | SIMULATED | Two seeded repos (`acme/storefront`, `acme/api`). |
| GET | `/v1/git/repositories/:id/branches` | SIMULATED | — |
| GET | `/v1/git/repositories/:id/detect` | SIMULATED | Returns nextjs/node only; `branch` ignored. |

### Activity
| Method | Path | Status | Notes |
|--------|------|--------|-------|
| GET | `/v1/activity` | BUG | `type` and `project` params accepted but ignored; `cursor`/`limit` work. Capped at 500 events. |

### Legacy developer utility routes (`/auth/*`, `/email/*`, `/utils/*`) — all public, demo-grade
OTP send/verify, email send, JSON formatter/validate/minify, JWT decode/expiry/validate, base64 encode/decode, regex test/validate, cron parse/readable, webhook test/received/clear, image transform/compress/convert, QR generate.

### OpenAPI
- `/api/docs` — Swagger UI (CDN assets)
- `/api/docs-json` — OpenAPI 3.0.0 document (generated at boot)
- Snapshot committed at `openapi.json`; regenerate with `npm run generate:openapi`.

---

## 4. Frontend (deplogram-web) routes

### Marketing site (`/`)
`/`, `/about`, `/blog`, `/blog/[slug]`, `/codepad`, `/contact`, `/deploy`, `/legal/privacy`, `/legal/terms`, `/roadmap`, `/runtimes`, `/storage`, `/tools`, `/waitlist`

Retired (redirect to `/roadmap` or `/about`): `/changelog`, `/pricing`, `/status`, `/docs/:path*`, `/careers`.

### Dashboard ("Your Galley") (`/dashboard`)
`/dashboard`, `/dashboard/[...slug]`, `/dashboard/activity`, `/dashboard/apis`, `/dashboard/apis/[api]`, `/dashboard/apis/keys`, `/dashboard/codepad`, `/dashboard/codepad/[padId]`, `/dashboard/deployments`, `/dashboard/dev/forms`, `/dashboard/new`, `/dashboard/projects`, `/dashboard/projects/[projectId]`, `/dashboard/projects/[projectId]/deployments`, `/dashboard/projects/[projectId]/deployments/[deploymentId]`, `/dashboard/projects/[projectId]/environment`, `/dashboard/projects/[projectId]/logs`, `/dashboard/projects/[projectId]/metrics`, `/dashboard/projects/[projectId]/settings`, `/dashboard/settings`, `/dashboard/settings/delete`, `/dashboard/settings/git`, `/dashboard/settings/notifications`, `/dashboard/settings/security`, `/dashboard/storage/[[...path]]`, `/dashboard/usage`, `/dashboard/utilities` (+ base64, cron, json, jwt, regex, webhooks)

### Auth
`/signin`, `/signout`, `/signup`, `/verify-email` — `/login` and `/signup` exist on branch `origin/Jayy` (UI only; submit handlers are TODOs, no API calls yet).

### Tech stack
Next.js (App Router, Turbopack), Bun, React Server Components, Zod contracts + TanStack Query hooks under `src/features/**`, MSW mocks (`src/mocks/handlers.ts`, 30 routes), `src/lib/api-client.ts` (`fetch` with `credentials: "include"`).

---

## 5. Architecture & tech stack

### Backend
- **Framework:** NestJS 12 on Express 5, TypeScript 6 (ESM / nodenext)
- **Hosting:** Vercel serverless — ONE cached Express/Nest instance per lambda; `vercel.json` routes `/v1/*`, `/auth/*`, `/utils/*`, `/api/docs*`, catch-all → `api/index.ts`
- **Storage:** In-memory `DeplogramStore` (one `@Injectable` singleton of JS Maps/arrays), seeded on boot. **No database, ORM, or migrations.** All state/sessions lost on process/instance restart.
- **Auth:** Cookie session (`deplogram_session`), unsigned random tokens in-memory Map. Only `/v1/me*` enforces session; all other `/v1` mutations are public (no authorization, no roles, no CSRF).
- **Deployment engine:** SIMULATION — `setTimeout` chain of build steps (clone, install, build, deploy, runtime; ~900ms/step, ~4s total; 15% build / 10% deploy random failure). Does not survive serverless response. No Git, builder, registry, CDN, DNS, TLS.
- **Tests:** Vitest 4 + supertest; 33/33 contract tests pass; one stale e2e test fails.
- **Lint/format:** oxlint (type-aware), prettier.

### Frontend
- **Framework:** Next.js (App Router, Turbopack), Bun only
- **State:** TanStack Query hooks; MSW browser mocking (3 routes stubbed server-side)
- **Styling:** Tailwind (design-system tokens in `docs/deplogram-design-system.md`, `docs/design-system.md`)

### Brand/tone
Hero: "Cuisine a masterpiece with ease" | Deploy: "Serve and test your work seamlessly" | Galley: "Your Galley" | CodePad: "Your exquisite code utensil..." | Storage: "Finished your craft? Now refrigerate." | Utilities & APIs: "The right condiments for your code recipe." Food metaphors restricted to these headers only.

---

## 6. Data model (in-memory store)

Collections: `users`, `workspaces`, `projects`, `deployments`, `repositories`, `branches`, `activity` (+`activityOrder` capped 500), `requests` (capped 5000, unused), `sessions`, `preferences`, `buildLog`, `runtimeLog`.

Key entities: User, AccountPreferences, Workspace, GitRepository, GitBranch, Project, Deployment, BuildLogLine, RuntimeLogLine, BuildStep, TrafficPoint, ActivityEvent, UsageLimit.

Deployment states: `QUEUED → BUILDING → BUILT → DEPLOYING → RUNNING`, failures `BUILD_FAILED`/`DEPLOY_FAILED`, `CRASHED` declared but never produced. Simulator never emits `BUILDING`/`BUILT`/`DEPLOYING` (jumps QUEUED→RUNNING or failure).

Seed data: user `owner@deplogram.app`/`password` (Sam Rivera), workspace `ws_personal` free, repos `acme/storefront`/`acme/api`, projects `proj_storefront`/`proj_api`/`proj_docs`, deployments `dep_old_2`→`dep_old_1`→`dep_live` + `dep_api_live`. Access log empty.

Relationships: no foreign keys; deletion does not cascade to logs/traffic/activity.

---

## 7. Known bugs & gaps (from architecture doc, severity H/M/L)

**High:**
- B1 In-memory store + serverless: state/sessions per-instance; setTimeout builds frozen after response.
- B2 `POST /v1/projects` never starts the build (deployment stuck QUEUED).
- B3 Finished build never becomes live (`markLive` not called); previous live stays live.
- B4 Rollback semantics inverted vs frontend contract.
- B5 Traffic log never written → `/v1/traffic` empty, metrics all zero.

**Medium:** B6 deployment filters broken / comma values not split; B7 activity filters ignored; B8 `url` includes scheme (broken "https://https://..." links); B9 wrong error semantics (200 empty / 500 instead of 404); B10 `durationSeconds` null for success; B16 duplicate project names accepted.

**Low:** B13 stale e2e test; B14 domain suffix decision (deplogram.app vs dpl.app); B15 no DTOs (ValidationPipe does nothing); B17 wrong activity type on PATCH; B18 sign-up not gated by `SIGN_IN_ENABLED`, no rate limiting.

**Security gaps (pre-launch):** no authorization on mutations; plain-text passwords; unsigned in-memory sessions; no CSRF; no rate limiting/lockout; no request-body validation; plain-text env vars; SSRF via `/utils/webhook/test`; no security headers; Swagger UI from third-party CDN.

---

## 8. Open architecture decisions (NOT DECIDED)
- D1 Serverless vs long-lived service for builds; D2 database/ORM; D3 auth provider/password hashing; D4 authorization model (session vs API tokens, roles, multi-tenancy); D5 Git integration (GitHub App vs OAuth, webhooks); D6 build/runtime infra, registry, CDN, DNS/TLS, domain model; D7 realtime transport (SSE/WebSocket/polling); D8 secrets encryption/KMS; D9 metering/billing; D10 observability; D11 frontend hosting/CORS allow-list.

---

## 9. Suggested order of work (per architecture doc §8.7)

**Phase 1 (contract correctness):** B6, B7, B8, B9, B10, B11, B12, B13, B15, B16, B17; add `GET /v1/health`; update e2e test; commit `openapi.json` snapshot.
**Phase 2 (engine behaviour in-process):** B2, B3, B4, B5 (traffic generation), log lines, lifecycle states, durations — with tests mirroring frontend mock semantics.
**Phase 3 (architecture):** database + migrations, real auth/authorization, secrets encryption, queue/worker for builds, realtime, observability, rate limiting, CSRF.
**Phase 4 (frontend):** wire sign-up hook + MSW handler, set `NEXT_PUBLIC_API_URL`, disable mocking, deploy, run contract tests against production.

---

## 10. Immediate prerequisites before frontend↔backend integration

1. Persistence + background build execution (Postgres/Redis + worker/queue, or a long-lived service) — in-memory + serverless cannot run the product.
2. Authorization on all `/v1` mutations + per-user data isolation.
3. Fix deployment lifecycle (start builds, emit intermediate states, mark live on success, set duration, write log lines).
4. Fix rollback to match frontend contract.
5. Wire real traffic/access log so `/v1/traffic` and metrics work.
6. Fix filters, 404s, and `url` scheme mismatch.
7. Decide realtime channel; switch frontend off MSW mocks to the real API.

---

## 11. Fix: CORS/NetworkError on `n8n.devlaws.xyz`

**Symptom:** Browser console shows `NetworkError when attempting to fetch resource` + `Cross-Origin Request Blocked` for `https://n8n.devlaws.xyz/v1/auth/sign-up` and `/v1/me` (and other `/v1/*` endpoints).

**Root cause:** The production Render deployment of `deplogram-web` has `NEXT_PUBLIC_API_URL=https://n8n.devlaws.xyz` set in its env vars. That host returns 502 (the backend is not deployed there — it's at `https://deplogram-backend.vercel.app`). With `NEXT_PUBLIC_API_MOCKING=partial`, MSW passes live endpoints through to the network, so the fetch hits the dead host and fails. MSW's `respondWith` rejects, surfacing as a CORS/NetworkError.

**Fixes applied:**

| File | Change |
|------|--------|
| `deplogram-web/.env.local` | Fixed local dev port `3001` → `3000` to match the backend dev port. Added warning about `n8n.devlaws.xyz`. |
| `deplogram-web/.env.example` | Added warning: do NOT set `NEXT_PUBLIC_API_URL` to `https://n8n.devlaws.xyz`; use `https://deplogram-backend.vercel.app` or set `NEXT_PUBLIC_API_MOCKING=enabled`. |
| `deplogram-web/src/mocks/browser.ts` | Added `onUnhandledRequest` to MSW worker that logs a clear warning when a request is passed through to an unreachable network host. |

**Required action (Render dashboard):** Change `NEXT_PUBLIC_API_URL` from `https://n8n.devlaws.xyz` to `https://deplogram-backend.vercel.app`, or set `NEXT_PUBLIC_API_MOCKING=enabled` to fall back to MSW mocks until the backend is reachable.

**Required action (Vercel dashboard):** The `deplogram-backend` project on Vercel has no environment variables set, causing 500 errors on `/v1/*` endpoints. Set at minimum `CORS_ORIGIN`, `JWT_SECRET`, and `SIGN_IN_ENABLED`.
