# Contributing

**This repository is a mirror.** The source of `@thefuturesociety/pages-kit` lives in the `kit/`
directory of The Future Society's private repository, where it is tested alongside the server it
talks to. Edit it there, not here: every file in this repository is overwritten by the next sync.

Releases are cut by the sync script (`scripts/sync_kit_mirror.sh --tag`) in that repository. It
copies the kit here, commits, and creates the tag `v<version>` only when `package.json`'s version
equals `KIT_VERSION` in `kit.js`. Pushing that tag runs `.github/workflows/publish.yml`, which
re-runs the tests, re-checks the three versions agree, and publishes to npm with provenance
through npm trusted publishing. No npm token exists anywhere.

Found a bug? Open an issue here; we will fix it at the source.
