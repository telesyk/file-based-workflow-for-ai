## Workflow (.workflow/)

Replace `<HUB>` with the absolute path of the hub folder and `<project-id>` with this project's id from the hub's `projects.json`. Paste this block into the project's CLAUDE.md (do not replace existing content).

- The workflow lives in `.workflow/` of this project. Tasks are in `tasks/` (flat). Notes are in `notes/<category>/` with the categories features, improvements, insights, issues.
- Put a new note into the right category folder. If the classification is unclear (feature, improvement, idea, issue, or new entity versus part of an existing one), ask the user. Do not guess.
- Task status is the frontmatter field `status` (backlog, in-progress, testing, done, unstaged). Never move or rename task files.
- When you finish a task, set `status: testing`. If the user asks for changes, set it back to `in-progress`. Never set `done`. Only the user sets `done` (by telling you, or by moving the card on the hub board).
- Always set `updated:` to today when you edit a task or note.
- After you edit tasks or notes, run: `node <HUB>/sync-manifests.mjs --project <project-id>`
- Never edit `.workflow/board/manifest.json` by hand. It is generated.
- Log every significant decision in `.workflow/devlog.md` (format: Problem, Considered / rejected, Resolution).
- When every task of a stage is `done`, propose the CHANGELOG.md and README.md update for that stage. Show it to the user first. Do not apply it silently.
- Work that changes code in another registered project: do not edit across the boundary. Propose a linked task in that project (with `related: [<project-id>/<task-id>]`) and ask the user before you create it.