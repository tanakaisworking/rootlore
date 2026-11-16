# Contributing to Rootlore

Thanks for helping. Bug reports, ideas, and pull requests are all welcome.

## Reporting a bug or asking for a feature

Open an [issue](https://github.com/tanakaisworking/rootlore/issues/new/choose). Please do not paste note contents, tokens, or private repository names.

## Sending a change

1. Read [AGENTS.md](AGENTS.md). It has the layout, the security rules, the fork policy for `silverbullet/`, and the rules for UI text (English first, with a Japanese translation in the same change).
2. Keep a pull request to one change, and explain what it changes for the person using the app.
3. Before you open it, run:

   ```sh
   npx tsc --noEmit && npx tsc --noEmit -p silverbullet
   npm test && npm --prefix silverbullet test
   npm run build
   ```

4. For UI changes, check the light and dark themes, and add a screenshot to the pull request.

New logic for sign-in, syncing, or saving needs tests.

## Security issues

Do not open a public issue for a security problem. Report it privately through [GitHub's security advisories](https://github.com/tanakaisworking/rootlore/security/advisories/new).
