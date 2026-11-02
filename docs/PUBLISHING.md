# Publishing Pixelbolt

Registry description: Pixel art and sprite animation for agents: JSON recipes to PNG, APNG, GIF and sprite sheets.

Pushing a version tag runs **Release**: the full test matrix from the Tests workflow on the tagged commit (Node 20, 22 and 24, Windows, macOS, the portable builds and the MCPB bundle), a reproducible MCPB build, its isolated smoke test and MCPB CLI validation, then provenance attestation and a GitHub release, then npm ([npm](#npm)). Nothing is published unless every test job passes. The bundle and checksum are attached immediately; `server.registry.json` is also saved in the `pixelbolt-mcpb` workflow artifact. Existing assets are never replaced: a rerun skips identical bytes and fails on different bytes. Only the highest stable tag is marked Latest.

Rights stay with the jobs that need them, and those jobs run only this repository's code, GitHub's own pinned actions and npm:

| Job | Rights | Runs |
|---|---|---|
| `tests` | read | the Tests workflow, called on the tag |
| `build` | read | tag and version checks, npm package contents, the MCPB build, its smoke test and `npx @anthropic-ai/mcpb validate` |
| `release` | write contents, OIDC, attestations | rebuilds the bundle, refuses unless it is byte for byte the one `build` verified, then attests it and publishes the GitHub release |
| `npm` | OIDC | `npm publish` |
| `npm-check` | read | `npx -y pixelbolt@X.Y.Z --help` from an empty folder |

`build` records the bundle's SHA-256 before any third-party tool runs, and `release` attests its own rebuild, not a file handed over from `build`. So a compromised validation tool or dependency can stop a release but cannot change what is attested or published.

**Registry versions are immutable. A published version cannot be changed. Publishing metadata-only permanently prevents that version from ever getting its bundle.** Nothing publishes to the registry automatically. **Publish to MCP Registry** runs only when dispatched after testing; it uses GitHub OIDC, with no registry account or stored secret. It skips versions already listed.

## Release

1. Bump `package.json`, the metadata-only `server.json` and the Claude Code plugin's `.claude-plugin/plugin.json` to the same `X.Y.Z` in one reviewed commit. Leave `mcpb/manifest.json` without a version; the builder inserts it. Version 0.8.0 is the first release under the Pixelbolt name. Update `mcpb/RELEASE_NOTES.md` with the changes and asset names for each release.
2. Tag that commit and push the tag (substitute the version):

   ```sh
   git tag vX.Y.Z
   git push origin vX.Y.Z
   ```

   The tag must already exist for a manual Release rerun, and the run must start from the tag, because the provenance attestation names the run's own commit:

   ```sh
   gh workflow run release.yml -R skulitom/Pixelbolt --ref vX.Y.Z -f tag=vX.Y.Z
   ```

   A release left as a draft (by an interrupted run, or made by hand) is published by the rerun once every asset matches. Never reuse a tag for changed bytes.

## npm

After the GitHub release, Release's `npm` job publishes the tagged version with npm's trusted publishing: npm accepts the job's GitHub OIDC token in place of an npm token, so no token is stored, no one-time password is asked for, and the package gets provenance. The `build` job has already checked the package contents (only `package.json`'s `files`: no tests, scripts, evals, showcase art or builds). The `npm` job uses npm 11.5.1 or later, skips a version npm already has and publishes with `npm publish --access public` (a version below npm's `latest`, such as a backport, goes out under the `backport` dist-tag instead); then `npm-check`, which holds no rights, runs `npx -y pixelbolt@X.Y.Z --help` from an empty folder. It runs on its own after the release job, so a failure never touches the GitHub release; fix the cause and rerun Release from the tag as above. One npm job runs at a time; if several tags are pushed together, GitHub keeps only the newest waiting job, so check each version with `npm view pixelbolt@X.Y.Z` and rerun Release for any that is missing.

It needs one setting on npmjs.com, made by the package owner: the `pixelbolt` package, **Settings**, **Trusted Publisher**, **GitHub Actions**, with organization or user `skulitom`, repository `Pixelbolt`, workflow filename `release.yml`, no environment, and direct `npm publish` allowed. npm drops a new entry that has no successful publish within two days, so add it shortly before a release. Without it the job fails at `npm publish`, and the owner publishes from an untouched archive of the tag (`git archive vX.Y.Z`) with `npm publish` and their two-factor code.

## Test the release, then list it

From a checkout containing the verification script, download into a fresh folder (substitute the release tag):

```sh
gh release download vX.Y.Z -R skulitom/Pixelbolt -p pixelbolt.mcpb -p pixelbolt.mcpb.sha256 -D dist/release-test
gh attestation verify dist/release-test/pixelbolt.mcpb --repo skulitom/Pixelbolt --signer-workflow skulitom/Pixelbolt/.github/workflows/release.yml
node scripts/verify-mcpb.mjs dist/release-test/pixelbolt.mcpb
```

The verifier uses the bundle's own version, starts its manifest command from a fresh folder, checks all eight tools and help, and renders artwork inside a temporary workspace. It removes its temporary files. Optionally install the downloaded bundle in Claude Desktop: **Settings -> Extensions -> install from file**, choose a workspace and call `pixel_help`, then render a small recipe.

After the download passes testing, dispatch publication:

```sh
gh workflow run publish-registry.yml -R skulitom/Pixelbolt -f tag=vX.Y.Z
```

The publish workflow requires the release, verifies the bundle's Release-workflow attestation, checks the tag and all versions, hashes the downloaded bytes, validates the entry with the pinned publisher, and reads back its published checksum. If a release lacks its bundle, rerun Release to attach it before publishing. Use the dispatch form's `metadata_only` checkbox only when deliberately accepting the permanent loss of installation for that version; an attached bundle always takes precedence.

Check the listing at <https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.skulitom/pixelbolt> and read the workflow's step summary.

## Local build

```sh
node scripts/build-mcpb.mjs --check
node scripts/verify-mcpb.mjs dist/mcpb/pixelbolt.mcpb
npx --yes @anthropic-ai/mcpb@2.1.2 validate dist/mcpb/manifest.json
node scripts/build-mcpb.mjs --registry-entry --tag v0.10.0 --bundle dist/mcpb/pixelbolt.mcpb  # v + package.json's version
```

The dependency-free builder reads an explicit set of runtime inputs from disk, normalizes UTF-8 text from CRLF to LF, sorts ZIP entries and uses a fixed date. Use a clean checkout and the same Node/zlib version to reproduce bytes. `--check` builds twice and compares; differing existing artifacts require a fresh `--out` folder. No version agreement with `server.json` is required for ordinary tests or builds; release and registry entry creation enforce it.

The workspace defaults to `${HOME}`, which already exists. The manifest passes both `--root` for file references and `--out` for exports: `--root` alone does not relocate exports. Renders and revisions go in the workspace's `Pixelbolt` folder, which Pixelbolt creates on first use, so the default writes to `~/Pixelbolt` rather than a generic folder in the home directory. The one exception is `pixel_render`'s `saveAs`, which writes where the user names inside the workspace: PNG, GIF and JSON files only, never under a hidden name (one starting with ".") or in the home folder's `AppData` or `Library`, and with `overwrite` it replaces a JSON file only if it is a recipe, atlas or sequence, so a home-folder workspace can't have its settings files replaced.

awesome-mcp-servers: submit and maintain the directory entry manually.

Glama: submit and maintain its listing manually.
