---
name: review
description: Review a repository for correctness, security, and missing verification evidence.
license: Apache-2.0
compatibility: Requires a text file reader and no command or network authority.
metadata:
  author: synapti
  version: "1.0.0"
allowed-tools: Read
---

# Review

Inspect the repository evidence before drawing conclusions.

1. Read the smallest relevant source and test files.
2. Identify concrete correctness, security, and recovery risks.
3. Separate verified findings from uncertainty.
4. Cite exact paths and explain how each material claim can be reproduced.
5. Do not claim that tests passed unless durable test evidence is present.
