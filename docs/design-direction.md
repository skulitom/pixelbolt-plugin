# Studio design direction

Requested direction: dark mode, informed by popular GitHub creative tools. Research references and dated star counts are in [competitive-review.md](competitive-review.md).

Use the spatial organization of a creative workspace: projects left, artwork center, source and palette right, timeline directly under the canvas. At narrow widths move the source below the artwork and keep playback visible. The tool should feel compact, legible and local.

| Token | Color | Purpose |
| --- | --- | --- |
| Canvas shell | `#17191d` | Workspace background |
| Panel | `#1d2025` | Header, inspector and controls |
| Raised surface | `#252930` | Frame cards, segmented control |
| Border | `#33363f` | Low-contrast separation |
| Foreground | `#e6e7eb` | Main text |
| Muted foreground | `#a1a4ad` | Secondary text |
| Accent | `#c4b9f3` | Primary action and active state |
| Selection | `#302d3e` | Selected asset/frame background |

Use system sans-serif text and a local monospace face for source. Avoid remote font dependencies. Keep the checkerboard neutral and low contrast. Never invert, desaturate or tint the artwork to implement the theme. Palette swatches show the actual asset colors. Focus indicators remain conspicuous, and native controls use `color-scheme: dark`.

The restrained UI lets sprite colors carry the visual character. No decorative glow, background gradients or extra marketing panels are needed.
