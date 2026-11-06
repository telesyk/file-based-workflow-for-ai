# Workflow Hub: design

This document describes how the workflow hub works. It is written for any solution that contains several related projects. It can be reused for a new solution without changes.

## 1. Words used in this document

- **Solution**: a larger scope that contains several related projects, for example a suite of applications.
- **Project**: one code base with its own `.workflow/` folder, for example one application or one plugin.
- **Hub**: one folder per solution. It holds the board, the local server, the sync script and the list of projects. It holds no project data.
- **Item**: a task or a note.

## 2. The picture

```
                       BROWSER  (index.html + marked.min.js)
                          |  GET files            |  POST status change
                          v                       v
   +----------------------------- HUB (serve.mjs, 127.0.0.1 only) -----------------------------+
   |   projects.json  <--- list of projects (id, title, path)                                   |
   |   sync-manifests.mjs  <--- builds manifest.json from frontmatter (also used by serve.mjs)  |
   +------------+---------------------------+---------------------------+-----------------------+
                | /p/<id-1>/...             | /p/<id-2>/...             | /p/<id-3>/...
                v                           v                           v
        <project 1>/.workflow/      <project 2>/.workflow/      <project 3>/.workflow/
          tasks/  notes/              tasks/  notes/              tasks/  notes/
          devlog.md                   devlog.md                   devlog.md
          board/manifest.json         board/manifest.json         board/manifest.json
                ^                           ^                           ^
                |  AI assistants and people edit the Markdown files; then run the sync
```

The Markdown files are the only source of truth. The manifest is a generated copy of the metadata. The browser never touches the disk directly; only the hub server does.

## 3. Principles

1. A file's folder encodes a stable property (kind, note category). Volatile data (status) lives in frontmatter.
2. One copy of every task and note. Nothing is copied into the hub.
3. Every generated file can be rebuilt. Nobody edits `manifest.json` by hand.
4. The hub is local only: it binds to `127.0.0.1`.
5. The server writes in exactly one case: a status change made by the user on the board (section 8). Everything else is read-only.
6. No dependencies, no build step, no framework.
7. Anything that moves, renames or rewrites existing files starts with a timestamped backup outside the tree. The backup is deleted only after the user confirms the result.
8. Keep it as simple as possible. If a choice makes things more complicated, say so explicitly and put it in the ledger (section 11).

## 4. Parts and their jobs

| Part | Where | Job |
|---|---|---|
| `projects.json` | hub | Optional `solution` label, and the list of projects: `id` (lowercase slug), `title`, `path` of the `.workflow` folder (absolute with forward slashes, or relative to the hub folder). |
| `serve.mjs` | hub | Serves the board files and `/p/<id>/...` (read-only). Has one write endpoint for status changes. |
| `sync-manifests.mjs` | hub | Reads task and note frontmatter, validates, writes each project's `board/manifest.json`. Exports `scanProject`, `buildAll`, `writeManifest` and `syncProject`. |
| `index.html` | hub | The board. Reads all manifests, renders views, sends status changes. |
| `vendor/marked.min.js` | hub | Markdown renderer. One copy for all projects. |
| `.workflow/` | each project | tasks, notes, devlog, `board/manifest.json`. Stays inside the project. |
| `CLAUDE.md` | once per solution | AI rules, the hub's sync command and a table of the projects. For projects that share one repository, one file at the repository root covers all of them. Otherwise, one file per project. |

## 5. Data model

**Task** (`tasks/task-NNN-<slug>.md`): `id`, `title`, `status` (backlog, in-progress, testing, done, unstaged), `stage`, `source`, `created`, `updated`, optional `note`, optional `related`.

**Note** (`notes/<category>/<slug>.md`): `title`, `created`, `updated`. The categories are `features`, `improvements`, `insights` and `issues`. A note whose title and dates were not recorded can carry just `archive: YYYY-MM-DD`. The date then stands in for created and updated, and the title is the first `# ` heading.

**Frontmatter rules for the parser**: flat `key: value` scalars and inline arrays of scalars (`[a, b]`). An inline comment after a value is allowed (` # text`); a value that contains ` #` must be quoted. Double-quoted values may contain `\"` and `\\`. `null` and `~` mean an empty value. Nothing else.

**Identity**
- Task: `(project-id, task-id)`.
- Note: `(project-id, file)`. The `file` path is permanent, so it is a stable id.
- Cross-project reference: `<project-id>/<task-id>`.

**Manifest** (per project, generated): `schema`, `project`, `generated`, `tasks[]`, `notes[]`. Each task has `id`, `title`, `status`, `stage`, `source`, `created`, `updated`, `file`, `note`, `related`, `relatedBy`. Each note has `title`, `category`, `created`, `updated`, `file`, and `archive` when the note has one. `file` is relative to the project's `.workflow`. Running the sync again without changes writes nothing.

**Stages** are not stored. The board derives them from the tasks. A stage is complete when all its tasks are `done`. When a stage is complete, an update of the project's CHANGELOG and README is proposed (never applied silently).

**Statuses**: five values. `unstaged` is the catch-all. A free-text status that starts with an exact enum word becomes that word, and the rest goes to `note:`. Otherwise it becomes `unstaged` and the full text goes to `note:`.

**Status flow**: when an AI assistant finishes a task, it sets `testing`. If changes are needed, the task goes back to `in-progress`. Only the user sets `done`.

**Devlog** (`devlog.md`): one append-only decision log per project. One YAML block at the top (`project`, `log_format: devlog-v1`). Each entry has a heading with the date and theme, a heading with the decision, and the lines `Problem`, `Considered / rejected` (omitted if empty) and `Resolution`.

## 6. The board: routes and behavior

### Routes (browser URL hash)

| Hash | View |
|---|---|
| `#/` | Overview of the current selection |
| `#/dashboard` | Kanban of open stages |
| `#/tasks` | Flat list of all tasks |
| `#/notes` | Flat list of all notes |
| `#/devlog` | Devlog of the selected project |
| `#/p/<project-id>` | The same views, limited to one project |
| `#/p/<project-id>/task/<task-id>` | One task |
| `#/p/<project-id>/note/<file>` | One note (file path, URL-encoded) |
| `#/p/<project-id>/stage/<stage>` | One stage |

Fixed words (`task`, `note`, `stage`) come after the project id, so an item name can never clash with a view name. "All projects" is the default; the project selection is part of the hash and is also remembered in `localStorage`. The overview, dashboard, tasks, notes and devlog views also exist per project, for example `#/p/<project-id>/dashboard`. In "All projects" mode the devlog view asks the user to choose a project, because a devlog belongs to one project. Projects are switched with the "Project" dropdown at the top of the sidebar. It lists every project that loaded, marks an empty one "(empty)", and is hidden when fewer than two projects loaded.

### Behavior

- **Identity.** The board loads `/projects.json`, then the manifest of each project. An item is identified by the pair `(project, id)` (notes by `(project, file)`), so two projects can both have a `task-012`.
- **One filter point.** Everything the page shows (sidebar groups and counts, overview, flat lists, search) reads from the single function `visibleItems()`, which applies the current project selection.
- **Unreachable projects.** A project that is configured but cannot be loaded (bad path, missing or old manifest) is shown as a visible warning. It is never dropped silently.
- **"All projects" mode.** Stages are grouped under the project name, and each card shows a small project chip. In single-project mode the chip is hidden.
- **Sidebar.** Tasks are grouped by stage, notes by category. The group titles "Tasks" and "Notes" link to flat pages: "Tasks" shows every task grouped by stage, plus an "Unassigned" section for tasks without a stage; "Notes" shows every note across the categories. A text filter narrows both lists.
- **Overview.** It starts with a merged "Recent changes" feed (the 10 newest items by `updated`, tasks and notes together, tagged *added* when `created` equals `updated`, otherwise *updated*). Below it come the tasks per status and per stage, the open tasks and the notes by category. In "All projects" mode the feed merges all projects.
- **Dashboard.** A kanban of the tasks of the ongoing stages (and the tasks without a stage), one column per status. The `unstaged` column appears only when it has cards. Cards can be dragged between columns (section 8). A stage that becomes complete stays on the Dashboard until the next reload.
- **Task page.** It shows the frontmatter fields as a small header, a status menu, and the `related` and `relatedBy` references as chips (project chip, task id, title and current status). A chip opens that task. A reference that cannot be resolved is shown as a visible warning chip. A linked task is never copied into the other project's list.
- **Status pills.** All five values (`backlog`, `in-progress`, `testing`, `done`, `unstaged`) have a label (`STATUS_LABEL`) and a style (`.pill-<status>`). No status may render blank.
- **Notes.** The Markdown body is rendered. A note with `archive` shows an "Archive <date>" badge. Relative links and images work (section 9).
- **Reload.** The board reloads the manifests when its tab gets the focus, and on the "Refresh" button. The page is drawn again only if something changed, and then at the same scroll position.
- **Look.** Light and dark mode, responsive, clean and unfussy. The page treats `file` as opaque data and never infers anything from folder names.

## 7. Flows

**A. An AI assistant or the user edits a task or note**
1. Edit the Markdown file. Set `updated:` to today.
2. Run `node <HUB>/sync-manifests.mjs --project <id>`.
3. Reload the board (or switch back to its tab; it reloads on focus). The page is drawn again only when something changed, and then at the same scroll position. A move of a card also keeps the position, and the sidebar keeps its position too.

**B. The board loads**
1. Fetch `/projects.json`.
2. Fetch `/p/<id>/board/manifest.json` for each project.
3. A project that fails is shown as a visible warning. It is never hidden silently.
4. Build the list of visible items with one function, `visibleItems()`. Every view reads from it.

**C. The user moves a card on the board** (section 8)

```
drag card -> POST status change -> server checks -> edits 2 lines in the task file
          -> server calls syncProject(project) -> manifest updated -> board redraws
```

## 8. Moving tasks on the board

This is the one write path. It keeps the same files as the source of truth.

**What the user can do**: drag a task card to another status column on the Dashboard, or use a status menu on the task page. Allowed targets: `backlog`, `in-progress`, `testing`, `done`. A card cannot be dropped into `unstaged` (it needs a text in `note:`). A card can be dragged out of `unstaged`.

**What the server does** (`POST /api/task-status`, body: `project`, `id`, `from`, `to`)
1. Check the request (see "Safety").
2. Open the task file. Find the task by `id`.
3. If the current `status` is not `from`, answer 409 (the file changed since the board loaded). Nothing is written to the task file. The server refreshes that project's manifest, and the board reloads, so it shows the real state.
4. Replace only two lines inside the frontmatter: the value of `status:` and the value of `updated:` (today). Keep the inline comment, the line endings, and every other byte.
5. Write to a temp file in the same folder, then rename (no half-written files).
6. Call `syncProject(project)` and write the manifest.
7. Answer with the new task entry.

If `status:` or `updated:` is missing in the file, the server refuses and says why. It does not invent fields.

**Safety (localhost is not automatically safe)**
- Bind to `127.0.0.1` only.
- Accept only requests whose `Host` is `127.0.0.1:<port>` or `localhost:<port>` (stops DNS rebinding).
- Accept only same-origin requests. Send no CORS headers.
- Require a custom header with a random token. The server creates the token at start and gives it only to the page it serves.
- Write only inside configured project roots, only to files under `tasks/`, only the two lines above.

**Rules that stay the same**
- An AI assistant never sets `done`. The user's move to `done` on the board is the confirmation.
- When a stage becomes complete, the board shows a notice: "Stage complete. Ask the AI to propose the CHANGELOG and README update." The board edits neither file. A stage that becomes complete stays on the Dashboard until the next reload.
- Moving a card never moves or renames a file.

**Cost of this feature**: the server can write into project folders, and `serve.mjs` imports `syncProject`. Both are small, but it is a real change from "read-only". See the ledger in section 11.

## 9. Server rules (all requests)

- `GET` serves only the board files of the hub (`index.html`, `vendor/marked.min.js`) and `/p/<id>/<path>`. The scripts and `projects.json` are not served as files. Inside a project, only the extensions `.md`, `.json`, `.sql` (as plain text), `.png`, `.jpg`, `.jpeg`, `.gif`, `.svg`, `.webp`. Everything else: 404.
- In a note, a relative link to a task or note opens that board page, a relative link to another project file opens the file in a new tab, and relative images are served from the project (`..` is resolved on the client).
- `/projects.json` answers with the solution label and the ids and titles of the projects. It never reveals disk paths.
- `/api/session` gives the page its token (same-origin requests only).
- Path safety on Windows: decode the URL, reject `..`, backslashes, drive letters, null bytes and alternate stream names (`:`). Resolve the real path (junctions and links included). Compare it to the project root in a case-insensitive way. Serve only if it is inside.
- Only one `POST` route exists (section 8). Every other method returns 405.
- `projects.json` is re-read on each request to `/projects.json`, so edits need no restart.

## 10. Hub template (reusable)

The template is a plain folder. To start a new solution, copy it and edit `projects.json`.

```
hub-template/
├── README.md                  how to start, sync, add a project, move cards
├── index.html                 the board
├── projects.json              list of projects (edit this); the template lists the two samples
├── projects.example.json      sample entries
├── serve.mjs                  local server
├── sync-manifests.mjs         manifest generator + validator
├── vendor/
│   └── marked.min.js
├── demo/.workflow/            sample project (delete it)
└── shared/.workflow/          sample "shared" project that lives inside the hub (keep it only if you need one)
    ├── tasks/  notes/{features,improvements,insights,issues}/
    └── devlog.md

project-template/              next to hub-template, not inside it
├── README.md                  how to add a project
├── CLAUDE-block.md            the AI rules (placeholders: <HUB>, <project-id>)
├── templates/                 task.md and note.md starting points (outside .workflow, so they are never read as items)
└── .workflow/                 empty skeleton: tasks/, notes/{features,improvements,insights,issues}/, devlog.md
```

Rules for reuse:
- No path is written in any script. All paths come from `projects.json`.
- The hub can live anywhere. Start: `node serve.mjs`. Sync: `node sync-manifests.mjs --all`.
- A project template is a separate small folder, so a new project can be added in one copy.
- Keep the hub files of a real hub identical to `hub-template`. Change the template first, then copy.

## 11. Complexity ledger

| # | Complication | Why it is accepted | Cost |
|---|---|---|---|
| 1 | A local server is required | `fetch()` does not work on `file://`, and projects live in different places | The user starts `node serve.mjs` |
| 2 | A sync script | Removes the double write of frontmatter and manifest | Run it after edits (the AI does this) |
| 3 | The hub path in the CLAUDE.md | The AI must know the sync command | An absolute path in one solution-level file (or in each project, if they do not share a repository) |
| 4 | Cross-project links | Real need: work that touches two projects | One cross-project pass in sync, link chips on the board |
| 5 | Board writes status | Moving cards by hand is wanted | The server can write; extra safety checks; a 409 path |

Cross-project work is supported in two ways. Linked tasks: each project keeps its own task, and the link is written once, as `related: [<project-id>/<task-id>]`, on one side only. The sync derives the reverse links (`relatedBy`). A `shared` project: for one job with one status, an extra entry in `projects.json`. Links do not synchronize statuses.

## 12. Adopting the workflow in a solution

Each step ends with the approval of the user.

1. **Copy `hub-template`** to the place where the hub should live. Edit `projects.json`. Delete the sample projects.
2. **Add the projects one at a time.** Follow `ADD-PROJECT.md`. An empty project is created from `project-template`.
3. **A project with existing documents** is investigated first. Then it is backed up, the new `.workflow/` is built next to the old folder by a migration script that prints a report first, the result is checked in the board, and the old folder is removed only after the user confirms.
4. **Check the board** after each project: the sync reports no errors, the project is in the dropdown, all status pills show, and the pages open without an error.
5. **Write the solution-level `CLAUDE.md`** from `project-template/CLAUDE-block.md`. Show the text to the user before it is written.
6. **Try one card move** on a real project and check the changed file.

## 13. Design decisions

1. **Hub folder.** The hub files are directly in the hub folder, with no extra subfolder.
2. **Dropping into `unstaged`.** Not allowed (it needs a note). Moving a card out of `unstaged` is allowed.
3. **Board refresh.** Reload on tab focus plus a refresh button. No polling.
4. **Notes without recorded title and dates.** Full frontmatter where another source has the data, otherwise `archive: <date>`.
5. **README and CHANGELOG.** Created per project only when the user wants them.
6. **One CLAUDE.md for the solution**, at the repository root, when the projects share one repository.
7. **History stays with the project that recorded it.** It is not copied into another project. New cross-project work uses linked tasks.
8. **Migrations create new task ids** `task-NNN` (the old label can stay in the file name), one task per issue, and notes for analyses. The status comes from the real state; if it cannot be read from the files, the user decides.

## 14. Out of scope

- Publishing the board to a hosted page.
- A `project:` field in item frontmatter, one item in several projects, cross-project stages, automatic status sync between linked tasks, links between notes.
- Editing anything on the board other than task status. Notes, task text, and CHANGELOG/README stay file edits.
- Authentication beyond localhost and the request checks above.
- Any dependency, build tool or framework.

## 15. Lessons from migrating existing projects

- Check whether git hides the workflow folders. Global ignore rules for `.workflow/`, `docs/` or `*.md` are common. Then there is no history, and the backup is the only safety copy.
- Compare the old manifest with the newly generated one field by field before writing it. The old one may hold data that the files do not have (for example note titles and dates, stage display names, short task notes). The files are the truth, but nothing may be lost silently.
- Files may be fuller and newer than a hand-made manifest.
- Free text in frontmatter needs a real parser for quotes: titles with `\"` break a simple one. `stage: null` must read as empty.
- A project without items must still be visible in the switcher, otherwise it looks like the switch does not work.
- Look for an existing README, CHANGELOG or CLAUDE.md before copying hub files into a folder.
- Build the new `.workflow/` next to the old folder instead of renaming in place. Write a migration script that prints a report first, and check links, images and file contents after the run.
- Rewrite path references inside the old notes, and make the board resolve relative links, otherwise the old links break. Keep unresolved references in a list and fix them one by one.
- Notes that mix several kinds of content (analysis plus plan plus status) become a note and one task with the real status. Do not guess the status when it cannot be read from the files: ask.
