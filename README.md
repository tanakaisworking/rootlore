<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/brand/rootlore-logo-horizontal-dark.png">
    <img src="docs/brand/rootlore-logo-horizontal.png" alt="Rootlore" width="360">
  </picture>
</p>

<p align="center"><strong>Your knowledge. Rooted in Git.</strong><br>Read, search, and edit the Markdown notes in your GitHub repository.</p>

<p align="center">
  <a href="https://rootlore.app/v/"><strong>Open the web app</strong></a> ·
  <a href="https://github.com/tanakaisworking/rootlore-releases/releases/latest">Download for macOS</a> ·
  <a href="https://github.com/tanakaisworking/rootlore/issues/new">Send feedback</a>
</p>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/readme/hero-dark.webp">
  <img src="docs/readme/hero-light.webp" alt="Rootlore showing a project note with frontmatter, a callout, and task lists, next to a knowledge map of linked notes.">
</picture>

Rootlore turns a GitHub repository of Markdown notes into a workspace you can open anywhere. Your repository stays the source of truth: no sync app, no always-on server, no export step. Rootlore is in open beta, and anyone with a GitHub account can try it.

## Why Rootlore

**Your notes stay yours.** Switching note apps usually means moving your data. With Rootlore, your Markdown and its full history stay in your own repository, readable in Obsidian, on GitHub, or in any editor. If you stop using Rootlore, nothing is left behind.

**Nothing to sync.** Every device opens the same repository. There is no sync service to pay for, no conflicted copies, and no vault to keep in step across machines.

**Built for notes that AI writes.** When agents and scripts write into your notes, you need to see what changed. Every save is a Git commit, and the home screen starts with how your knowledge changed, not with a blank page.

## See your knowledge grow

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/readme/home-dark.webp">
  <img src="docs/readme/home-light.webp" alt="The Rootlore home screen with a year of contributions, note growth by folder, and a knowledge map.">
</picture>

The home screen reads your Git history: a year of contributions, how each folder grew, and the latest changes. The knowledge map draws every `[[link]]` between your notes, so the hubs of your thinking stand out.

## What you can do

- Read Markdown as it is: frontmatter, `[[wikilinks]]`, backlinks, callouts, and images.
- Search across every note. Rootlore keeps a local copy in your browser for full-text search, so it doesn't depend on GitHub's code search.
- See your activity, growth, recent changes, and note connections on the home screen.
- Open a note's history on GitHub to see who changed what, and when.
- Edit a note in place. Saving creates one commit in GitHub. If the note changed remotely since you opened it, Rootlore warns you instead of overwriting it.
- Keep an in-browser draft while editing. Close the tab or navigate away without losing your work.
- Drag files between folders. If a move would conflict, Rootlore returns the file and tells you.
- Use familiar shortcuts: `⌘Z` to undo a move, `⌘,` for settings, and more.
- Work from the CLI or the macOS desktop app when you want to automate or stay out of the browser.

## Getting started

1. Open [Rootlore](https://rootlore.app/v/) and sign in with GitHub.
2. Choose the repository that holds your notes. If your Obsidian vault is already on GitHub, pick that repository.
3. Install the GitHub App on that repository only. If you installed it on several repositories, Rootlore asks which one to open. You can switch later on the Account page.

The App requests read and write access to Contents for the repositories you install it on, and no others. Rootlore reads and writes only the one you open. You can remove the App from any repository in your GitHub settings. Sign-in and repository access are separate steps, so you can see exactly what you are granting.

## Data and permissions

- Rootlore does not store note bodies on its servers. Notes travel only between GitHub and your browser.
- Rootlore keeps only what it needs for sign-in, and the name of the repository you chose, inside your encrypted session cookie. There is no note database.
- On the hosted version, the operator can technically access the repository you connect. We minimize permissions, avoid storing notes server-side, and keep a self-hosting path available.
- You can revoke access from GitHub at any time.
- The app sends error reports (the error type, the stack trace, and browser error messages) to help fix problems. Note contents, file names, and page locations are removed before they leave Rootlore's server. Turn it off in Settings → Error reports. Self-hosted instances send nothing unless they set their own Sentry DSN.

## How it works

- The interface and editor are built on a fork of SilverBullet (MIT).
- The server runs on Cloudflare Workers. Its only jobs are GitHub sign-in and relaying GitHub API requests.
- Notes are read and written through a GitHub App. The browser keeps note bodies in IndexedDB for search and the knowledge map.
- Rootlore talks to GitHub only when you open it, refresh, or save. There is no background sync daemon.

See [docs/architecture.md](docs/architecture.md) for the design.

## Roadmap

- Per-note history, diffs, and restore.
- Grouped change events that explain what changed and why.
- Image and attachment uploads.
- Better mobile reading and a faster knowledge map.
- Self-hosting documentation.

## Development

Node 24 is required.

```sh
git clone https://github.com/tanakaisworking/rootlore.git
cd rootlore
npm ci
npm ci --prefix silverbullet
npm run dev
```

The app runs at http://127.0.0.1:8790. `npm run dev` uses `gh auth token`, so run `gh auth login` first, and set `DEV_GITHUB_REPO=owner/repo` to the repository to open. Worker tests: `npm test`. SilverBullet tests: `npm --prefix silverbullet test`. Contribution rules are in [AGENTS.md](AGENTS.md).

## Feedback

Open a [GitHub Issue](https://github.com/tanakaisworking/rootlore/issues) or use the paper-plane button in the app's sidebar.

Brand assets live in [docs/brand](docs/brand/README.md).

## License

[MIT](LICENSE). The interface is built on [SilverBullet](https://github.com/silverbulletmd/silverbullet) (MIT); its notice is in [silverbullet/LICENSE.md](silverbullet/LICENSE.md).
