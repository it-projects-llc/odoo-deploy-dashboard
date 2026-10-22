# Odoo deployment dashboard

A database-free React dashboard for Forgejo and Komodo, with branch navigation, commit history, and build layouts inspired by Odoo.sh. It runs as one Node service: static frontend, read API adapters, and an optional terminal WebSocket relay.

## Run locally

Requires Node 22.12+ (Node 24 is used in the container).

```sh
cd /path/to/odoo-deploy-dashboard
npm ci
cp .env.example .env
npm run dev
```

Open http://127.0.0.1:4173. The default **test environment** (`work_env=test`) uses illustrative fixtures, never contacts providers, and never opens a terminal. No provider credentials are required in test.

For a production build:

```sh
npm run build
npm start
```

The Vite UI is bundled separately from the Node server. Shell/xterm is loaded on demand. Source is TypeScript throughout; no framework-specific hosting service is required.

## What is implemented

- Odoo.sh-style grouped branch navigation, dated event timeline, and horizontal build board.
- Separate source checks, workflow runs, deployment attempts, last deployed infrastructure revision, and observed service images.
- Forgejo commit/status and Actions readers, branch discovery, and paginated older commit history.
- Komodo stack/services and deployment history, with available detail metadata.
- Runtime, deployment-stage, and CI-job logs: local search, stage selection, pause/follow, copy, and bounded downloads.
- Runtime service summary, safe configuration display, provider availability, and local light/dark preferences.
- xterm.js Shell, backed by Komodo's terminal WebSocket through a scoped relay. Supports resize, UTF-8 input, disconnect/reconnect while the component is mounted, and ending the current owned session.
- Read-only container packaging, a localhost Compose example, and focused security/provider/protocol tests.

A passing application commit is not proof that it is currently deployed. Exact application revision → image digest → infrastructure revision correlation is not implemented; the dashboard displays source checks and deployment records separately.

## Work environment

Use the lowercase `work_env` variable in `.env` or the process environment:

```dotenv
work_env=test
```

- `test` (default): loads only bundled, generic sample data. Provider credentials and project mappings are ignored, no upstream API calls are made, and Shell cannot be enabled.
- `prod`: uses the configured Forgejo/Komodo APIs and requires a Forgejo read token and Komodo account authentication. Stack mappings are optional. There is no fallback to sample data if validation fails.

The value must be exactly `test` or `prod`; other values fail startup. `DASHBOARD_DEMO` is no longer supported: remove it and set `work_env` instead. `NODE_ENV` independently controls the Node/Vite runtime, so `npm start` can serve either work environment. Restart the server after changing `.env`.

## Live mode and Komodo login

1. Set `work_env=prod` and `DASHBOARD_AUTH_MODE=komodo` (the default authentication mode).
2. Configure `FORGEJO_URL` (without `/api/v1`), a repository read token in `FORGEJO_TOKEN`, and `KOMODO_URL`.
3. Leave `DASHBOARD_AUTO_DISCOVER=true` (default) and remove `DASHBOARD_PROJECTS_JSON` or set it to `[]`. All stacks visible to the Komodo account are discovered automatically.
4. Generate a secret with `openssl rand -hex 32` and put it in `DASHBOARD_SESSION_SECRET` (minimum 32 characters). Set `DASHBOARD_ORIGIN` to the public HTTPS origin.
5. Serve behind your HTTPS reverse proxy, forwarding `/api/terminal` WebSocket upgrades. Restart the dashboard.

Any **enabled Komodo account** can sign in with its existing username and password. There is no dashboard allowlist, signup endpoint, user database, or Authentik requirement. Local-password login and TOTP are supported. External-only and passkey login are not implemented; unsupported challenges fail closed. The dashboard never stores passwords or returns Komodo tokens to browser JavaScript.

Login creates an AES-256-GCM encrypted HttpOnly, SameSite=Strict cookie, marked Secure on HTTPS. Sessions last at most eight hours or until the Komodo JWT expires, whichever happens first. Temporary session IDs in server memory provide logout revocation; restarting the dashboard signs everyone out. Multiple replicas need sticky routing; independent instances do not share active sessions. Rotate the session secret to invalidate cookies. Each authenticated request rechecks the account with Komodo's `/user`; disabled accounts and invalid tokens are rejected. Login and logout require the configured browser Origin. Failed upstream logins use generic errors; attempts are limited to ten per minute per client IP. If behind a reverse proxy, set `DASHBOARD_TRUST_PROXY_HOPS=1` only when exactly one trusted proxy is the sole ingress to the private listener; otherwise leave it at zero. Do not trust forwarded headers from public clients.

Komodo reads and terminals use the **calling user's JWT**, including upstream Read, Logs, and Terminal checks. Shared Komodo API keys and `DASHBOARD_TERMINAL_USERS` are unused in this mode. Provider caches are isolated by login token, limited to 16 viewer caches (4 MB each); overflowing the cache causes a fresh read.

### Automatic stack discovery

The dashboard calls Komodo's permission-filtered `ListStacks` as the current user (or the shared API-key identity in proxy mode), paging through the complete result. Untagged stacks become individual unclassified projects. Odoo-tagged stacks sharing an application project and repository are grouped into one project. New stacks appear on the next refresh; removed permissions remove the corresponding entries. Server-generated IDs derive from the immutable Komodo stack ID. Direct history/log/terminal requests refresh membership and recheck stack access; an arbitrary stack ID from the browser is never accepted. Test mode makes no discovery requests.

No per-stack JSON or labels are required. Status, services, deployment history, retained logs and terminal access continue to use Komodo. The matching Forgejo repository and branch are taken from Komodo's stack summary only when the configured git provider matches `FORGEJO_URL`. A repository on another provider or an unidentified repository does not prevent the stack from appearing. That stack simply has no inline Forgejo commit/CI history. No raw config, environment variables or compose contents are returned in discovery DTOs. Public HTTP(S) links from the stack's configured quick links can be used as its URL.

### Odoo tags and application branches

Declare native Komodo resource tags on each Odoo stack (in the Resource Sync TOML `tags` array, outside `[stack.config]`):

```toml
tags = [
  "odoo.project=sample",
  "odoo.repository=example/odoo-addons",
  "odoo.branch=19.0-staging",
  "odoo.stage=staging",
  "odoo.version=19.0",
  "odoo.service=odoo",
]
```

These tag names are dashboard conventions. Komodo returns tag IDs, so the dashboard resolves them using the calling account's `ListTags` API. `odoo.project` and `odoo.repository` identify the application project; the repository is on the configured Forgejo provider. Project IDs include both values, preventing two different repositories sharing a project tag from being combined. Environment IDs use the immutable stack ID. Each deployment keeps its own infrastructure repository and branch separately.

- `odoo.branch` selects the **application** branch, not the stack's infrastructure branch. A missing application branch remains Unknown and does not fall back to the infrastructure branch.
- For an identified application project, exactly `odoo.stage=production` means Production, and `odoo.stage=staging` means Staging. Any other stage or an omitted stage means Development.
- All application repository branches are fetched from Forgejo with pagination. Branches without a visible mapped stack appear under Development with **Not deployed**, commits and CI history, and no terminal. The manual branch discovery limit does not apply to these projects.
- `odoo.version` and `odoo.service` identify the Odoo version and Compose service. For Development branches, an omitted version is inferred from an OCA branch prefix such as `19.0-feature` → `19.0`; explicit version tags take precedence. Branches without a valid version prefix remain Unknown. An omitted service uses unambiguous service discovery.
- The branch sidebar and build board contain Production, Staging, and Development sections only. Missing project/repository tags leave a resource unclassified in backend diagnostics; it is not assigned a development role. Application commit history is unavailable until the application repository is identified. Conflicting values, invalid tag metadata, or unresolved tag IDs cannot silently classify a resource as Development; the resource remains unclassified with diagnostics.

Only accessible stacks contribute metadata. Direct log/history/terminal requests refresh stack membership and recheck access. Access to any readable tagged stack grants access to its application's Forgejo branch/CI history through the configured server token; this does not synchronize independent Forgejo user permissions. An inaccessible deployment's metadata, services and logs are never returned; its application branch may still appear as CI-only if the application repository is visible through another readable stack.

Production attribution remains branch-based rather than proof of the exact deployed application commit. The infrastructure deployed hash is still labeled infrastructure; exact source-to-image correlation requires image/CI provenance.

`DASHBOARD_PROJECTS_JSON` remains an optional override for grouping multiple stacks into one project, identifying application/infrastructure repositories separately, and setting stage, Odoo version, URL, image file or terminal service. Explicit mappings take precedence when their stack name or ID matches a discovered stack. Unmapped visible stacks are still discovered. Set `DASHBOARD_AUTO_DISCOVER=false` to use only explicit mappings; this mode requires at least one project. Discovery requests are bounded to 100 pages of 100 stacks; exceeding that returns a visible error rather than silently truncating the inventory.

**Repository access policy:** a configured environment with a stack requires Read access to that stack. A CI-only branch requires Read access to at least one configured stack in its project. Projects with no readable configured stacks are hidden. Every protected history/log request rechecks this policy before making Forgejo requests. The Forgejo token remains a shared server credential: access to one mapped stack grants the project's CI-only branches and associated application/infrastructure repository data. This is a dashboard policy, not a sync of the user's independent Forgejo repository permissions. Use separate project mappings and narrowly scoped Forgejo tokens where audiences differ. A project needs at least one mapped stack for Komodo-backed authorization.

### Optional legacy proxy authentication

`DASHBOARD_AUTH_MODE=proxy` enables trusted-header authentication. Configure a random `DASHBOARD_PROXY_SECRET` (minimum 32 characters), `KOMODO_API_KEY` and `KOMODO_API_SECRET`. The identity proxy must remove incoming `X-Dashboard-User` / `X-Dashboard-Proxy-Secret`, authenticate the caller, and inject trusted values. Keep the listener private to that proxy. Proxy-mode viewers share configured projects; terminal users require `DASHBOARD_TERMINAL_USERS`; terminal connections and end-session requests use the same `KOMODO_API_KEY` / `KOMODO_API_SECRET` as deployment reads. Proxy mode does not offer dashboard username/password login.

## Optional Shell

Configure:

```dotenv
DASHBOARD_TERMINAL_ENABLED=true
DASHBOARD_TERMINAL_PRODUCTION=false
```

With automatic discovery, an unambiguous service is selected automatically. Tagged Staging and Development deployments require `DASHBOARD_TERMINAL_ENABLED=true`. Production and unclassified deployments also require `DASHBOARD_TERMINAL_PRODUCTION=true`. Komodo's Terminal permission remains mandatory. With explicit mappings, set `terminal: true` and `terminalService` (default `odoo`) on the permitted environments. Komodo must grant the logged-in user the appropriate stack Terminal permissions. No dashboard user allowlist is needed in Komodo login mode. Proxy mode uses the same `KOMODO_API_KEY` / `KOMODO_API_SECRET` for terminal and deployment reads; there are no separate terminal credentials. If Komodo denies permission, the Shell page explains that the current account needs stack Terminal permission. Other connection/service errors remain distinct. The dashboard does not elevate the account or fall back to other credentials. Verify initialization and `DeleteTerminal` permissions against the installed version before enabling end-session support in use. The dashboard does not need a host terminal or SSH credential.

Shell commands **can modify the target environment**, including its database. Other dashboard APIs remain read-only. The relay fixes the upstream URL, stack, service, shell command, and session ownership on the server. It authenticates Komodo server-side; client-supplied provider login/target frames are not forwarded. It validates browser Origin, login session, and stack access before upgrading. Logout or expiry closes the relay within five seconds; enabled-account checks repeat every 30 seconds. Production Shell requires both its mapping and `DASHBOARD_TERMINAL_PRODUCTION=true`.

Transport:

```text
Browser xterm.js → dashboard WebSocket relay → Komodo Core → Periphery → container PTY
```

The implemented protocol follows Komodo's official terminal client: `/ws/terminal` with literal bracket query keys (`target[type]`, `target[params][stack]`, etc.) and lowercase `init[mode]=exec`, `Jwt` login (`ApiKeys` in legacy proxy mode), `LOGGED_IN` handshake, binary input ending in `0x01`, and JSON resize bytes ending in `0xff`. The terminal protocol is version-dependent; verify compatibility with the installed Komodo version using a disposable target before enabling production Shell.

**Disconnect** closes the browser connection; Komodo can keep the session/process running. **End session** asks Komodo to delete only the current server-owned terminal. If ending fails, use the Open in Komodo link to its native terminal management. A dashboard restart, leaving the Shell tab, or a lost local session reference does not terminate upstream terminals; manage orphan sessions through Komodo. The dashboard does not list or attach to arbitrary existing sessions. It stores no transcripts or shell command history; Komodo and the shell retain their own behavior.

## Storage contract

| State | Storage |
| --- | --- |
| Provider addresses, Forgejo/proxy credentials, session encryption secret, projects and terminal policy | Server `.env` / injected environment |
| Komodo JWT and temporary MFA challenge | Encrypted HttpOnly browser cookies |
| Active dashboard session IDs (no credentials) | Bounded server memory |
| Theme, last branch/project and collapsed groups | Namespaced browser `localStorage` |
| Selected view/branch | Non-sensitive URL parameters |
| Log search/output and active terminal reference | Browser memory |
| Provider snapshots, deduplication and relay/session ownership | Bounded server memory |
| History, retained logs and terminal PTYs | Existing Forgejo/Komodo services |

There is no SQLite, Redis, external cache, persistent session store, server data volume, or dashboard migration step. Browser localStorage holds preferences only; authentication uses HttpOnly cookies. Provider configuration and credentials are excluded from browser bundles and API DTOs. `.env` is ignored by Git and Docker build context; `.env.example` is public.

## Bounds and current limits

- Provider requests: 15-second timeout, eight concurrent requests, bounded queue, at most 8 MB per response, at most 300 cached reads within a 32 MB payload budget in proxy mode, or 16 viewer caches of 50 reads/4 MB each in Komodo mode. A last good response may remain visible during transient failure, marked stale; 401/403 responses evict it.
- Stack access checks fail closed per environment: a failed check never grants Forgejo access, and one failing stack does not block other readable deployments. Provider diagnostics distinguish HTTP errors, connection failures and invalid API responses without returning raw upstream error bodies.
- In automatic mode, stack discovery reads all accessible stacks. In explicit projects, configured branches are always included. Discovery checks the first 30 Forgejo branch entries and adds up to `DASHBOARD_DISCOVERY_LIMIT` (default 8) CI-only branches; a notice appears when limited. Explicitly configure branches you need beyond that window.
- Initial history uses 10 commits per branch, with older commits loaded on demand up to page 100. Deployment records use the first Komodo history page; older pages are available through the read API but have no pagination control in the UI. Workflow summaries show the first 20 branch runs. PR-specific refs may require additional mapping; commit check contexts remain separate.
- Runtime output is a 500-line tail. Deployment/CI output is bounded and best-effort redacted; browser display is text, not provider HTML. CI includes up to 12 jobs per selected run, pinned to the reported job attempt.
- Logs are fetched every five seconds only while their view is open/unpaused; hidden tabs pause polling. Provider snapshots default to 15 seconds, with a 10-second provider cache isolated by login token in Komodo mode. Rate limiting is 120 API requests/minute per authenticated identity.
- Terminal connections are limited (default 4), with an input inactivity timeout (default 15 minutes). The dashboard keeps at most 200 temporary ownership records for an hour. These limits disconnect transport; they do not guarantee upstream PTY cleanup.
- `Running` is container state, not proof that Odoo is responding correctly. One-shot service exits do not make the application unhealthy. Detailed resource/HTTP metrics, uptime percentages, mail capture, backup inventory, editor and upgrade controls require capabilities not connected here.
- Forgejo/Komodo API compatibility, reverse-proxy routing, and terminal behavior depend on the installed provider versions and deployment configuration. Upstream log URLs are available where reported; redirects from log APIs are not followed with credentials.

## Container preview and Traefik

```sh
docker compose -f compose.yaml --env-file .env up --build -d
```

The included Compose file publishes only on `127.0.0.1:4173`; it does not register any resource in Komodo or modify existing Odoo stacks. The image runs as a non-root user with a read-only root filesystem and no data volumes.

For a live deployment, attach the service to the appropriate proxy network, route Traefik to port 4173, terminate HTTPS at the reverse proxy, and forward WebSocket upgrades on `/api/terminal`. Set proxy timeouts for long-lived connections. Set the public HTTPS `DASHBOARD_ORIGIN` and a random session secret. Authentik is optional; trusted identity headers are required only in legacy proxy mode. Review the resulting deployment manifests before rollout.

## Validation

[GitHub Actions CI](.github/workflows/ci.yml) runs on every push to any branch, every pull request, and manual dispatch. On Node.js 22 and 24 it installs dependencies with `npm ci`, checks formatting, runs the test suite, and builds the frontend and server. CI uses `work_env=test` and requires no provider credentials or repository secrets.

```sh
npm test
npm run build
npm run format:check
```

Tests use fixtures and local mock services, including real mock WebSocket handshakes. Authentication coverage includes password/TOTP, cookie tampering, CSRF Origin checks, disabled accounts, expired tokens, logout revocation, per-login cache isolation, repository access checks, and caller JWT terminal connections. They do not connect to private deployments. The test environment provides generic commits, deployment records, logs, and mixed provider-health states for UI review.

References: [Komodo authentication client](https://github.com/moghtech/lib), [Komodo TypeScript API client](https://github.com/moghtech/komodo/blob/main/client/core/ts/src/lib.ts), [Komodo terminal client](https://github.com/moghtech/komodo/blob/main/client/core/ts/src/terminal.ts), [Komodo terminal UI framing](https://github.com/moghtech/komodo/blob/main/ui/src/components/terminal/xterm.tsx), [Forgejo API usage](https://forgejo.org/docs/latest/user/api/usage/).

## Dashboard refresh and history display

Refreshing a dashboard URL keeps the selected view, project, branch and tab while a layout placeholder is shown during authentication and data retrieval. No deployment snapshots, logs, or authentication decisions are persisted in browser storage. Authentication and current resource permissions are checked before provider data is displayed.

Branch history shows only commits and checks from the application (module-code) repository. Komodo deployment events and infrastructure commits are excluded from this timeline; deployment records remain available in Builds and Logs. Resources without an identified application repository show an empty history rather than substituting infrastructure commits.

The footer reports Forgejo and Komodo integration status from the latest snapshot, including partial failures. Failed refreshes mark those results unknown; browser offline status is shown separately. Client WebSocket status tracks the active terminal connection and stays Idle when no terminal is open. It does not open a shell just to check connectivity.

Status shows provider connections and current Odoo environments. Provider cards include safe diagnostics (HTTP status, permission, connectivity or response-format failures) without upstream response bodies or credentials. Failed reads served from cache retain their diagnostics until a successful refresh. Historical uptime, detailed telemetry and source-to-image correlation placeholders are not displayed; those capabilities are not integrated.

Test data includes a healthy Forgejo integration alongside a degraded Komodo integration with a sample HTTP 500 diagnostic, so both provider-card states can be reviewed together. These are local fixtures; test mode makes no upstream requests.

## Local configuration and credentials

Keep deployment-specific URLs, project mappings, and credentials in `.env` or injected environment variables. `.env.example` contains generic placeholders and empty credential fields; test credentials in `test/` are synthetic fixtures. `.gitignore` and `.dockerignore` exclude local environment files, dependencies, and generated builds. Commit only `.env.example` when documenting environment settings.
