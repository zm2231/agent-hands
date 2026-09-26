# Releasing

Releases are automated with [release-please](https://github.com/googleapis/release-please) and published to npm with provenance.

## How it works

1. Land changes on `main` using [Conventional Commits](https://www.conventionalcommits.org/):
   - `fix:` -> patch bump, `feat:` -> minor bump, `feat!:`/`fix!:` or a `BREAKING CHANGE:` footer -> major bump.
   - `chore:`, `docs:`, `refactor:`, `test:`, `ci:` do not trigger a release on their own.
2. `release-please` opens and keeps updating a `chore(release): x.y.z` PR that bumps `package.json`, `extension/manifest.json`, and `.release-please-manifest.json` and writes `CHANGELOG.md`.
3. Merging that PR tags `vx.y.z`, creates the GitHub Release, and the same workflow's `publish` job builds, tests, and runs `npm publish --provenance`.

There is nothing to publish by hand. Merging the release PR is the release.

## One-time setup

The `publish` job authenticates with npm Trusted Publishing (OIDC). No npm token is stored in the repository. The trusted publisher on npmjs.com is this repository with workflow `release.yml`; renaming the workflow file breaks publishing until the trusted publisher is updated to match.

## Emergency manual publish

Only if CI is unavailable, from a clean `main` at the intended version:

```
npm ci && npm run build && npm test && npm publish --provenance --access public
```
