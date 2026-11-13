# Changes to SilverBullet

`silverbullet/` is SilverBullet 2.12.1 (`git subtree`, upstream commit `4d5eac5`). Whenever we edit an upstream file, record it here so security-only upstream updates can find the conflict points.

The maintainers keep a more detailed line-by-line ledger outside the repository. This file is the public map of the fork.

## Replaced files

| File | What changed |
| --- | --- |
| `client/images/favicon.svg`, `favicon.ico`, `favicon-96x96.png`, `apple-touch-icon.png`, `logo.png`, `logo-dock.png`, `logo-dock-96x96.png` | Rootlore icons: an open book with a black left page and a gray-gradient right page (2026-11-05). `favicon.svg` is the source; the rest were generated from it. Tabs and the Dock use a light rounded tile so the black page remains visible in dark tab bars. Phone icons and `logo.png` stay square; the OS rounds the corners. Horizontal logo: `docs/brand/rootlore-logo-horizontal.png`. Stacked logo: `docs/brand/rootlore-logo-stacked.png`. |

## Added files

### GitHub storage

- `client/spaces/github_space_primitives.ts` and its test: a `SpacePrimitives` implementation backed by GitHub. File lists come from the tree, bodies from GraphQL in batches of 250, and images and other binaries from REST.

### Rootlore UI

- `client/components/vault_web_page_frame.tsx`: shared frame for Home, Settings, and Account pages. Width and padding match the normal note body (`--editor-width`, 20px side padding).
- `client/vault_web_accent.ts` and its test: accent color. One user-selected color produces light and dark text/link colors with at least 4.5:1 contrast and an appropriate button foreground. Stored in localStorage as `vw-accent-color`, never in the vault. `_vault_web_theme.scss` falls back to the default purple.
- `client/vault_web_last_sync.ts` and its test: last successful GitHub read for this browser (`vw-last-sync`), shown on the Account page.
- `client/components/vault_web_sidebar_rail.tsx`: the 44px rail shown when the sidebar is collapsed on desktop, plus a matching spacer for the top bar. It holds the open-sidebar button, the buttons moved out of the top bar, and Settings/Account at the bottom. Hidden on phones (600px and below).
- `client/components/vault_web_sidebar_actions.tsx` and its test: places the former top-bar actions in the sidebar and rail. Renames the search icon to a magnifier.
- `client/components/vault_web_dialogs.tsx` and its test: Settings (theme, font size, local data deletion, version) and Account (GitHub login, connected repository, sign-out) as normal pages under `Library/Std/Rootlore/`. The note body is hidden with CSS while the page view is shown. Adds the feedback link to GitHub Issues.
- `client/vault_web_i18n.ts` and its test: UI language (Japanese/English), persisted in `vw-language`. The language is resolved once at load; changing it reloads the page. Copy is written as `t(Japanese, English)`. The choice is also exposed through the `vw-lang` cookie, the `vwLanguage` clientStore value, and `js.window.vaultWebLanguage` for bundled Lua.

### Security

- `client/vault_web_trust.ts`: `isTrustedLuaSource`, which allows Lua only from the bundled `Library/Std/`. Excludes `Infrastructure/Page Templates` and `Slash Templates`, which evaluate vault notes. Also provides `luaDirectivePageName`.
- `client/vault_web_trust.test.ts`: verifies that `${...}` in notes is not executed.
- `client/vault_web_fetch.ts` and its test: calls `/api/gh`, refreshes an expired token through `/.auth/refresh` once, serializes refreshes across tabs and the Service Worker with Web Locks, and redirects to sign-in when the session is gone.
- `client/markdown_renderer/sanitize_html.ts` and its test: strips `<style>`, `<link>`, and `<meta>` from note HTML so a note cannot restyle the whole app.
- `client/service_worker/byte_range.ts` and its test: adds a `sandbox` CSP to `text/html` responses from `/.fs`, so vault HTML cannot run scripts on our origin.

### Home and knowledge map

- `client/vault_web_home.ts` and its test: fetches Home data from GitHub. Includes recent commits and changed notes; the contribution grid (`/stats/commit_activity`, 52 weeks, retried up to four times every two seconds while GitHub computes it); and growth snapshots. Growth reads up to ten pages of 100 commits, picks snapshots with `pickSnapshots`, and reads three `git/trees/{sha}?recursive=1` responses at a time. SHA-addressed trees are immutable and cached by the Worker as `immutable`. The UI reads through `getHomeState` / `subscribeHome`. Restores the hidden note body. `notifyIndexReady()` redraws the knowledge map.
- `client/components/vault_web_home_view.tsx`: Home screen (recent updates, activity grid, growth, knowledge map). Replaces the note body through `VaultWebPageView` when `contentManager.vaultWebHomeShown` matches. The grid and growth chart are SVG. Growth uses steps because volume changes at commits, with a vertical gradient from 0.69 to 0.06 opacity and a 2px line at the top of each folder. Folder colors come from `GROWTH_COLORS`. The knowledge map is built from the existing `page` and `relation` index and loads the bundled `force-graph` with `import()` when Home opens (client builds already use `splitting: true`). Zoom uses pinch and Ctrl+wheel only; normal scrolling moves the page. Clicking a point opens the note. "Open full screen" calls the existing `Graph: Global Page Map` command from the object-graph plug. Styling lives in `_vault_web_theme.scss`.
- `client/vault_web_activity.ts` and its test: contribution-grid positions, four intensity levels, and axis limits.
- `client/vault_web_growth.ts` and its test: growth calculation. Keeps one snapshot per day (the last commit), thins to 60 snapshots while preserving the first and last, and sums `.md` bytes and file counts by top-level folder (ignoring dot-folders). Full snapshots make deleted and renamed files count correctly. Colors the six largest current folders and groups the rest as Other. Does not derive line counts from commit diffs, which can be several MB and many pages for large commits.
- `client/vault_web_knowledge_map.ts` and its test: nodes and edges for the map. Excludes bundled pages, templates, meta pages, file links, and co-mentions. Resolves an Obsidian `[[name]]` only when exactly one note has that name. Edges are undirected and deduplicated.
- `client/vault_web_folder.ts` and its test: folder pages listing direct folders, notes, and other files. Clicking a folder in the tree previously opened a note with the folder's name and showed "Page not found" in a read-only space.
- `client/styles/_vault_web_theme.scss`: the default visual design, written from scratch to feel close to Obsidian's default (no other theme code). Purple accent `#7f6df2`; light theme white with a `#f6f6f6` sidebar; dark theme `#1e1e1e` with a `#262626` sidebar. Body text uses the Japanese sans-serif stack at 16px, line-height 1.8, width 720px. Sidebar text is 14px with 30px rows, rounded highlights, and no left rule on the current page. Top title is 15px. Variables overridden by the upstream dark theme are redefined in our dark theme.

### Editing

- `client/vault_web_save.ts` and its test: saves in-app edits. Computes the Git blob SHA of the body that was read and sends it as the base version to `/api/gh/commit` (the same endpoint as the CLI). On 409, fetches the current body and retries a three-way merge up to three times. On a same-region conflict, returns conflict markers plus GitHub's current body. Refuses to save while markers remain. Keeps the body and base version in localStorage as `vw-draft:<path>`.
- `client/vault_web_merge.ts` and its test: line-based three-way merge. Uses jsdiff for comparison and follows node-diff3's `diff3MergeRegions`; tests compare against node-diff3, which is a test-only dependency.
- `client/components/vault_web_note_editor.tsx`: in-place editor controls (Save, Done, Discard, Open on GitHub). The normal note view stays read-only. ⌘S/Ctrl+S saves; Esc closes (keeping a draft if dirty). While editing, keys do not reach global shortcuts. After saving, `Sync: Space` refreshes the view. Styling is `.vw-note-editor` in `_vault_web_theme.scss`.
- `client/vault_web_inline_edit.ts`: the edit session, draft, and GitHub save logic. Reuses the normal CodeMirror view; no full-screen editor or textarea. Toggles the read-only compartment, routes changes to the draft, blocks same-page reloads while editing, and refuses navigation if the draft cannot be saved.

### Commands and navigation

- `client/vault_web_edit.ts` and its test: `Vault: Edit note` (top-bar Edit; calls `openNoteEditor` only for editable notes) and `Vault: Edit on GitHub` (opens a centered popup, at most 1000×800, reused by name). `canEditNote` allows notes editable on GitHub or notes with a local draft, including drafts of notes deleted on GitHub. Does not open pages without `lastModified`, non-`.md` files, or `Library/Std/`. For 30 minutes after opening, refreshes on popup close (checked every second), window focus, and `visibilitychange` (at most once per 10 seconds).
- `client/vault_web_share.ts`, `client/vault_web_share.test.ts`, `client/components/vault_web_share_view.tsx`, and its test: share page with per-service compose links and copyable draft text. X receives text and URL separately; Threads receives one combined string; LinkedIn and Facebook receive only the URL; Instagram and TikTok open their compose screens. Adds the bundled Share page and `Vault: Share`.

## Upstream edits

### Storage and sync

- `client/service_worker.ts`: swaps the sync remote from `HttpSpacePrimitives` to `GitHubSpacePrimitives`, removes unused imports and `clientId`, and answers `claim` with `clients.claim()`.
- `client/service_worker/sync_engine.ts`: disables periodic full sync (`syncInterval` and `syncIntervalRealtimeHealthy` set to infinity) and widens the remote type to `SpacePrimitives` plus `ping()`.
- `client/service_worker/proxy_router.ts`: answers `/.fs` from the remote through `fetchRemote` / `readRemote` instead of the server; waits up to 15 seconds for `configure()` when a request arrives before config (except `Library/Std`). Tests updated accordingly.
- `client/service_worker.ts`: when woken by `perform-space-sync` / `perform-file-sync` after being stopped, does not discard the request; sends `service-worker-started` and waits for config, which starts the first full sync.
- `client/service_worker.ts`: when a new config names a different space (another repository, or connecting for the first time), stops the running sync (`proxyRouter.reset()`) and configures again, instead of keeping the previous repository. The proxy-router handlers are one shared object, removed before being added again.
- `client/space.ts`, `client/client.ts`: poll file lists and the open note only until the initial load completes, then refresh once per `space-sync-complete`. Uses `space.pollPaused` and keeps `watchInterval` for `file:changed`. Does not poll while the tab is hidden.

### Boot and Service Worker

- `client/boot.ts`: on first load, waits until the Service Worker controls the page (`controllerchange`) before sending config and booting the UI. If not controlled, requests `claim` and reloads once after 15 seconds. Reads startup Lua without the vault's `CONFIG.md`, adds `Library/Std/Rootlore/Home.md`, and calls `registerVaultWebHome`. Sends `uiLanguage` to the Service Worker. Imports `client/vault_web_error_reports.ts` first, so errors during boot are reported.
- `client/types/ui.ts`: adds `githubRepo`, `connected`, and `uiLanguage` to `BootConfig`; adds the `claim` message.

### Virtual pages

- `client/content_manager.ts`: renders `vaultWebHome()` read-only when no Home page exists; renders `renderFolderPage()` read-only when a folder has no same-name page; renames "Page not found"; tracks `missingPageShown` and `vaultWebHomeShown`; renders Settings/Account placeholder bodies; passes `textPageName` to `createEditorState`, using `""` for synthetic pages and rebuilding rather than diffing into the previous state; preserves the previous page name on `rebuildEditorState`.
- `client/client.ts`: on `maybeDispatchWidgetsReady`, reopens `missingPageShown` and calls `notifyIndexReady()`; stops connecting to `/.events`; calls `recordLastSync()` on `space-sync-complete`; disables the browser update notice in the desktop app; stops the legacy three-second document-change reload path.

### Security

- `client/space_lua.ts`: `reload()` executes only indexed `space-lua` from `Library/Std/` pages (`objectsWithPage`, sorted by descending priority and ascending ref like upstream). Ref values are not trusted because note data blocks can forge them.
- `client/data/object_index.ts`: adds `objectsWithPage(tag)`, returning the actual indexed page name.
- `client/markdown_renderer/inline.ts`: `expandMarkdown` never evaluates `${...}`, regardless of page or options; leaves it as text. This covers embeds, tables, lists, widget output, Lua `markdown.expandMarkdown`, and `dom.*`.
- `client/space_lua/render_widget.test.ts`: expects `${sample}` to remain literal.
- `client/codemirror/lua_directive.ts`: renders `${...}` only on bundled `Library/Std/` pages, checked against both `luaDirectivePageName` and `currentName()`.
- `client/codemirror/editor_state.ts`: adds optional `textPageName`, stored as `luaDirectivePageName`.
- `client/codemirror/editor_state.test.ts`: adds `currentName` to the test client.

### UI shell and navigation

- `client/editor_ui.tsx`: adds `SidebarRail` and `SidebarRailSpacer` when neither sidebar nor left panel is shown; passes the current left view to `rememberLeftView`; fixes the phone menu target; places `VaultWebPageView` beside `#sb-editor`; reduces top-bar actions to Edit on GitHub; removes the phone menu button.
- `client/components/top_bar.tsx`, `client/styles/top.scss`: replaces the page-name editor with a read-only `PageTitle` showing only the note name (full path in `title`); 20px, then 15px via the theme; replaces the phone button with a hamburger and translated label.
- `client/navigator/ui/components/nav_root.tsx`: hides `DockMenu` and the close button in the left sidebar; adds `SidebarActionButtons` and a collapse button; adds `SidebarFooterButtons` at the bottom.
- `client/navigator/views/space_tree.ts`, `client/navigator/views/pages.ts`, `client/navigator/builtins.test.ts`: translates navigation labels; removes the Meta category; removes Shift-Enter help; hides unavailable read-only pages; shows aliases; makes folders toggle-only (`selectableFolders = false`); removes lock icons in read-only mode; uses `documentIcon` for non-note files.
- `client/navigator/ui/components/list_view.tsx`, `document_view.tsx`, `loading_indicator.tsx`, `content_view.tsx`, `page_widget_frame.tsx`: translated labels and help text; help text hidden in read-only mode.
- `client/editor_commands.ts`, `client/components/vault_web_sidebar_actions.tsx`, `client/editor_ui.tsx`: removes the command-palette entry points (sidebar button, ⌘/, three-finger tap) while keeping the command system.
- `client/media_document_viewer.ts` and its test: translates "Open externally", "Loading document…", and the unsupported-document message.
- `client/client_system.ts`: registers the Rootlore edit and dialog commands; does not load the image-viewer plug (CSP blocks its iframe, leaving an empty viewer; the built-in `<img>` viewer works).
- `client/styles/main.scss`: loads `vault_web_theme` last.
- `client/styles/_vault_web_theme.scss`: hides top-bar actions, the dock menu, the definition button, and the widget-bar close button; extends the sidebar and rail to the top on desktop; adds the Home, Settings, Account, share, and editor styles.

### Build and platform pages

- `client/html/index.html`, `build/build_client.ts`, `scripts/build.mjs`: add the Open Graph image (1200×630), `twitter:card`, and translated metadata.
- `worker/index.ts`: provides `/.config`, `/.ping`, `/.logout`, `/.auth/profile`, `/.auth/avatar`, and pre-Service-Worker `/.fs/Library/Std/*`; disables space styles and plugs.
- `scripts/build.mjs`: fills `index.html`, builds `.client/manifest.json` (no `share_target` yet), `version.json` (from `GITHUB_SHA`), `_base_fs/manifest.json` (only `Library/Std/`), and `dist/_headers` (CSP with hashed inline scripts).

## Edit log

- **2026-11-06 — in-place editing.** Added `client/vault_web_inline_edit.ts`; the read-only compartment now toggles for editing; drafts are separated from autosave/sync; same-page reloads are blocked and navigation is refused if the draft cannot be saved.
- **2026-11-06 — desktop update notices.** The desktop app no longer shows the browser version-mismatch reload notice; it uses the native app updater. The browser notice remains.
- **2026-11-06 — feedback link.** Added a Send icon next to Settings and Account, linking to the Rootlore GitHub issue form.
- **2026-11-06 — share page.** Added `Vault: Share`, the bundled Share page, and per-service compose links.
- **2026-11-07 — disconnected UI.** `wipeClient` deletes only this app's `sb_data_` / `sb_files_` databases. The sidebar and Home show a connect prompt and previews before GitHub is connected.
- **2026-11-09 — demo notes.** Bundled demo notes under `Library/Std/Rootlore/Demo/ja/` and `Demo/en/` are shown only while disconnected, matching the UI language.
- **2026-11-09 — blank screen fix.** The Service Worker pre-caches one file at a time instead of with `addAll`, so a single 404 no longer aborts the whole install, and `login.html` is no longer pre-cached. The notes sidebar opens on first launch through a product default in `view.defaults`, while a user who closed it stays closed.
- **2026-11-10 — connect card.** While GitHub is not connected, the bottom of the left sidebar shows a "リポジトリを連携してはじめる" card that opens the account page, the same destination as the Home and empty-list prompts.
- **2026-11-10 — skills page.** Added `Vault: Skills`, a marketplace page that lists a built-in catalog of repository-organizing skills and writes the chosen one into the repository's `.claude/skills/<id>/SKILL.md` through the same `/commit` path as new notes (project scope, because the web app can only reach the repository). The catalog holds four entries, shown in two groups: OKF (Open Knowledge Format) as the base, and PARA, Johnny.Decimal, and LLM Wiki under "folder layout (pick one)". OKF is the base because it only fixes the shape of a note (one concept per file, frontmatter, `index.md`) and leaves the directory layout open, so it composes with any of the others; the other three each decide where a note goes, so installing two of them makes the agent answer "where does this go?" two different ways. Each `SKILL.md` is written for this app rather than copied from upstream, so it stays one file with no `references/` or `scripts/` to ship; the card links to the source, and only LLM Wiki names a repository (Astro-Han/karpathy-llm-wiki, MIT) because its `raw/` + `wiki/` layout and evidence rules are what the skill is. PARA points at Forte Labs and Johnny.Decimal at johnnydecimal.com, whose official skills assume a `jd` MCP server the vault does not have. Extra fields live under `metadata:` as the Agent Skills spec requires. Codex reads `.agents/skills`, so the same commit adds one symlink `.agents/skills/<id>` → `../../.claude/skills/<id>` instead of a second copy. Because GraphQL `createCommitOnBranch` cannot set a file mode, commits that contain a symlink go through the Git Data API (blobs → trees → commits → ref update with `force: false`); `isWritablePath` allows `.claude/skills/<id>/SKILL.md` as the only hidden-directory path, and `/api/gh` allows `GET .../contents/.claude/skills/<id>/SKILL.md` so the page can tell whether a skill is already installed (hidden folders never appear in the note list).
- **2026-11-10 — feedback page.** The Send button in the sidebar footer no longer opens GitHub directly. It opens `Vault: Feedback` (`Library/Std/Rootlore/要望.md`), a page that offers two ways to send: a GitHub issue (opens the issue form in a new tab) and a form, shown as "準備中" / "Soon" and not wired up yet. The issue URL lives in `client/components/vault_web_feedback_view.tsx` rather than in the sidebar markup, so the form can be added without touching the footer.
- **2026-11-10 — feedback form.** The form on the feedback page now works in the web app. It posts JSON to the Worker (`POST /v/api/feedback`, `worker/feedback.ts`), which stores the message in KV for the signed-in user. Nothing is sent to GitHub, and submissions are not public. The desktop app's local server only relays `/api/gh`, so the desktop app shows a link to the web version instead of the form.
- **2026-11-11 — Obsidian Bases (`.base`) viewer.** Opening a `.base` file shows the matching notes as a read-only table instead of the raw YAML. `client/document_editor_resolver.ts` adds a `base` resolution, chosen by extension because `.base` has no registered content type; `resolveDocumentCapability` reports it as an in-app editor (`plug`, `Bases`) so the shared `DocumentCapability` type stays unchanged. `client/content_manager.ts` creates the new `BaseDocumentViewer` (`client/vault_web_base_viewer.tsx`) and swaps it in like the media viewer. Parsing, filter evaluation, and table building live in `client/vault_web_base.ts`, written from Obsidian's public help pages without using Obsidian code. The first version supports table views (other view types render as a table with a notice), multiple views as tabs, `and` / `or` / `not` filters with comparison and logic expressions, `file.hasTag` / `inFolder` / `hasLink` / `hasProperty`, `date()` / `now()` / `today()`, `order`, `displayName`, `limit`, `groupBy`, and `sort`. Formulas, summaries, method calls, arithmetic, and embeds are not evaluated: they are skipped and listed in an "unsupported" notice. Rows come from the client's page index (excluding `Library/` and meta/template pages), and links from its relations. `scripts/build.mjs` adds `.base` to the bundled `Library/Std` manifest, and the demo notes gain `Demo/Overview.base` and `デモ/一覧.base`.
- **2026-11-12 — error reports.** `client/vault_web_error_reports.ts` starts the Sentry browser SDK at the top of `client/boot.ts`. `boot.ts` now runs its body as `bootApp()` and reports an exception that stops boot (upstream `safeRun` only logs it), plus the config and startup-Lua failures it already caught. `client/client.ts` `reportError` also reports the errors the app catches (except offline, abort, and timeout). Events go to the Worker (`POST /v/api/errors`, `worker/errors.ts`) instead of directly to Sentry, so the page CSP stays `connect-src 'self'` and the DSN lives only in the Worker's secret `SENTRY_APP_DSN`. The Worker rebuilds the first exception event of each envelope from an allowlist: type, stack frames (bundle URLs only), mechanism, release, environment, the `web`/`desktop` surface tag, the redacted page URL, and the User-Agent. Messages are kept only for browser and JavaScript engine error types, with quoted text, paths, file names, and URLs masked. It accepts at most 200 KB, refuses other sites' pages (`Origin`), and is rate-limited per IP (`ERRORS_LIMIT`, 30 per minute). The SDK collects no breadcrumbs, sessions, frame variables, or source lines and sends at most 10 events per page load. Settings gain an "Error reports" choice (`localStorage` `rootlore-error-reports`, on by default). The desktop app's local server forwards `/v/api/errors` to `https://rootlore.app/v/api/errors` on a background thread, two at a time. The Worker reports its own uncaught errors with `SENTRY_DSN`. Without a DSN, nothing is sent.
- **2026-11-12 — open sign-in, a repository per user.** Anyone can sign in, and each user chooses their own repository (Worker: `worker/repos.ts`, `/.auth/repo`). `client/service_worker.ts` reconfigures when the repository changes (see above). The account page links to the chooser (web only). `client/editor_ui.tsx` adds a History button next to Edit in the top bar (`Vault: Note history`, `client/vault_web_edit.ts`), which opens the note's commit list on GitHub; `vault_web_sidebar_actions.tsx` keeps it out of the sidebar, and `Library/Std/Rootlore/Home.md` defines it. `_vault_web_theme.scss`: the outlined `.sb-button` rule no longer applies to primary and danger buttons, which carry both classes, so primary buttons are filled again.
