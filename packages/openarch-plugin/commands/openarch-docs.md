---
name: openarch-docs
description: Maintain project or shared governance documentation.
---

Use the OpenArch Skill selected for this session, then use one of:

```bash
openarch docs check --changed [files...]
openarch docs record --category <patterns|anti_patterns|decisions> "<title>"
openarch docs status --verify
```

`record` 只创建模板；填写后运行 `openarch docs check --changed <生成路径>` 再检查相似候选。
