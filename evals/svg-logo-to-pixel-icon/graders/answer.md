---
type: llm
weight: 2
focus: trace
---

PASS if the final reply says, from tool results in the trace, that a 32x32 pixel-art icon of the logo (a blue disc with a yellow triangle and a blue dot) was rendered with a transparent background and at most 8 colours, and names the PNG it wrote (logo_32.png, or the path the tool reported).

FAIL if the agent declines because the source is an SVG, writes its own drawing script or SVG instead of using a pixel-art tool, delivers no PNG, or claims a file that no tool call wrote.
