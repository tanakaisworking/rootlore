# Rootlore desktop

The macOS app for Rootlore (Tauri 2). It bundles the same interface as the web app, serves it from a local server, and exposes "search" and "read" to AI tools over MCP. The app writes a diagnostic log to `~/Library/Logs/rootlore-desktop.log`.

The macOS menu lives in `src-tauri/src/menu.rs`. The client reports the UI language and save-button state from `client/vault_web_desktop_menu.ts` through `set_menu_state`. Menu actions pass only allowlisted IDs to existing client commands; cut, copy, and paste use the operating system.

The title bar uses the macOS transparent style and applies the sidebar background color to the NSWindow. It preserves the standard title-bar height and traffic-light position and follows light/dark mode changes.

## Update distribution

Eight seconds after launch, the app reads `latest.json` and asks whether to install a newer version. "Update" replaces the app and reopens it. You can also check from Rootlore → Check for Updates….

- Manifest: `https://github.com/tanakaisworking/rootlore/releases/latest/download/latest.json`, a file attached to the latest app release.
- To release the app: create a `v<version>` release of `tanakaisworking/rootlore` with `Rootlore.app.tar.gz`, its `.sig`, `latest.json` (this release's download URL and signature), and the current `cli-latest.json`. Mark it as the latest release. The manifest goes live with the release, so attach everything in one step.
- Apps up to 0.0.8 read `https://raw.githubusercontent.com/tanakaisworking/rootlore-releases/main/latest.json` instead. Until `rootlore-releases` is archived, also commit the same `latest.json` there so those apps update to a version that reads the new location.
- Update archives are signed with the updater key. The public key is in `src-tauri/tauri.conf.json` under `plugins.updater.pubkey`, so the app installs only builds signed by the matching private key.

## How the app carries the UI

The app **bundles the UI** instead of loading the hosted site. It copies the output of `npm run build` (`dist/`) into `desktop/frontend/` and ships it inside the app.

- On launch, a local server at `127.0.0.1:37420` serves the bundled UI. `127.0.0.1` is a secure context, so Service Workers work.
- If our server is down, the UI still opens.

### Two ways to connect

| Method | What it does | What it depends on |
| --- | --- | --- |
| Direct token (recommended) | The app calls GitHub directly with a token the user creates | GitHub only |
| GitHub App | Requests go through our server (rootlore.app) | Our server |

Both use the same sign-in screen (`/.auth`). The token field appears only in the locally running app; the client checks whether `/connect/available` exists.

- The token is stored in the macOS Keychain. It is never exposed to page JavaScript.
- The relay accepts only a fixed set of paths for the connected repository (same as `worker/proxy.ts`). Everything else returns 403.
- Host and Origin are checked so other sites cannot call the relay.

### Build

```sh
npm run build:desktop      # from the repository root; builds dist/ and copies it to desktop/frontend/
cd desktop
npx tauri build --bundles app   # unsigned, for local use
```

The app is about 35 MB (19 MB UI + 15 MB app). After changing the UI, users do not receive it until a new build ships.

## Command-line tool

The app carries the CLI (`cli/`) as `Contents/MacOS/rootlore-cli`. `npm run build:desktop` builds it into `src-tauri/binaries/`, which Tauri bundles through `externalBin`; `cargo run` needs that file too, so run `npm run build:cli` first.

On launch, the app links `~/.local/bin/rootlore` to the bundled CLI (`src-tauri/src/cli_link.rs`), following the same rules as Hermes Desktop:

- If nothing is there, it creates the link. Updating the app then updates the CLI too.
- It never touches a regular file (a CLI installed on its own) or a link that still works.
- It replaces a broken link only when it pointed at a bundled `rootlore-cli`, for example after the app moved.

Deleting the app leaves the link broken. The standalone CLI still installs and works without the app.

## Standalone CLI releases

`rootlore update` (`cli/src/update.rs`) reads `cli-latest.json` attached to the latest app release, downloads the file for the platform, and checks it with the app's updater public key before replacing itself. A CLI inside the app refuses and points to the app update. CLI 0.2.0 still reads it from `rootlore-releases`.

To release: bump `version` in `cli/Cargo.toml`, run `TAURI_SIGNING_PRIVATE_KEY=<key> scripts/release-cli.sh`, upload `dist-cli/rootlore-macos-aarch64` and its `.sig` to a `cli-v<version>` release of `tanakaisworking/rootlore` (mark it not latest, so the app stays the latest release), then attach `dist-cli/cli-latest.json` to the latest app release with `gh release upload <tag> dist-cli/cli-latest.json --clobber`. Upload the CLI file before the manifest so no client sees a missing download.
