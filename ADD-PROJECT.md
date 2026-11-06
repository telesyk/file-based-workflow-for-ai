# Playbook: add a project to the board (hub)

Use this playbook when the user asks to add, connect or register a project on the dashboard, the board or the hub, or to set up the workflow for a project. Read it completely before you start. Do not start to change anything before step 0 is answered.

In this playbook, `<HUB>` is the hub folder: a copy of `hub-template` that holds `projects.json`, `serve.mjs`, `sync-manifests.mjs`, `index.html` and `vendor/`. Ask the user for its path if you do not know it.

## Facts

- The hub holds the list of projects (`projects.json`), a local server (`serve.mjs`), the manifest generator (`sync-manifests.mjs`) and the board (`index.html`). It stores no project data. It only reads the `.workflow/` folders of the projects.
- A project is one code base with a `.workflow/` folder (tasks, notes, devlog). The design is described in `DESIGN.md`.
- The sources for new hubs and projects are `hub-template` and `project-template`. A hub must stay identical to `hub-template`.
- The projects usually live outside the hub folder. Follow the rules of the user (for example a `CLAUDE.md`) about changes outside the workspace. If there is no such rule, ask for a direct approval before you change anything outside the hub folder.
- A script that replaces steps 2 to 5 may be added to the hub later. If one exists, its README tells how to use it. Run it first without writing, and show the result.

## Step 0: ask the user (one message, with your recommendation for each point)

1. The absolute path of the project folder (the code folder) and the title of the project.
2. The project id: lowercase letters, digits and `-` only (no underscore, no space), unique in `projects.json`. Propose one from the title. Example: `My_Plugin` becomes `my-plugin`. The id is used in addresses and in `related` links and must not change later.
3. Where `.workflow/` goes. Default: `<project folder>/.workflow`. Use another place only if the project keeps its documents elsewhere (for example `docs/.workflow`).
4. Does the project already have documents (notes, to-do lists, logs, issue files, a `docs/` folder)? If yes, do "Existing documents" (below) before step 2.
5. Create `README.md` and `CHANGELOG.md` skeletons in the project root? Recommendation: yes if the user wants the "stage complete" proposals for this project. The decision can differ per project.
6. Add the project to the table of the solution-level `CLAUDE.md`, if the solution has one? Recommendation: yes, so that agents in that repository know the project.

## Step 1: check (read only)

- The project folder exists. `<project folder>/.workflow` does not exist yet. The id is valid and not in `projects.json`.
- Is the new folder ignored by git? Run `git -C <project repository> check-ignore -v <path>/.workflow/tasks/x.md`. If it is not ignored, tell the user: the files would show up in `git status` and could be committed by mistake. Ask what to do.
- Look for an existing README, CHANGELOG, CLAUDE.md and `docs/` folder in the project.
- Show the user the plan: every file and folder you will create, and every file you will edit. Ask for approval where the rules of the user require it. Wait for the answer.

## Step 2: create the empty structure (after approval)

```
<project folder>/.workflow/
├── tasks/
├── notes/
│   ├── features/
│   ├── improvements/
│   ├── insights/
│   └── issues/
└── devlog.md
```

- Copy the frontmatter of `project-template/.workflow/devlog.md`, with `project: <project-id>` and `log_format: devlog-v1`.
- Add one first entry that records the decisions of step 0 (location, id, README and CHANGELOG, git ignore), in the devlog format:

```
## YYYY-MM-DD — Workflow setup

### <the decision, phrased as what was resolved>

**Problem:** one sentence.
**Considered / rejected:** (omit this line if nothing else was considered)
**Resolution:** what was decided, and why, briefly.
```

- Do not put `.gitkeep` files in the folders. Do not change any code file of the project.
- If the user wants README.md and CHANGELOG.md: write them in the project root. Use only facts you verified in the project (assembly or package name, namespace, target framework, class names). Do not invent descriptions. The CHANGELOG starts empty (`# Changelog`, one sentence, `---`).

## Step 3: register the project in the hub

- Add an entry to `<HUB>/projects.json`:
  `{ "id": "<project-id>", "title": "<title>", "path": "<absolute path of the .workflow folder, with forward slashes>" }`
- Keep the file valid JSON and put the entry after the last one.

## Step 4: the CLAUDE.md table (only if the user said yes)

- Add one row to the table in the solution-level `CLAUDE.md`: `| <project-id> | <path of the .workflow folder, relative to the repository root> |`.

## Step 5: sync and check

- Run `node <HUB>/sync-manifests.mjs --project <project-id>`. Expected: `manifest written: 0 tasks, 0 notes` (or the real counts) and `No errors.`
- Start the board (`node serve.mjs` in the hub folder, then http://localhost:8787/, or reload it if it already runs). The project must be in the "Project" dropdown (an empty project is marked "(empty)"). `#/p/<project-id>/devlog` must show the devlog.
- Check that `git status` in the project repository shows no new files, if the folder is meant to be ignored.
- Tell the user in a few lines: what was created, the project id, how to open the board, and what is still open.

## Existing documents (when step 0, point 4 is yes)

Never rename or move the old folder in place. Work in this order:

1. **Investigate (read only).** List the files with size, date, frontmatter, headings, images, links, and references to the old folder path. Check whether git tracks the folder, whether the code or other files refer to it, and what the git branches say about the real state of the work (merged or not). Read the unclear files.
2. **Report and ask.** Show the findings and a proposed mapping (old file to new file). Decide with the user: task ids (`task-NNN`, the old label can stay in the file name), one task per issue or not, the status of each task, where images and SQL files go, whether paths inside the notes are rewritten, README, CHANGELOG and devlog. If the classification of an entry is unclear (feature, improvement, idea, issue, task, or part of another entry), ask the user. Do not guess.
3. **Back up.** Copy the old folder to a backup folder outside the project and outside the shared repository, and verify the copy with file hashes. Never delete the backup yourself. It is removed only after the user explicitly confirms the result.
4. **Build `.workflow/` next to the old folder** with a one-off migration script. Run it first as a dry run that prints a report (old to new, rewritten links, unresolved references). Show the report. Apply only after the user agrees. The old folder stays untouched.
5. **Rules for the conversion.**
   - Task status comes from the real state (code that already does it means `done`). A free-text status that starts with an exact enum word keeps that word and moves the rest to `note:`. Anything else becomes `unstaged` with the full text in `note:`. If the state cannot be read from the files, ask.
   - Every task has `id`, `title`, `status`, `stage`, `source`, `created`, `updated` (optional `note`, `related`). The file name starts with the id. Ids are unique in the project.
   - Notes have `title`, `created`, `updated`. A note without recorded title and dates gets only `archive: YYYY-MM-DD`.
   - Never drop content. Rewrite links, image paths and path mentions to the new places. Keep a list of references that cannot be resolved.
6. **Verify.** The sync reports no warnings. Every relative link and image resolves. The assets are identical by hash. The old text lines are still present (except the rewritten paths). Every task and note opens in the board without an error.
7. **Remove the old folder** only after the user confirms. Remove the backup only after the user confirms again.

## Do not

- Do not change the code of the project. Do not commit. Do not delete anything without confirmation. Do not change the status of existing tasks.
- Do not edit another project, and do not change the hub files (change `hub-template` first if a hub change is needed, then copy).
- Do not decide on your own what the user did not decide. Ask.

## Formats (short)

- Task: `tasks/task-NNN-<slug>.md` with the frontmatter above. Status values: `backlog`, `in-progress`, `testing`, `done`, `unstaged`. When an agent finishes a task it sets `testing`. Only the user sets `done`.
- Frontmatter: flat `key: value` lines and inline lists (`related: [project-id/task-012]`). Quote a value that contains ` #`. No nested YAML.
- After every change of a task or note: set `updated:` to today, then run the sync for the project.
