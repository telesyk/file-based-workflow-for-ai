---
title: CSV export crash
created: 2026-10-29
updated: 2026-11-01
---
# CSV export crash
The export stops when a field contains a quote.

## Investigation
Quotes are not escaped in the writer.

![Screenshot](export-crash/shot.png)
