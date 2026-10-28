# Releasing

This card prepares packages for release. It does not authorize publication,
registry registration, or changing game consumers.

## First publication (owner)

1. Review CI, package contents (`npm pack --dry-run --workspaces`), licenses and
   the independent parity receipts. Keep both initial package versions aligned.
2. The owner publishes `l10n-c`, then `vite-plugin-l10n-c`, with npm 2FA. New
   packages need this one-time bootstrap before trusted publishing can be set.
3. Immediately register a trusted publisher for each package: GitHub owner
   `Blosharper`, repository `l10n-c`, workflow filename `release.yml`. No environment
   is specified by this workflow; leave that publisher field empty. Complete and
   verify registration within the owner's 48-hour bootstrap window.
4. Verify registry visibility and provenance with a fresh isolated install.
   Migration of the game's consumers is a separate card after the first release.

No token is stored in this repository. Do not add an npm token to bypass bootstrap.

## Subsequent releases

Conventional commits feed the manifest-based release-please workflow. It opens a
release PR, updates workspace versions/dependency ranges and changelogs, then
creates per-package tags/releases once that PR is merged. The node-workspace
plugin tracks the adapter's dependency on the core. Core publishes before adapter.

The owner reviews and merges release PRs. There is no merge driver or sweeper.
With the default `GITHUB_TOKEN`, release-please PR creation does not trigger CI;
dispatch `ci.yml` on that release branch and check its actual head before merging.
An explicitly configured `RELEASE_PLEASE_TOKEN` is an optional escape hatch, as in
the sibling repositories. If the release PR was merged with `GITHUB_TOKEN`,
manually dispatch `release.yml` on main for the tag/publish half.

Publishing runs on a GitHub-hosted runner with `id-token: write`, npm 11, and
`npm publish --provenance --access public`. `actions/setup-node` deliberately omits
`registry-url` so token placeholders cannot preempt OIDC. Each publish is gated on
that package's `release_created` output; ordinary pushes do not publish packages.
Keep the workflow filename `release.yml` synchronized with npm trusted publishers.

A failed publication is a failed release; inspect its logs and registry state.
Do not bump versions or republish a tag blindly to conceal an earlier failure.
