# Workflow Hub (template)

One local board for all projects of a solution. The projects keep their own `.workflow/` folders. The hub only reads them. The only write is a task status change that you make on the board.

## Start

```
node serve.mjs
```

Open the printed address (default http://localhost:8787/). Use `--port 8790` for another port. Needs Node.js 18 or newer. No install step.

## Use this template for a new solution

1. Copy the whole `hub-template` folder to where the hub should live. Rename it if you want.
2. Edit `projects.json`: set `solution`, and list your projects. See `projects.example.json`.
3. Delete the `demo/` and `shared/` sample folders (or keep `shared/` as a real shared project).
4. Run `node sync-manifests.mjs --all`, then `node serve.mjs`.

When you come back to the board tab, it reloads the manifests. The page is drawn again only if something changed, and then at the same scroll position, so a long note stays where you left it. The "Refresh" button does the same on demand.

Switch projects with the "Project" dropdown at the top of the sidebar: "All projects" or one project. A project without items is listed as "(empty)". The dropdown is hidden when only one project is configured. The choice is part of the address (`#/p/<project-id>/...`), so it survives a reload.

`projects.json` format:

```json
{
  "solution": "MySolution",
  "projects": [
    { "id": "my-app", "title": "MyApp", "path": "C:/Dev/MyApp/.workflow" }
  ]
}
```

- `id`: lowercase slug (a-z, 0-9, -). It is used in URLs and in `related` references. Do not change it later.
- `path`: the `.workflow` folder of the project. Absolute (forward slashes) or relative to the hub folder.
- The list is re-read on each request, so you do not need to restart the server after editing it.

## Sync the manifests

The board reads `<project>/.workflow/board/manifest.json`. It is generated from the frontmatter of tasks and notes.

```
node sync-manifests.mjs --all
node sync-manifests.mjs --project <id>
node sync-manifests.mjs --all --dry-run     (report only, write nothing)
```

- It reports problems and never fixes them silently: wrong status, missing dates, duplicate ids, an id that does not match the filename, broken `related` references, subfolders inside `tasks/`.
- If a project has an older manifest in another format, it is copied to `manifest.json.bak-YYYY-MM-DD` before it is replaced. Delete the copy after you confirm the result.
- Running it again without changes writes nothing.
- Exit code 2 means at least one error was found.

## Frontmatter rules

- Flat `key: value` lines. Inline lists are allowed: `related: [other/task-001]`.
- Quote a value that contains ` #`. Otherwise the text after it is treated as a comment.
- No nested YAML.
- `null` and `~` mean an empty value.
- Notes: `title`, `created`, `updated`. A note without recorded title and dates can carry just `archive: YYYY-MM-DD` instead. The date then stands in for created and updated, and the title is the first `# ` heading.
- Task statuses: `backlog`, `in-progress`, `testing`, `done`, `unstaged`. Anything else becomes `unstaged`, and the text is kept in `note:`.

## Moving tasks on the board

On the Dashboard, drag a card to another column. Or open a task and use the status menu.

- Allowed targets: backlog, in-progress, testing, done. A card cannot be dropped into unstaged.
- The server changes only the `status:` and `updated:` lines of that task file and rebuilds that project's manifest.
- If the file changed since the board loaded, the move is refused and the board reloads.
- Moving a card never moves or renames a file.
- The AI never sets `done`. Your move to `done` is your confirmation.

## Safety

- The server listens on 127.0.0.1 only and accepts only the host names `localhost` and `127.0.0.1` with its own port.
- `GET /p/<id>/...` serves only `.md`, `.json`, `.sql` and image files inside the project's `.workflow` folder. Paths with `..`, `\`, `:` or links that leave the folder are refused.
- The write endpoint needs a same-origin request and a token that the server creates at start.
- There are no CORS headers.

## Files

```
index.html             the board
projects.json          your projects
serve.mjs              local server
sync-manifests.mjs     manifest generator and validator
vendor/marked.min.js   Markdown renderer (works offline)
demo/, shared/         sample projects (delete them)
```

The board loads its fonts from Google Fonts. Offline, it falls back to system fonts.

Third-party code and resources (`marked`, the fonts) are listed in `THIRD-PARTY.md` in the repository root.
