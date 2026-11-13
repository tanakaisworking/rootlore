# Working on Rootlore

Rules for anyone changing this repository, people and coding agents alike.

## Layout

- `worker/`: the Cloudflare Worker. It serves the app, handles GitHub sign-in, and relays GitHub API calls for the repository each user chose. It stores no note content.
- `silverbullet/`: the interface and editor, a fork of SilverBullet 2.12.1 (MIT).
- `desktop/`: the macOS app (Tauri 2). It bundles the same interface.
- `cli/`: the command-line client (Rust).
- `docs/`: the design (`architecture.md`) and the list of changes to upstream files (`fork-changes.md`).

## Run it locally

Node 24 is required.

```sh
npm ci && npm ci --prefix silverbullet
npm run build
npx wrangler dev --ip 127.0.0.1 --port 8790 \
  --var DEV_GITHUB_TOKEN:$(gh auth token) --var DEV_GITHUB_REPO:owner/repo
```

`DEV_GITHUB_TOKEN` works only on localhost. It skips the GitHub App sign-in and opens `DEV_GITHUB_REPO`.

The desktop app: `npm run build`, then `cd desktop/src-tauri && cargo run`. Without a bundled `desktop/frontend/`, it serves the repository's `dist/`.

## Before you send a change

1. Type checks: `npx tsc --noEmit` at the root and in `silverbullet/`.
2. Tests: `npm test` (Worker) and `npm --prefix silverbullet test` (SilverBullet).
3. Build: `npm run build`.
4. For UI changes, look at the result in both the light and dark themes.

New logic (Worker routes, sign-in, sync, saving) comes with tests.

## Security model

Notes are often written by AI, so note content must never change the interface or run code.

- Lua runs only from the bundled `Library/Std/` (`silverbullet/client/vault_web_trust.ts`). Notes' `space-lua` blocks, `space-style`, and plugs are not loaded.
- The Worker relays only an allowlist of GitHub API calls for the repository in the user's session (`worker/proxy.ts`). Writes go through `/api/gh/commit` and `/api/gh/move`, which check the base version.
- Tokens stay in an encrypted, HttpOnly cookie. Page JavaScript never sees them.
- Error reports (`worker/errors.ts`) are rebuilt from an allowlist, so note content and file names never reach Sentry.

Keep these properties when you change the code. See `docs/architecture.md` for the details.

## Fork policy

- `silverbullet/` is pinned to SilverBullet 2.12.1. Take only security fixes from upstream.
- Prefer adding new files (named `vault_web_*`) over editing upstream files. When you must edit an upstream file, add a line to `docs/fork-changes.md`.

## UI copy

English comes first.

- Write every new or changed UI string in English, and add the Japanese translation in the same change (`t(ja, en)` in `silverbullet/client/vault_web_i18n.ts`). Never ship a string in only one language.
- English is the default whenever the language is unknown or not Japanese.
- Bundled content that users see (demo notes, sample data) needs both languages.
- Use plain words. No internal terms or abbreviations.

## What does not belong here

The hosted service at rootlore.app has a landing page and paid features that are not part of this repository. Do not add billing, paid-feature code, or the landing page here.

## Docs

`README.md` is for users. `docs/` is English. Code comments are mostly Japanese for now; new comments may be in either language.
