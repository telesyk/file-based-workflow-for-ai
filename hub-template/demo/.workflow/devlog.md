---
project: demo
log_format: devlog-v1
---

## 2026-10-20 - Dark mode

### Use CSS variables for the theme

**Problem:** Two color sets must stay in sync.
**Considered / rejected:** A second stylesheet: it would drift from the first.
**Resolution:** One set of CSS variables, redefined for dark mode.
