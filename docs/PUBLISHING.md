# Publishing Pixelbolt

Registry description: Pixel art and sprite animation for agents: JSON recipes to PNG, APNG, GIF and sprite sheets.

Pushing a version tag runs **Release**: tests, a reproducible MCPB build, its isolated smoke test, MCPB CLI validation, provenance attestation and a GitHub release. The bundle and checksum are attached immediately; `server.registry.json` is also saved in the `pixelbolt-mcpb` workflow artifact. Existing assets are never replaced: a rerun skips identical bytes and fails on different bytes. Only the highest stable tag is marked Latest.

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
node scripts/build-mcpb.mjs --registry-entry --tag v0.9.0 --bundle dist/mcpb/pixelbolt.mcpb  # v + package.json's version
```

The dependency-free builder reads an explicit set of runtime inputs from disk, normalizes UTF-8 text from CRLF to LF, sorts ZIP entries and uses a fixed date. Use a clean checkout and the same Node/zlib version to reproduce bytes. `--check` builds twice and compares; differing existing artifacts require a fresh `--out` folder. No version agreement with `server.json` is required for ordinary tests or builds; release and registry entry creation enforce it.

The workspace defaults to `${HOME}`, which already exists. The manifest passes both `--root` for file references and `--out` for exports: `--root` alone does not relocate exports. Renders and revisions go in the workspace's `Pixelbolt` folder, which Pixelbolt creates on first use, so the default writes to `~/Pixelbolt` rather than a generic folder in the home directory.

awesome-mcp-servers: submit and maintain the directory entry manually.

Glama: submit and maintain its listing manually.
