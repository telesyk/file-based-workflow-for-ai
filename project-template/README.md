# Project template

Copy the folder `.workflow/` into a new project (or into `docs/` if the project keeps its documents there, then use that path in `projects.json`).

1. Copy `.workflow/` into the project.
2. In `.workflow/devlog.md`, replace `<project-id>`.
3. Add the project to the hub's `projects.json` (id, title, absolute path of its `.workflow` folder).
4. Paste `CLAUDE-block.md` (with the placeholders replaced) into the project's CLAUDE.md.
5. Use `templates/task.md` and `templates/note.md` as starting points. The `templates/` folder stays outside `.workflow/`, so it is never read as tasks or notes.
6. Run `node <HUB>/sync-manifests.mjs --project <project-id>`.