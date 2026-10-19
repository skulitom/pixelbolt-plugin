---
type: llm
weight: 2
focus: trace
---

PASS if the trace shows a targeted edit of revision 3f9a2c1b7d4e that changed only the pixel at x 9, y 7 of the blink frame to k, followed by an export of the new revision, and the final reply reports that one-pixel change and where the new files are.

FAIL if the agent redrew or resent the whole sprite, changed other pixels, did not export, or claims a fix that no tool call made.
