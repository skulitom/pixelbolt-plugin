# Pixelbolt for Claude Code

Make pixel art with Claude: sprites, sprite sheets, tiles, icons, particle and fluid effects and short animations,
from editable JSON recipes, exported as PNG, GIF, APNG or video frames. Pixelbolt renders exactly what the recipe
says; it contains no AI model and generates nothing on its own. This plugin gives Claude Pixelbolt's MCP tools and its
pixel-art skill.

This repository is Pixelbolt's Claude Code plugin with the Pixelbolt runtime it starts (the files Pixelbolt's npm
package ships), synced from [skulitom/Pixelbolt](https://github.com/skulitom/Pixelbolt), where the source, docs and
releases live. It needs only Node.js 20 or later: no account, no API key and no other dependencies.

## Install

```
claude plugin install pixelbolt --marketplace skulitom/pixelbolt-plugin
```

Or inside Claude Code: `/plugin marketplace add skulitom/pixelbolt-plugin`, then `/plugin install pixelbolt@pixelbolt`.
If you already added the `pixelbolt` marketplace from skulitom/Pixelbolt, keep using it, or remove it first
(`claude plugin marketplace remove pixelbolt`): both have that name and hold the same plugin.

Then restart Claude Code in your project folder and ask in your own words, for example:
- "Make me a 16x16 pixel-art green slime with a 4-frame idle bounce, and export it as a sprite sheet PNG I can drop into
  my Godot project."
- "In the blink frame of my hero sprite, the pixel at x 9, y 7 should be black but it's white. Fix just that pixel."
- "Make a small looping pixel-art campfire with flickering flames and smoke, as a GIF."

## What it runs, writes and sends

- **What it runs:** the plugin starts `node <this plugin's folder>/bin/pixelbolt.js mcp`, running in your project
  folder. Nothing is downloaded or installed. The skill may also have Claude run Pixelbolt's command-line tool
  (`node bin/pixelbolt.js validate|inspect|render|gif|preview`, from the same folder) through its shell, writing where
  Claude tells it to; `preview` serves the studio pages on 127.0.0.1 only and, with `--open`, opens them in your
  browser.
- **What the MCP server reads and writes:** only files under the folder you opened in Claude Code. It reads the recipes and PNGs
  you name there, saves recipe revisions in `output/.revisions/`, and writes each export into a new folder under
  `output/`.
- **What it sends:** nothing. The MCP server uses no network and no external service.
- **What else is here:** `studio/` and `src/server.js` are that preview studio; the MCP server never starts it. `examples/` and `docs/`
  are recipes and guides the tools can point to. `evals/` holds test cases with mocked replies for
  `claude plugin eval`; Claude Code never loads them when you use the plugin.

## Licence and privacy

MIT. See [LICENSE](LICENSE). [Privacy](PRIVACY.md): it runs on your computer and sends nothing. Report a security
problem privately, as [SECURITY.md](SECURITY.md) says.
