---
type: llm
weight: 2
focus: trace
---

PASS if the reply doesn't treat this as pixel art: it neither uses nor recommends Pixelbolt or another pixel-art tool, and it either produces SVG markup for the logo or says plainly that it can't write the file here and what would make it.

FAIL if the reply runs or recommends a pixel-art tool, delivers a pixelated or raster logo, or claims an SVG file was written when no tool wrote it.
