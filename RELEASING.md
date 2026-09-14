# Releasing

Releases are automated with [release-please](https://github.com/googleapis/release-please) and published to npm with provenance.

## How it works

1. Land changes on `main` using [Conventional Commits](https://www.conventionalcommits.org/):
   - `fix:` -> patch bump, `feat:` -> minor bump, `feat!:`/`fix!:` or a `BREAKING CHANGE:` footer -> major bump.
   - `chore:`, `docs:`, `refactor:`, `test:`, `ci:` do not trigger a release on their own.
2. `release-please` opens and keeps updating a `chore(release): x.y.z` PR that bumps `package.json` + `.release-please-manifest.json` and writes `CHANGELOG.md`.
3. Merging that PR tags `vx.y.z`, creates the GitHub Release, and the same workflow's `publish` job builds, tests, and runs `npm publish --provenance`.

There is nothing to publish by hand. Merging the release PR is the release.

## One-time setup

The `publish` job authenticates with a repository secret `NPM_TOKEN` (an npm automation/granular token with publish rights to `@zmerchant/agent-hands`). Provenance is generated via GitHub OIDC (`id-token: write`), independent of the auth token.

To move to tokenless npm Trusted Publishing later: configure this repo + `release-please.yml` as a trusted publisher on npmjs.com, then delete the `NPM_TOKEN` secret and the `NODE_AUTH_TOKEN` line in `release-please.yml`. Nothing else changes.

## Emergency manual publish

Only if CI is unavailable, from a clean `main` at the intended version:

```
npm ci && npm run build && npm test && npm publish --provenance --access public
```
