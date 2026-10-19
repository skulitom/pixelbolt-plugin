---
type: llm
weight: 2
focus: trace
---

PASS if the final reply says, from tool results in the trace, that a 16x16 slime with a 4-frame idle animation was rendered, and names the exported sprite sheet PNG (and ideally its atlas JSON) with the folder it was written to.

FAIL if the reply only describes how the user could draw it, gives code or ASCII art instead of exported files, says it can't make images, or claims files that no tool call wrote.
