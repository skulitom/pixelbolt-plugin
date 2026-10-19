# Privacy

This plugin and the Pixelbolt server it starts run on your computer. Neither has an account, telemetry, analytics or
network access, and neither sends your files to the developer or to any other service.

- **What it reads:** the pixel-art recipes (JSON) and PNG files you ask Claude to work with, inside the folder you
  opened in Claude Code. These are usually game art, but they can contain whatever you drew or imported.
- **What it stores:** recipe revisions and exports (PNG, GIF, APNG, atlases, frame sequences), written as new files
  under `output/` in that folder (revisions in `output/.revisions/`), until you delete them.
- **What it sends:** nothing. What Claude itself sends to Anthropic while it works is covered by Anthropic's own
  privacy policy, not this one.

Questions: open an issue on [skulitom/pixelbolt-plugin](https://github.com/skulitom/pixelbolt-plugin/issues), or report
a security problem privately as [SECURITY.md](SECURITY.md) says.
