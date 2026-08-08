---
name: openarch-rules
description: Inspect, validate, scaffold, or scan project OpenArch rules.
---

Use the OpenArch Skill selected for this session. Choose the smallest action supported by project evidence:

```bash
openarch rules check
openarch rules facts
openarch rules skeleton <id>
openarch rules scan [--check]
openarch rules discover [--rule <mjs>]
```

Rules are report-only until the project has calibrated evidence and explicitly selects a quality policy.
