# Architecture and decisions

Decided on 2026-11-02. This document keeps the research and measurements behind the decisions.

## Foundation

Fork SilverBullet (MIT, 2.12.1) and replace its note storage with GitHub while keeping its UI and editor.

We did not build from scratch because recreating the editor—CodeMirror 6 live preview, wikilink completion, page navigation, backlinks, tags, and mobile support—would take too long. We forked instead of using only SilverBullet's UI because its UI and sync machinery are tightly coupled. Using the UI alone would force the Worker to imitate SilverBullet's internal contracts (`/.events`, SHA-256 ETags, modification times, `base_fs`), which would need maintenance on every upstream release.

### Fork rules

- Pin the upstream version to 2.12.1. Do not merge all upstream changes later; take only security fixes.
- Keep changes to new files and small edits. Record every upstream file we touch in `docs/fork-changes.md`.
- Do not delete unused features (Space Lua, the plug-in system, and so on). They are interconnected, and removing them can break unrelated behavior.
- CSS may be edited directly. Class names are safe to rely on because we do not take upstream UI changes.
- Keep the MIT copyright notice. Do not use the SilverBullet name or logo.

### Rejected options

| Option | Why not |
| --- | --- |
| Use an existing app as-is | None covers 7–8 of the 10 requirements. None has the home screen for supervising AI changes. The closest, Foam + github.dev, covers about 60%. |
| Use SilverBullet's UI without forking | SilverBullet syncs every few seconds. Connected to GitHub, one tab would make roughly 1,600 API requests per hour. |
| Build everything ourselves | The editor, especially live preview, is too much work. |
| ProseMirror-based editors (Milkdown, Tiptap) | Round-tripping through their document model rewrites Markdown and risks breaking thousands of notes with frontmatter. |
| Clone with isomorphic-git in the browser | Direct browser access is blocked by CORS and needs a relay. A full clone includes all history and is large. Offline git is not a requirement. |

## Data flow

```
Browser (SilverBullet fork)
  GitHubSpacePrimitives ──/api/gh──> Worker (sign-in and relay only) ──> GitHub API
  IndexedDB (all note bodies, tracked by blob SHA)
```

SilverBullet funnels file reads and writes through `SpacePrimitives` (`client/spaces/space_primitives.ts`, about 30 lines). We implemented `GitHubSpacePrimitives` in place of the server-backed `HttpSpacePrimitives`.

### Reading

| When | What happens | GitHub API usage |
| --- | --- | --- |
| App opens | Fetch the tree once (`git/trees/HEAD?recursive=1`). The file list appears immediately. | 1 request. A 304 does not count. |
| First launch on a device | Fetch missing note bodies in batches of 250 over GraphQL. Prioritize the open note. | About 14 points |
| Refresh | Fetch the tree again and download only bodies whose blob SHA changed. | 1 request + 1 point per 250 notes |
| Open a note | Use the body already stored in the browser. | 0 |
| Display an image or attachment | Fetch one file over REST. The URL includes the blob SHA and is cached as `private, immutable` in the browser. | 1 request per file, then 0 |

Measurement (2026-11-02, a vault of about 3,300 notes): one GraphQL query fetched 250 note bodies by blob SHA. It used 1 point, took 4.4 seconds, returned 1.3 MB, and truncated nothing.

- Stop SilverBullet's automatic sync (every 20 seconds for the whole space, every 2–3 seconds for the open file). Sync runs only when the app opens and when the refresh button is pressed. The trigger lives in `client/service_worker/sync_engine.ts`.
- SilverBullet compares modification times for equality (`client/spaces/sync.ts`). GitHub does not expose per-file modification times, so we derive a number from the blob SHA.
- If a file exceeds 512 KB and GraphQL truncates it (`isTruncated`), fetch it over REST.
- Indexing and tags depend on the standard `Library/Std` plug-ins. Bundle them with the client and serve them from the same read-only location as the UI.

All note bodies live in the browser because backlinks, the graph, tags, and full-text search need them. Obsidian similarly reads every file at startup to build its `metadataCache`. Bodies stay in the browser and never persist on the Cloudflare side.

### Writing

- Notes are read-only by default. The Edit button in the top bar opens an editor over the note. Save sends the result to `/api/gh/commit` (`client/components/vault_web_note_editor.tsx`, `client/vault_web_save.ts`), the same endpoint the CLI uses. The request includes the base version; if GitHub changed first, the Worker performs a three-way merge.
- The GitHub editor remains available from the editor's "Open on GitHub" action.
- The Skills page (`Vault: Skills`) writes `.claude/skills/<id>/SKILL.md` and a `.agents/skills/<id>` symlink through the same `/commit` endpoint, so a skill lives in the repository (project scope) and is read by agents working there. `isWritablePath` allows that one hidden path; a commit that contains a symlink goes through the Git Data API instead of GraphQL, which cannot set a file mode.
- GitHub's editor, github.dev, and vscode.dev all return `frame-ancestors 'none'`, so they cannot be embedded (verified 2026-11-03).
- After returning, reload the latest version. For 30 minutes after opening the editor, call `Sync: Space` whenever the tab becomes visible.
- New notes are created through the same `/api/gh/commit` endpoint with no base version, so an existing file is never overwritten. Uploading images is not implemented yet.

### Sign-in and relay (Worker)

- Cloudflare Workers + Static Assets. Not Pages. Routing uses Hono. GitHub token exchange and refresh are implemented with `fetch` in `worker/github.ts`; no extra library.
- The GitHub App is created through the manifest flow. Opening `/.auth/setup?token=<SETUP_TOKEN>` starts GitHub's creation screen; the returned App settings (including the client secret) are encrypted and stored in the `APP_KV` KV namespace.
- Flow: `/.auth` (sign-in) → GitHub → `/.auth/callback` → install the App if needed → choose a repository → `/v/`. Sign-in and installation are separate steps.
- Anyone can sign in. Each user opens one repository of their own, chosen from the repositories where they installed the App (`worker/repos.ts`, which lists `/user/installations` with the user's token). With one repository it opens directly; with several, `/.auth/repo` asks. The choice is stored in the encrypted session cookie, not on the server. Until it is chosen, `/.auth/repo` keeps it in a short-lived encrypted `vw_pending` cookie, which also carries a desktop or CLI login's return address. The account page links to `/.auth/repo` to switch. The desktop and CLI logins carry their own copy of the choice; to switch there, sign out and sign in again.
- The Service Worker reconfigures itself when `/.config` names a different repository, so switching does not keep syncing the previous one. Local data (IndexedDB) is named after the repository, so each repository keeps its own copy.
- `redirect_uri` is the origin of the incoming request, so every origin the app is served from needs its own entry in the App's callback URLs (`<origin>/.auth/callback`, up to 10). A new public origin needs the same edit, plus `setup_url` if installs should return there.
- A self-hosted instance can limit sign-in to listed accounts with `ALLOWED_LOGINS`. When it is empty or unset, anyone can sign in.
- The GitHub App must be public for other accounts to install it (GitHub App settings → Advanced → Make public). The manifest creates it private, which suits a self-hosted instance for one person.
- Tokens live in an AES-GCM-encrypted cookie (`HttpOnly`, `Secure`, `SameSite=Lax`). Page JavaScript never sees them. There is no application database.
- `/api/gh` relays GitHub API requests with the signed-in user's token and rejects requests outside the repository that user chose.
- The account page uses `/.auth/profile` (display name and profile URL, read from GitHub's `/user` by the Worker) and `/.auth/avatar` (the Worker fetches the GitHub avatar and serves it from the same origin, because the CSP blocks external images). `/user` itself is not exposed through `/api/gh`.
- Access tokens expire after 8 hours, and refresh tokens are single-use. When a token expires, `/api/gh` returns 401 `{error:"refresh"}`. The client and Service Worker run `POST /.auth/refresh` once under a Web Lock and retry once (`client/vault_web_fetch.ts`).
- Pin the REST `X-GitHub-Api-Version` header. `2022-11-28` remains valid until 2028-03-10; the current version is `2026-03-10`.

## Security

- SilverBullet executes `space-lua` blocks in notes and exposes network functions such as `net.proxyFetch`. Rootlore notes are written largely by AI, so prompt injection in a document the AI reads could plant malicious code in a note. Running with the signed-in user's permissions could then rewrite the repository or exfiltrate its contents.
- Lua can also run arbitrary JavaScript through `js.import` and `js.window`. This applies not only to `space-lua` blocks but also to `${...}` expressions in note bodies.
- Policy: vault content cannot change the UI or execute code.
  - Run Lua only from the bundled `Library/Std/` (`client/vault_web_trust.ts`). Do not load note `space-lua`, and show note `${...}` expressions as text. `GitHubSpacePrimitives` does not read a vault's own `Library/Std/`, so it cannot be impersonated.
  - `${...}` evaluation happens in exactly one place: `lua_directive.ts` when opening bundled pages. `expandMarkdown`, which handles embeds, tables, lists, and widgets, never evaluates it. We do not patch dangerous paths one by one; we disable evaluation from the start.
  - Do not load `space-style` or `.plug.js` from notes (`disableSpaceStyle` and `disablePlugs` in `/.config`). `space-style` is injected through `innerHTML`, so `</style>` could inject JavaScript.
  - CSP (written to `dist/_headers` by `scripts/build.mjs`) restricts network and asset loading to our own origin. GitHub traffic goes through the Worker at `/api/gh`. External images in notes are blocked because their URLs could carry data out.
  - CSP cannot stop navigation-based exfiltration (`location` changes). Reaching that point requires bypassing the Lua restrictions above.
- Keep visual preferences (theme, presets) outside the vault. They will be stored in the browser or as a user profile in D1, keyed to the GitHub account, and applied at startup. Themes may touch only CSS variables (`styles/theme.scss`, `colors.scss`).
- Keep URL escape hatches such as `?disableSpaceStyle=1` for broken layouts.

## Limits

GitHub quotas are per user (REST 5,000 requests/hour, GraphQL 5,000 points/hour). They are not shared between users, but they are shared with the same user's other apps and PATs.

Two quotas are shared across the whole app:

- GitHub token issuance (sign-in and refresh): 2,000 per hour app-wide.
- Cloudflare Workers requests: the free plan allows 100,000 per day.

## Obsidian syntax

Verified with SilverBullet 2.12.1.

| Syntax | SilverBullet | Plan |
| --- | --- | --- |
| `[[wikilink]]` (with folders, `\|`, `#heading`) | Supported. Same-name files appear as candidates and the shortest path wins (ADR 011). | Use as-is |
| frontmatter (tags, aliases) | Supported. Rendered as YAML. | Add a property view later |
| `#tag`, `==highlight==`, `![[embed]]` | Supported | Use as-is |
| callout `> [!note]` | note, warning, danger, and success are colored. Collapsible callouts (`-`, `+`) are not supported. | Add types and collapsing |
| `%%comment%%` | Not supported (rendered literally) | Add |
| Block reference `#^id` | Not supported | Later |

Keep conformance tests built from synthetic notes so changes in Obsidian's specification are visible. Never include real notes in tests, because the source is public.

## What we build ourselves

- `GitHubSpacePrimitives` (reads and batched fetches)
- In-app editing and saving (the Edit button)
- Sync triggers (open and refresh)
- The Worker (sign-in and relay)
- The home screen (numbers, change events, changes that need review)
- The graph (not part of SilverBullet; layout in a Web Worker, rendering with WebGL; sigma.js + graphology or d3-force + PixiJS)
- Missing Obsidian syntax
- Visual design

## AI vs. human changes

Keep a list of commit authors that should be treated as AI in the vault. Compare commits against it. Group consecutive commits by the same author within 30 minutes into one change event.

## Unverified

- Whether GitHub raw downloads support Range requests for partial PDF and video reads.
- How fast a 3,000-node graph is on a real phone.
- Whether SilverBullet's full-text search works entirely in the browser without a server. If not, add MiniSearch with `Intl.Segmenter('ja')`.
