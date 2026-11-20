# Rootlore desktop

The macOS app for Rootlore (Tauri 2). It bundles the same interface as the web app, serves it from a local server, and exposes "search" and "read" to AI tools over MCP. The app writes a diagnostic log to `~/Library/Logs/rootlore-desktop.log`.

The macOS menu lives in `src-tauri/src/menu.rs`. The client reports the UI language and save-button state from `client/vault_web_desktop_menu.ts` through `set_menu_state`. Menu actions pass only allowlisted IDs to existing client commands; cut, copy, and paste use the operating system.

The title bar uses the macOS transparent style and applies the sidebar background color to the NSWindow. It preserves the standard title-bar height and traffic-light position and follows light/dark mode changes.

## Crash safety

Every entry point the operating system or the page calls (menu, sign-in deep link, navigation, new windows, commands, quit) runs through `src-tauri/src/guard.rs`. A panic there is logged as `recovered-panic` in `~/Library/Logs/rootlore-desktop.log` and the app keeps running; a panic that escapes into Objective-C would make macOS abort the whole app. Work that can fail, such as the network calls after sign-in, runs on its own thread. Shared state uses `guard::lock`, so one failure does not poison every later access. The local server answers each request inside `guard::run`, so one bad request cannot stop it. Keep `panic = "unwind"` in `Cargo.toml`.

## Update distribution

Eight seconds after launch, and every two hours after that, the app reads `latest.json`. If a newer version exists, it downloads it in the background without asking and installs it when you quit (`src-tauri/src/update.rs`), so the next launch runs the new version. Installing while the app runs would mix the running build with the new bundled UI, so it waits for quit. Rootlore → Check for Updates… still asks, installs, and reopens right away.

The first time a new version opens, the app shows Update History (`silverbullet/client/vault_web_releases.ts`). It is also in the Rootlore menu, on the Settings page, and in the command `Vault: Update History`.

- Manifest: `https://github.com/tanakaisworking/rootlore/releases/latest/download/latest.json`, a file attached to the latest app release.
- Before building a release, add its notes (Japanese and English) to the top of `silverbullet/client/vault_web_releases.ts`, with the same version as `src-tauri/tauri.conf.json`.
- To release the app: create a `v<version>` release of `tanakaisworking/rootlore` with `Rootlore.app.tar.gz`, its `.sig`, `latest.json` (this release's download URL and signature), and the current `cli-latest.json`. Mark it as the latest release. The manifest goes live with the release, so attach everything in one step.
- Apps up to 0.0.8 read `https://raw.githubusercontent.com/tanakaisworking/rootlore-releases/main/latest.json` instead. That archived repository points them to 0.0.9, which reads the new location.
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

Each file is named `rootlore-<platform>`, and `cli-latest.json` lists it under the same `<platform>`: `macos-aarch64`, `linux-x86_64`, `linux-aarch64`, and the static builds `linux-x86_64-musl` and `linux-aarch64-musl`. A musl build updates to the musl file.

To release: bump `version` in `cli/Cargo.toml`, then push the tag `cli-v<version>` (or run the workflow from the Actions tab). `.github/workflows/release-cli.yml` builds and tests every platform, signs the files with the `TAURI_SIGNING_PRIVATE_KEY` secret (and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` if the key has one), uploads them to a `cli-v<version>` release that is not marked latest (so the app stays the latest release), and then attaches `cli-latest.json` to the latest app release. The files go up before the manifest so no client sees a missing download.

`scripts/release-cli.sh` builds and signs only the macOS file of the Mac it runs on. Use it to check a build locally; its `cli-latest.json` lists only that platform, so do not upload it.
