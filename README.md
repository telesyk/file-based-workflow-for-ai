# Workflow Hub

A small, file-based workflow for working with AI assistants on several projects, and one local board that shows them all.

Every project keeps its tasks, notes and decisions as plain Markdown files in its own `.workflow/` folder. The hub reads these folders and shows them on a kanban-style board. You can switch between projects or see all of them together, and you can move a task to another status by dragging its card.

- **Files are the source of truth.** Tasks and notes are Markdown with simple frontmatter. A generated `manifest.json` per project is only a copy of the metadata.
- **One board for many projects.** The projects can be anywhere on the disk.
- **Made for AI assistants.** Clear rules: a finished task goes to `testing`, only the user sets `done`, every decision is logged in a devlog.
- **No dependencies.** Plain HTML, CSS and JavaScript, and two Node.js scripts that use only built-in modules. Nothing to install.
- **Local only.** The server listens on `127.0.0.1`. Its only write is a task status change that the user makes on the board.

## Quick start

You need Node.js 18 or newer.

1. Try the demo. In the folder `hub-template`, run `node serve.mjs` and open http://localhost:8787/.
2. For your own projects, copy `hub-template` to a new place and delete the `demo` and `shared` folders.
3. Edit `projects.json` and list your projects (see `projects.example.json`).
4. Create the `.workflow/` folder of a project from `project-template`, or follow [ADD-PROJECT.md](ADD-PROJECT.md).
5. Run `node sync-manifests.mjs --all`, then `node serve.mjs`.

## What is in this repository

| Path | Content |
|---|---|
| `hub-template/` | The hub: board, local server, sync script and two sample projects. Copy it for a new solution. |
| `project-template/` | The empty `.workflow/` skeleton, task and note templates, and the rules block for an AI assistant. |
| [DESIGN.md](DESIGN.md) | How it works: data model, board, server rules, safety and design decisions. |
| [ADD-PROJECT.md](ADD-PROJECT.md) | Step-by-step playbook to add a project, also for an AI assistant. |
| [THIRD-PARTY.md](THIRD-PARTY.md) | Third-party code and resources. |

More details are in `hub-template/README.md`.

## License

[MIT](LICENSE). Third-party code keeps its own license, see [THIRD-PARTY.md](THIRD-PARTY.md).
