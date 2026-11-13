# Rootlore desktop

The macOS app for Rootlore (Tauri 2). It bundles the same interface as the web app, serves it from a local server, and exposes "search" and "read" to AI tools over MCP. The app writes a diagnostic log to `~/Library/Logs/rootlore-desktop.log`.

The macOS menu lives in `src-tauri/src/menu.rs`. The client reports the UI language and save-button state from `client/vault_web_desktop_menu.ts` through `set_menu_state`. Menu actions pass only allowlisted IDs to existing client commands; cut, copy, and paste use the operating system.

The title bar uses the macOS transparent style and applies the sidebar background color to the NSWindow. It preserves the standard title-bar height and traffic-light position and follows light/dark mode changes.

## Update distribution

Eight seconds after launch, the app reads `latest.json` and asks whether to install a newer version. "Update" replaces the app and reopens it. You can also check from Help → Check for Updates.

- Manifest: `https://raw.githubusercontent.com/tanakaisworking/rootlore-releases/main/latest.json`
- Releases: `tanakaisworking/rootlore-releases`.
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
