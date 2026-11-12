(function () {
  "use strict";

  marked.setOptions({ gfm: true, breaks: false });

  var STATUS_ORDER = ["backlog", "in-progress", "testing", "done", "unstaged"];
  var MOVE_TARGETS = ["backlog", "in-progress", "testing", "done"];
  var STATUS_LABEL = { "backlog": "Backlog", "in-progress": "In Progress", "testing": "Testing", "done": "Done", "unstaged": "Unstaged" };
  var CATEGORY_ORDER = ["features", "improvements", "insights", "issues"];
  var CATEGORY_LABEL = { "features": "Features", "improvements": "Improvements", "insights": "Insights", "issues": "Issues" };
  var VIEWS = ["dashboard", "tasks", "notes", "devlog"];

  var SOLUTION = "";
  var PROJECTS = [];            // { id, title, ok, error, manifest }
  var DATA = { tasks: [], notes: [] };
  var byKey = {};               // "project/task-id" -> task ; "project/notes/..." -> note
  var byFile = {};              // "project/<file path>" -> task or note (to resolve relative links)
  var ongoingAtLoad = {};       // "project|stage" -> true
  var selection = "all";        // "all" or a project id
  var route = { kind: "overview", view: "overview" };
  var sessionToken = null;
  var dragKey = null;
  var lastRefresh = 0;
  var restoreScroll = null;     // scroll position of the content area to keep during the next render()
  var pendingScroll = null;     // same, but applied after the Markdown body has been loaded

  /* ---------------- helpers ---------------- */

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  var enc = encodeURIComponent;
  function $(id) { return document.getElementById(id); }
  function statusKey(s) { return STATUS_LABEL[s] ? s : "unstaged"; }
  function pill(status) { var k = statusKey(status); return '<span class="pill pill-' + k + '">' + STATUS_LABEL[k] + "</span>"; }
  function catLabel(c) { return CATEGORY_LABEL[c] || c; }
  function projTitle(pid) { var p = PROJECTS.filter(function (x) { return x.id === pid; })[0]; return p ? p.title : pid; }
  function chip(pid) { return selection === "all" ? '<span class="pill pill-project">' + esc(projTitle(pid)) + "</span>" : ""; }
  function byUpdatedDesc(a, b) { return a.updated < b.updated ? 1 : a.updated > b.updated ? -1 : (a.key < b.key ? -1 : 1); }
  function byIdAsc(a, b) { return a.key < b.key ? -1 : a.key > b.key ? 1 : 0; }
  function isDone(t) { return t.status === "done"; }

  function hView(view) { return "#/" + (selection === "all" ? "" : "p/" + enc(selection) + "/") + (view === "overview" ? "" : view); }
  function hTask(t) { return "#/p/" + enc(t.project) + "/task/" + enc(t.id); }
  function hNote(n) { return "#/p/" + enc(n.project) + "/note/" + enc(n.file); }
  function hStage(pid, stage) { return "#/p/" + enc(pid) + "/stage/" + enc(stage || "__unassigned"); }
  function hItem(it) { return it.kind === "task" ? hTask(it) : hNote(it); }

  function fetchJson(url) {
    return fetch(url, { cache: "no-store" }).then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status + " for " + url);
      return r.json();
    });
  }
  function fetchText(url) {
    return fetch(url, { cache: "no-store" }).then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status + " for " + url);
      return r.text();
    });
  }

  var toastTimer = null;
  function toast(msg, isErr) {
    var el = $("toast");
    el.textContent = msg;
    el.className = "toast" + (isErr ? " err" : "");
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.hidden = true; }, isErr ? 8000 : 5000);
  }

  /* ---------------- data loading ---------------- */

  function loadAll() {
    return fetchJson("/projects.json").then(function (cfg) {
      SOLUTION = cfg.solution || "";
      return Promise.all((cfg.projects || []).map(function (p) {
        return fetchJson("/p/" + enc(p.id) + "/board/manifest.json").then(function (m) {
          if (m.schema !== 1) throw new Error("unsupported manifest format (schema " + m.schema + "); run: node sync-manifests.mjs --project " + p.id);
          return { id: p.id, title: p.title || p.id, ok: true, manifest: m };
        }).catch(function (e) {
          return { id: p.id, title: p.title || p.id, ok: false, error: String(e.message || e) };
        });
      }));
    }).then(function (list) {
      PROJECTS = list;
      DATA = { tasks: [], notes: [] };
      byKey = {};
      byFile = {};
      list.forEach(function (p) {
        if (!p.ok) return;
        p.manifest.tasks.forEach(function (t) {
          t.project = p.id; t.kind = "task"; t.key = p.id + "/" + t.id;
          DATA.tasks.push(t); byKey[t.key] = t; byFile[p.id + "/" + t.file] = t;
        });
        p.manifest.notes.forEach(function (n) {
          n.project = p.id; n.kind = "note"; n.key = p.id + "/" + n.file; n.id = n.key;
          DATA.notes.push(n); byKey[n.key] = n; byFile[n.key] = n;
        });
      });
      ongoingAtLoad = {};
      stageGroups(DATA.tasks).forEach(function (g) { if (!g.closed) ongoingAtLoad[g.project + "|" + g.stage] = true; });
      var latest = "";
      list.forEach(function (p) { if (p.ok && p.manifest.generated > latest) latest = p.manifest.generated; });
      var txt = "snapshot " + (latest || "—");
      $("snapshotLine").textContent = txt;
      $("snapshotPill").textContent = txt;
      $("brandEyebrow").textContent = SOLUTION || "Workflow Hub";
      lastRefresh = Date.now();
    });
  }

  /* ---------------- selection and filtering ---------------- */

  function visibleItems() {
    var f = function (x) { return selection === "all" || x.project === selection; };
    return { tasks: DATA.tasks.filter(f), notes: DATA.notes.filter(f) };
  }
  // Every project that loaded is offered in the switcher, also an empty one (it is marked "(empty)").
  function switchableProjects() {
    return PROJECTS.filter(function (p) { return p.ok; });
  }
  function isEmptyProject(p) { return p.manifest.tasks.length + p.manifest.notes.length === 0; }
  function categories(notes) {
    var extra = [];
    notes.forEach(function (n) { if (CATEGORY_ORDER.indexOf(n.category) === -1 && extra.indexOf(n.category) === -1) extra.push(n.category); });
    return CATEGORY_ORDER.concat(extra.sort());
  }
  function stageGroups(tasks) {
    var map = {}, order = [];
    tasks.forEach(function (t) {
      var k = t.project + "|" + (t.stage || "");
      if (!map[k]) { map[k] = { project: t.project, stage: t.stage || "", tasks: [] }; order.push(k); }
      map[k].tasks.push(t);
    });
    var arr = order.map(function (k) { return map[k]; });
    arr.forEach(function (g) {
      g.unassigned = !g.stage;
      g.closed = !g.unassigned && g.tasks.every(isDone);
      g.name = g.unassigned ? "Unassigned" : g.stage;
      g.tasks.sort(byIdAsc);
    });
    arr.sort(function (a, b) {
      return (a.closed ? 1 : 0) - (b.closed ? 1 : 0) || (a.unassigned ? 1 : 0) - (b.unassigned ? 1 : 0) ||
        (a.project < b.project ? -1 : a.project > b.project ? 1 : 0) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    });
    return arr;
  }
  function groupLabel(g) { return selection === "all" ? projTitle(g.project) + " / " + g.name : g.name; }

  /* ---------------- routing ---------------- */

  function parseHash() {
    var raw = location.hash.replace(/^#\/?/, "");
    var seg = raw ? raw.split("/").map(function (s) { try { return decodeURIComponent(s); } catch (e) { return s; } }) : [];
    var known = function (pid) { return PROJECTS.some(function (p) { return p.id === pid; }); };
    if (seg.length === 0) return { kind: "list", view: "overview", sel: "all" };
    if (seg[0] !== "p") return { kind: "list", view: VIEWS.indexOf(seg[0]) >= 0 ? seg[0] : "overview", sel: "all" };
    var pid = seg[1];
    if (!pid || !known(pid)) return { kind: "list", view: "overview", sel: "all" };
    if (seg.length === 2) return { kind: "list", view: "overview", sel: pid };
    if (seg[2] === "task" && seg[3]) return { kind: "task", project: pid, id: seg[3] };
    if (seg[2] === "note" && seg[3]) return { kind: "note", project: pid, file: seg[3] };
    if (seg[2] === "stage" && seg[3]) return { kind: "stage", project: pid, stage: seg[3] === "__unassigned" ? "" : seg[3] };
    return { kind: "list", view: VIEWS.indexOf(seg[2]) >= 0 ? seg[2] : "overview", sel: pid };
  }
  function saveSelection() { try { localStorage.setItem("hub.selection", selection); } catch (e) { /* blocked */ } }
  function restoreSelection() {
    try {
      var s = localStorage.getItem("hub.selection");
      if (s && (s === "all" || PROJECTS.some(function (p) { return p.id === s; }))) selection = s;
    } catch (e) { /* blocked */ }
  }

  function render() {
    route = parseHash();
    if (route.kind === "list") { selection = route.sel; saveSelection(); }
    buildSwitcher();
    buildSidebar($("searchBox").value);
    var scroll = $("contentScroll");
    if (route.kind === "list") {
      if (route.view === "overview") renderOverview();
      else if (route.view === "dashboard") renderDashboard();
      else if (route.view === "tasks") renderAllTasks();
      else if (route.view === "notes") renderAllNotes();
      else if (route.view === "devlog") renderDevlog();
    } else if (route.kind === "task") renderTask(byKey[route.project + "/" + route.id]);
    else if (route.kind === "note") renderNote(byKey[route.project + "/" + route.file]);
    else if (route.kind === "stage") renderStage(route.project, route.stage);
    // A normal navigation starts at the top. A refresh or a status move keeps the position of the reader.
    if (restoreScroll !== null) { scroll.scrollTop = restoreScroll; pendingScroll = restoreScroll; restoreScroll = null; }
    else { scroll.scrollTop = 0; pendingScroll = null; }
  }

  // Render the current page again and keep the scroll position of the content area.
  function renderKeep() {
    restoreScroll = $("contentScroll").scrollTop;
    render();
  }

  // Called when an asynchronously loaded body has been inserted: put the reader back where they were.
  function applyPendingScroll() {
    if (pendingScroll === null) return;
    $("contentScroll").scrollTop = pendingScroll;
    pendingScroll = null;
  }

  /* ---------------- switcher and sidebar ---------------- */

  function buildSwitcher() {
    var q = switchableProjects();
    var el = $("switcher");
    if (q.length <= 1) { el.hidden = true; el.innerHTML = ""; return; }
    var view = route.kind === "list" ? route.view : "overview";
    var h = function (pid) { return "#/" + (pid === "all" ? "" : "p/" + enc(pid) + "/") + (view === "overview" ? "" : view); };
    var html = '<label class="switcher-label" for="projectSelect">Project</label><select id="projectSelect" class="project-select">' +
      '<option value="all"' + (selection === "all" ? " selected" : "") + ">All projects</option>";
    q.forEach(function (p) { html += '<option value="' + esc(p.id) + '"' + (selection === p.id ? " selected" : "") + ">" + esc(p.title) + (isEmptyProject(p) ? " (empty)" : "") + "</option>"; });
    html += "</select>";
    el.innerHTML = html;
    el.hidden = false;
    $("projectSelect").addEventListener("change", function (e) { location.hash = h(e.target.value); });
  }

  function matches(item, q) { return ((item.key || "") + " " + item.title).toLowerCase().indexOf(q) !== -1; }
  function activeKey() { return route.kind === "task" ? route.project + "/" + route.id : route.kind === "note" ? route.project + "/" + route.file : ""; }

  function navItem(it) {
    var active = it.key === activeKey() ? " active" : "";
    var idLabel = it.kind === "task" ? it.id : it.category;
    return '<a href="' + hItem(it) + '" class="nav-item' + active + '" title="' + esc(it.title) + '">' +
      '<span class="item-id">' + (selection === "all" ? esc(projTitle(it.project)) + " · " : "") + esc(idLabel) + "</span>" +
      '<span class="item-title">' + esc(it.title) + "</span></a>";
  }

  function stageNavItem(g) {
    var done = g.tasks.filter(isDone).length;
    var active = route.kind === "stage" && route.project === g.project && route.stage === g.stage ? " active" : "";
    return '<a href="' + hStage(g.project, g.stage) + '" class="nav-item' + active + '" title="' + esc(groupLabel(g)) + '">' +
      '<span class="item-id">' + (g.unassigned ? "no stage" : g.closed ? "closed" : "ongoing") + "</span>" +
      '<span class="item-title">' + esc(groupLabel(g)) + "</span></a>" +
      '<div class="nav-empty" style="padding-left:24px;margin-top:-4px;">' + done + " / " + g.tasks.length + " done</div>";
  }

  function navLink(view, label, icon) {
    var on = route.kind === "list" && route.view === view;
    return '<a href="' + hView(view) + '" class="nav-home' + (on ? " active" : "") + '">' + icon + " " + label + "</a>";
  }

  function buildSidebar(filterText) {
    var q = (filterText || "").trim().toLowerCase();
    var vis = visibleItems();
    var html = "";

    PROJECTS.filter(function (p) { return !p.ok; }).forEach(function (p) {
      html += '<div class="nav-warn">⚠ ' + esc(p.title) + ": " + esc(p.error) + "</div>";
    });

    html += navLink("overview", "Overview", "▸") + navLink("dashboard", "Dashboard", "▦") + navLink("devlog", "Devlog", "✎");

    var onTasks = route.kind === "list" && route.view === "tasks";
    html += '<div class="nav-group"><div class="nav-group-title"><a href="' + hView("tasks") + '"' + (onTasks ? ' class="active"' : "") + ">Tasks</a><span class=\"mono\">" + vis.tasks.length + "</span></div>";
    if (q) {
      var m = vis.tasks.filter(function (t) { return matches(t, q); });
      html += '<div class="nav-subgroup"><div class="nav-subgroup-title">Matching<span class="nav-subgroup-count">' + m.length + "</span></div>";
      html += m.length ? m.sort(byIdAsc).map(navItem).join("") : '<div class="nav-empty">no matches</div>';
      html += "</div>";
    } else {
      stageGroups(vis.tasks).forEach(function (g) { html += stageNavItem(g); });
    }
    html += "</div>";

    var onNotes = route.kind === "list" && route.view === "notes";
    html += '<div class="nav-group"><div class="nav-group-title"><a href="' + hView("notes") + '"' + (onNotes ? ' class="active"' : "") + ">Notes</a><span class=\"mono\">" + vis.notes.length + "</span></div>";
    categories(vis.notes).forEach(function (cat) {
      var items = vis.notes.filter(function (n) { return n.category === cat; });
      if (q) items = items.filter(function (n) { return matches(n, q); });
      html += '<div class="nav-subgroup"><div class="nav-subgroup-title">' + esc(catLabel(cat)) + '<span class="nav-subgroup-count">' + items.length + "</span></div>";
      html += items.length ? items.sort(function (a, b) { return a.key < b.key ? -1 : 1; }).map(navItem).join("") : '<div class="nav-empty">' + (q ? "no matches" : "empty") + "</div>";
      html += "</div>";
    });
    html += "</div>";
    var nav = $("navScroll");
    var navTop = nav.scrollTop;
    nav.innerHTML = html;
    nav.scrollTop = navTop; // the sidebar stays where it was when it is rebuilt
  }

  /* ---------------- shared page pieces ---------------- */

  function setPage(html) { $("contentScroll").innerHTML = html; }

  function warningsHtml() {
    var bad = PROJECTS.filter(function (p) { return !p.ok; });
    return bad.map(function (p) { return '<div class="warn-box">⚠ <b>' + esc(p.title) + "</b> could not be loaded: " + esc(p.error) + "</div>"; }).join("");
  }

  function taskCard(t) {
    return '<a class="open-card" href="' + hTask(t) + '"><div class="row1">' + pill(t.status) + chip(t.project) +
      '<span class="id mono">' + esc(t.id) + '</span><span class="title">' + esc(t.title) + "</span></div>" +
      (t.note ? '<div class="desc">' + esc(t.note) + "</div>" : "") + "</a>";
  }

  function stageRow(g) {
    var done = g.tasks.filter(isDone).length, total = g.tasks.length;
    var pct = total ? Math.round((done / total) * 100) : 0;
    var badge = g.unassigned ? "" : (g.closed ? ' <span class="pill pill-done" style="margin-left:6px;">Complete</span>' : ' <span class="pill pill-backlog" style="margin-left:6px;">Ongoing</span>');
    return '<a class="stage-row" href="' + hStage(g.project, g.stage) + '"><div class="stage-name">' + esc(groupLabel(g)) + badge + "</div>" +
      '<div class="stage-bar"><span style="width:' + pct + '%;background:var(--st-done);"></span></div>' +
      '<div class="stage-count">' + done + " / " + total + " done</div></a>";
  }

  function notesByCategoryHtml(notes) {
    return categories(notes).map(function (cat) {
      var items = notes.filter(function (n) { return n.category === cat; });
      var lis = items.map(function (n) { return '<li><a href="' + hNote(n) + '">' + esc(n.title) + "</a> " + chip(n.project) + "</li>"; }).join("");
      return '<div class="cat-card"><div class="cat-name">' + esc(catLabel(cat)) + ' <span class="mono" style="color:var(--faint);font-weight:400;">(' + items.length + ")</span></div><ul>" + lis + "</ul></div>";
    }).join("");
  }

  function recentRow(it) {
    var kindPill = it.kind === "task" ? '<span class="pill pill-kind-task">Task</span>' : '<span class="pill pill-kind-note">Note</span>';
    var verb = it.created === it.updated ? "added" : "updated";
    return '<a class="open-card" href="' + hItem(it) + '"><div class="row1">' + kindPill + chip(it.project) +
      '<span class="id mono">' + esc(it.kind === "task" ? it.id : it.category) + '</span><span class="title">' + esc(it.title) + "</span>" +
      '<span class="when mono">' + verb + " " + esc(it.updated) + "</span></div></a>";
  }

  /* ---------------- views ---------------- */

  function setCrumb(html) { $("crumb").innerHTML = html; }
  function scopeLabel() { return selection === "all" ? "All projects" : projTitle(selection); }

  function renderOverview() {
    setCrumb(esc(scopeLabel()) + " <b>Overview</b>");
    var vis = visibleItems();
    var counts = {};
    STATUS_ORDER.forEach(function (s) { counts[s] = 0; });
    vis.tasks.forEach(function (t) { counts[statusKey(t.status)]++; });
    var tiles = [["progress", "in-progress", "In Progress"], ["testing", "testing", "Testing"], ["backlog", "backlog", "Backlog"], ["done", "done", "Done"], ["unstaged", "unstaged", "Unstaged"]]
      .map(function (x) { return '<div class="stat-tile acc-' + x[0] + '"><div class="n mono">' + counts[x[1]] + '</div><div class="l"><span class="status-swatch sw-' + x[1] + '"></span>' + x[2] + "</div></div>"; }).join("");
    var recent = vis.tasks.concat(vis.notes).sort(byUpdatedDesc).slice(0, 10);
    var groups = stageGroups(vis.tasks);
    var open = vis.tasks.filter(function (t) { return !isDone(t); }).sort(byIdAsc);
    setPage(
      warningsHtml() +
      '<div class="ov-lede">Tasks and working notes of <strong>' + esc(scopeLabel()) + "</strong>. Run <code class=\"mono\">node sync-manifests.mjs --all</code> after editing files, or move cards on the Dashboard.</div>" +
      '<div class="stat-row">' + tiles + "</div>" +
      '<div class="ov-section"><h2>Recent changes</h2><div class="open-list">' + (recent.length ? recent.map(recentRow).join("") : '<div class="state-msg" style="padding:8px 0;">Nothing yet.</div>') + "</div></div>" +
      '<div class="ov-section"><h2>Stages</h2><div class="stage-list">' + (groups.length ? groups.map(stageRow).join("") : '<div class="state-msg" style="padding:8px 0;">No tasks yet.</div>') + "</div></div>" +
      '<div class="ov-section"><h2>Open tasks (' + open.length + ')</h2><div class="open-list">' + (open.length ? open.map(taskCard).join("") : '<div class="state-msg" style="padding:8px 0;">Nothing outside Done.</div>') + "</div></div>" +
      '<div class="ov-section"><h2>Notes by category</h2><div class="cat-grid">' + notesByCategoryHtml(vis.notes) + "</div></div>"
    );
  }

  function renderDashboard() {
    setCrumb(esc(scopeLabel()) + " <b>Dashboard</b>");
    var vis = visibleItems();
    var tasks = vis.tasks.filter(function (t) { return !t.stage || ongoingAtLoad[t.project + "|" + t.stage]; });
    var cols = STATUS_ORDER.filter(function (s) { return s !== "unstaged" || tasks.some(function (t) { return statusKey(t.status) === "unstaged"; }); });
    var columns = cols.map(function (status) {
      var items = tasks.filter(function (t) { return statusKey(t.status) === status; }).sort(byIdAsc);
      var cards = items.length ? items.map(function (t) {
        return '<a class="kanban-card" draggable="true" data-key="' + esc(t.key) + '" href="' + hTask(t) + '"><span class="id mono">' + esc(t.id) + "</span>" +
          '<span class="title">' + esc(t.title) + "</span>" + (selection === "all" ? '<span class="id mono" style="margin:4px 0 0;">' + esc(projTitle(t.project)) + "</span>" : "") + "</a>";
      }).join("") : '<div class="kanban-empty">nothing here</div>';
      return '<div class="kanban-col kanban-' + status + '" data-status="' + status + '"><div class="kanban-head"><span class="status-swatch sw-' + status + '"></span>' + STATUS_LABEL[status] +
        '<span class="kanban-count mono">' + items.length + '</span></div><div class="kanban-cards">' + cards + "</div></div>";
    }).join("");
    setPage(
      warningsHtml() +
      '<div class="ov-lede">Tasks of the ongoing stages (and tasks without a stage). Closed stages have their own page in the sidebar.</div>' +
      '<div class="kanban-hint">Drag a card to another column to change its status. Cards cannot be dropped into Unstaged.</div>' +
      '<div class="kanban-board" style="--cols:' + cols.length + '">' + columns + "</div>"
    );
    wireDrag();
  }

  function renderAllTasks() {
    setCrumb(esc(scopeLabel()) + " <b>Tasks</b>");
    var vis = visibleItems();
    var groups = stageGroups(vis.tasks);
    var html = groups.map(function (g) {
      return '<div class="ov-section"><h2>' + esc(groupLabel(g)) + " (" + g.tasks.length + ")</h2>" +
        (g.unassigned ? "" : '<div class="stage-list" style="margin-bottom:10px;">' + stageRow(g) + "</div>") +
        '<div class="open-list">' + g.tasks.map(taskCard).join("") + "</div></div>";
    }).join("");
    setPage(warningsHtml() + '<div class="ov-lede">Every task (' + vis.tasks.length + " total), grouped by stage.</div>" + (html || '<div class="state-msg">No tasks yet.</div>'));
  }

  function renderAllNotes() {
    setCrumb(esc(scopeLabel()) + " <b>Notes</b>");
    var vis = visibleItems();
    setPage(warningsHtml() + '<div class="ov-lede">Every note (' + vis.notes.length + ' total).</div><div class="ov-section"><div class="cat-grid">' + notesByCategoryHtml(vis.notes) + "</div></div>");
  }

  function renderStage(pid, stage) {
    var tasks = DATA.tasks.filter(function (t) { return t.project === pid && (t.stage || "") === stage; });
    var g = stageGroups(tasks)[0];
    if (!g) { setCrumb("<b>Stage</b>"); setPage('<div class="state-msg">This stage has no tasks.</div>'); return; }
    setCrumb("Tasks / " + esc(projTitle(pid)) + " <b>" + esc(g.name) + "</b>");
    var notice = g.closed ? '<div class="notice">All tasks of this stage are done. Ask the AI to propose the CHANGELOG and README update for this stage.</div>' : "";
    setPage(notice + '<div class="ov-section"><div class="stage-list">' + stageRow(g) + '</div></div><div class="ov-section"><h2>Tasks (' + g.tasks.length + ')</h2><div class="open-list">' + g.tasks.map(taskCard).join("") + "</div></div>");
  }

  function renderDevlog() {
    setCrumb(esc(scopeLabel()) + " <b>Devlog</b>");
    if (selection === "all") {
      var ps = PROJECTS.filter(function (p) { return p.ok; });
      setPage('<div class="ov-lede">The devlog belongs to one project. Choose a project:</div><div class="open-list">' +
        ps.map(function (p) { return '<a class="open-card" href="#/p/' + enc(p.id) + '/devlog"><div class="row1"><span class="title">' + esc(p.title) + "</span></div></a>"; }).join("") + "</div>");
      return;
    }
    var pid = selection;
    setPage('<div class="md" id="mdBody"><div class="state-msg">Loading devlog.md…</div></div>');
    fetchText("/p/" + enc(pid) + "/devlog.md").then(function (text) {
      if (route.kind !== "list" || route.view !== "devlog" || selection !== pid) return;
      $("mdBody").innerHTML = renderMarkdown(text, "devlog.md", pid);
      applyPendingScroll();
    }).catch(function (err) {
      pendingScroll = null;
      if ($("mdBody")) $("mdBody").innerHTML = '<div class="state-msg">Could not load devlog.md (' + esc(err.message) + ").</div>";
    });
  }

  /* ---------------- markdown ---------------- */

  function stripFrontmatter(text) { return text.replace(/^\uFEFF/, "").replace(/^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/, ""); }

  function renderMarkdown(text, file, pid) {
    var html = marked.parse(stripFrontmatter(text));
    html = html.replace(/<table>/g, '<div class="table-wrap"><table>').replace(/<\/table>/g, "</table></div>");
    var dir = file.indexOf("/") >= 0 ? file.slice(0, file.lastIndexOf("/") + 1) : "";
    // A relative path in the note is resolved against the folder of the Markdown file ("." and ".." allowed).
    // It returns the path inside the project, or "" if it would leave the project.
    function resolveRel(rel) {
      var out = [];
      var ok = (dir + rel).split("/").every(function (s) {
        if (!s || s === ".") return true;
        if (s === "..") return out.pop() !== undefined;
        out.push(s);
        return true;
      });
      return ok ? out.join("/") : "";
    }
    function decode(s) { try { return decodeURIComponent(s); } catch (e) { return s; } }
    var isExternal = function (u) { return /^([a-z][a-z0-9+.-]*:|\/|#|data:)/i.test(u); };
    // Relative images are served from the project.
    html = html.replace(/<img([^>]*?) src="([^"]+)"/g, function (all, pre, src) {
      if (isExternal(src)) return all;
      var path = resolveRel(decode(src));
      if (!path) return all;
      return "<img" + pre + ' src="/p/' + enc(pid) + "/" + path.split("/").map(enc).join("/") + '"';
    });
    // Relative links: to a task or note of the board -> the board page; to another file of the project -> the file.
    return html.replace(/<a href="([^"]+)"/g, function (all, href) {
      if (isExternal(href)) return all;
      var path = resolveRel(decode(href.split("#")[0]));
      if (!path) return all;
      var item = byFile[pid + "/" + path];
      if (item) return '<a href="' + (item.kind === "task" ? hTask(item) : hNote(item)) + '"';
      return '<a target="_blank" rel="noopener" href="/p/' + enc(pid) + "/" + path.split("/").map(enc).join("/") + '"';
    });
  }

  function loadBody(item) {
    var mine = activeKey();
    fetchText("/p/" + enc(item.project) + "/" + item.file.split("/").map(enc).join("/")).then(function (text) {
      if (activeKey() !== mine) return;
      $("mdBody").innerHTML = renderMarkdown(text, item.file, item.project);
      applyPendingScroll();
    }).catch(function (err) {
      if (activeKey() !== mine) return;
      pendingScroll = null;
      $("mdBody").innerHTML = '<div class="state-msg">Could not load this file (' + esc(err.message) + ").</div>";
    });
  }

  /* ---------------- task and note pages ---------------- */

  function relChip(ref) {
    var t = byKey[ref];
    if (t && t.kind === "task") {
      return '<a class="rel-chip" href="' + hTask(t) + '"><span class="pill pill-project">' + esc(projTitle(t.project)) + '</span><span class="id mono">' + esc(t.id) + '</span><span class="rel-title">' + esc(t.title) + "</span>" + pill(t.status) + "</a>";
    }
    return '<span class="rel-chip rel-warn" title="Reference cannot be resolved">⚠ ' + esc(ref) + " (not found)</span>";
  }

  function renderTask(t) {
    if (!t) { setCrumb("<b>Task</b>"); setPage('<div class="state-msg">This task is not in the manifests. Try Refresh.</div>'); return; }
    setCrumb("Tasks / " + esc(projTitle(t.project)) + " <b>" + esc(t.id) + "</b>");
    var opts = MOVE_TARGETS.map(function (s) { return '<option value="' + s + '"' + (t.status === s ? " selected" : "") + ">" + STATUS_LABEL[s] + "</option>"; }).join("");
    if (t.status === "unstaged") opts = '<option value="unstaged" selected disabled>Unstaged</option>' + opts;
    var sourceKey = t.source ? t.project + "/" + t.source : "";
    var source = sourceKey && byKey[sourceKey] ? '<span>source <a href="' + hNote(byKey[sourceKey]) + '">' + esc(t.source) + "</a></span>" : (t.source ? "<span>source " + esc(t.source) + "</span>" : "");
    var rel = (t.related || []).map(relChip).join(""), relBy = (t.relatedBy || []).map(relChip).join("");
    setPage(
      '<div class="doc-header"><div class="doc-badges">' + pill(t.status) + '<span class="pill pill-project">' + esc(projTitle(t.project)) + "</span>" +
      '<span class="pill pill-stage">' + esc(t.stage || "Unassigned") + '</span><span class="pill pill-stage mono">' + esc(t.id) + "</span></div>" +
      '<div class="doc-title">' + esc(t.title) + "</div>" +
      '<div class="doc-meta"><span>created ' + esc(t.created) + "</span><span>updated " + esc(t.updated) + "</span>" + source + "</div>" +
      (t.note ? '<div class="doc-meta"><span>note: ' + esc(t.note) + "</span></div>" : "") +
      '<div class="status-line">Status <select class="status-select" id="statusSelect">' + opts + "</select><span>changes the <code class=\"mono\">status:</code> line in the task file</span></div>" +
      (rel ? '<div class="doc-h">Related</div><div class="rel-list">' + rel + "</div>" : "") +
      (relBy ? '<div class="doc-h">Related by</div><div class="rel-list">' + relBy + "</div>" : "") +
      '</div><div class="md" id="mdBody"><div class="state-msg">Loading ' + esc(t.file) + "…</div></div>"
    );
    $("statusSelect").addEventListener("change", function (e) {
      var to = e.target.value;
      moveTask(t, to).then(function (ok) { if (!ok) renderKeep(); });
    });
    loadBody(t);
  }

  function renderNote(n) {
    if (!n) { setCrumb("<b>Note</b>"); setPage('<div class="state-msg">This note is not in the manifests. Try Refresh.</div>'); return; }
    setCrumb("Notes / " + esc(catLabel(n.category)) + " <b>" + esc(n.title) + "</b>");
    setPage(
      '<div class="doc-header"><div class="doc-badges"><span class="pill pill-project">' + esc(projTitle(n.project)) + '</span><span class="pill pill-stage">' + esc(catLabel(n.category)) + "</span>" +
      (n.archive ? '<span class="pill pill-stage" title="Title and dates were not recorded for this note">Archive ' + esc(n.archive) + "</span>" : "") + "</div>" +
      '<div class="doc-title">' + esc(n.title) + '</div><div class="doc-meta"><span>created ' + esc(n.created) + "</span><span>updated " + esc(n.updated) + "</span><span>" + esc(n.file) + "</span></div></div>" +
      '<div class="md" id="mdBody"><div class="state-msg">Loading ' + esc(n.file) + "…</div></div>"
    );
    loadBody(n);
  }

  /* ---------------- moving a task (the only write) ---------------- */

  function getToken(force) {
    if (sessionToken && !force) return Promise.resolve(sessionToken);
    return fetchJson("/api/session").then(function (j) { sessionToken = j.token; return sessionToken; });
  }

  function postMove(t, from, to, token) {
    return fetch("/api/task-status", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Hub-Token": token },
      body: JSON.stringify({ project: t.project, id: t.id, from: from, to: to })
    }).then(function (r) { return r.json().catch(function () { return {}; }).then(function (b) { return { code: r.status, body: b }; }); });
  }

  // Resolves true if the move was saved.
  function moveTask(t, to) {
    if (t && byKey[t.key]) t = byKey[t.key]; // the manifests may have been reloaded since the page was drawn
    if (!t || t.status === to) return Promise.resolve(true);
    if (MOVE_TARGETS.indexOf(to) < 0) { toast("A task cannot be moved into " + STATUS_LABEL[to] + ".", true); return Promise.resolve(false); }
    var from = t.status;
    return getToken(false).then(function (tok) {
      return postMove(t, from, to, tok).then(function (res) {
        if (res.code === 403) { return getToken(true).then(function (tok2) { return postMove(t, from, to, tok2); }); }
        return res;
      });
    }).then(function (res) {
      if (res.code === 200 && res.body.task) {
        var nt = res.body.task;
        ["status", "updated", "note", "title", "stage"].forEach(function (f) { t[f] = nt[f]; });
        toast("Moved " + t.id + " to " + STATUS_LABEL[statusKey(t.status)] + (res.body.stageComplete ? ". Stage \"" + t.stage + "\" is complete: ask the AI to propose the CHANGELOG and README update." : "."), false);
        renderKeep();
        return true;
      }
      toast((res.body && res.body.error) || ("Move failed (HTTP " + res.code + ")"), true);
      if (res.code === 409) { return loadAll().then(renderKeep).then(function () { return false; }); }
      return false;
    }).catch(function (e) { toast("Move failed: " + e.message, true); return false; });
  }

  function wireDrag() {
    var cards = document.querySelectorAll(".kanban-card");
    Array.prototype.forEach.call(cards, function (c) {
      c.addEventListener("dragstart", function (e) {
        dragKey = c.getAttribute("data-key");
        c.classList.add("dragging");
        try { e.dataTransfer.setData("text/plain", dragKey); e.dataTransfer.effectAllowed = "move"; } catch (x) { /* ignore */ }
      });
      c.addEventListener("dragend", function () {
        c.classList.remove("dragging");
        Array.prototype.forEach.call(document.querySelectorAll(".kanban-col"), function (k) { k.classList.remove("drop-ok"); });
      });
    });
    Array.prototype.forEach.call(document.querySelectorAll(".kanban-col"), function (col) {
      var status = col.getAttribute("data-status");
      var allowed = MOVE_TARGETS.indexOf(status) >= 0;
      col.addEventListener("dragover", function (e) {
        if (!allowed || !dragKey) return;
        var t = byKey[dragKey];
        if (!t || t.status === status) return;
        e.preventDefault();
        col.classList.add("drop-ok");
      });
      col.addEventListener("dragleave", function () { col.classList.remove("drop-ok"); });
      col.addEventListener("drop", function (e) {
        col.classList.remove("drop-ok");
        if (!allowed) return;
        e.preventDefault();
        var key = dragKey; dragKey = null;
        var t = key && byKey[key];
        if (t) moveTask(t, status);
      });
    });
  }

  /* ---------------- chrome ---------------- */

  function closeMobileNav() { $("sidebar").classList.remove("open"); $("backdrop").classList.remove("open"); }
  $("menuToggle").addEventListener("click", function () { $("sidebar").classList.toggle("open"); $("backdrop").classList.toggle("open"); });
  $("backdrop").addEventListener("click", closeMobileNav);
  $("navScroll").addEventListener("click", function (e) { if (e.target.closest && e.target.closest("a")) closeMobileNav(); });
  $("searchBox").addEventListener("input", function (e) { buildSidebar(e.target.value); });

  /* ---------------- theme ---------------- */
  // Two states: "light" and "dark". Until the user has chosen one (nothing saved, for example on the first visit),
  // the board shows the theme of the system or browser setting. The first click saves an explicit choice.
  // The inline script in index.html has already applied a saved choice before the first paint.

  var THEME_KEY = "hub.theme";
  var THEME = { light: "light", dark: "dark" };
  var themeChoice = null;       // "light", "dark", or null while the user has not chosen

  function capitalThemeName(themeName) { // return string
    return themeName.charAt(0).toUpperCase().concat(themeName.substring(1));
  }
  function readThemeChoice() {
    try { var t = localStorage.getItem(THEME_KEY); return t === THEME.light || t === THEME.dark ? t : null; }
    catch (e) { return null; }
  }
  function saveThemeChoice(choice) {
    try { localStorage.setItem(THEME_KEY, choice); }
    catch (e) { /* blocked: the choice lasts until the page is reloaded */ }
  }
  function systemTheme() {
    return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? THEME.dark : THEME.light;
  }
  function currentTheme() { return themeChoice || systemTheme(); }
  function showTheme() {
    var root = document.documentElement;
    // No attribute while nothing is chosen: the CSS then follows the system setting by itself.
    if (themeChoice) root.setAttribute("data-theme", themeChoice); else root.removeAttribute("data-theme");
    var themeNow = currentTheme();
    var themeChange = themeNow === THEME.dark ? THEME.light : THEME.dark;
    var label = "Theme: " + capitalThemeName(themeNow) + ". Click for " + capitalThemeName(themeChange) + ".";
    var btn = $("themeToggle");
    btn.setAttribute("data-mode", themeNow);
    btn.setAttribute("aria-label", label);
    btn.title = label;
  }
  $("themeToggle").addEventListener("click", function () {
    themeChoice = currentTheme() === THEME.dark ? THEME.light : THEME.dark;
    saveThemeChoice(themeChoice);
    showTheme();
  });
  if (window.matchMedia) {
    var systemQuery = window.matchMedia("(prefers-color-scheme: dark)");
    var onSystemChange = function () { if (!themeChoice) showTheme(); };
    if (systemQuery.addEventListener) systemQuery.addEventListener("change", onSystemChange);
    else if (systemQuery.addListener) systemQuery.addListener(onSystemChange);
  }
  themeChoice = readThemeChoice();
  showTheme();
  // Reload the manifests. The page is drawn again only when something changed, and then at the same scroll position.
  // So switching to another tab or window and back never moves the page.
  var refreshing = false;
  function refresh(manual) {
    if (refreshing) return Promise.resolve();
    refreshing = true;
    var before = JSON.stringify(PROJECTS);
    return loadAll().then(function () {
      if (JSON.stringify(PROJECTS) !== before) renderKeep();
      else if (manual === true) toast("The board is up to date.", false);
    }).catch(function (err) {
      toast("Could not refresh the board: " + (err && err.message ? err.message : err) + ". The page stays as it is.", true);
    }).then(function () { refreshing = false; });
  }
  $("refreshBtn").addEventListener("click", function () { refresh(true); });
  window.addEventListener("focus", function () { if (DATA && Date.now() - lastRefresh > 5000) refresh(false); });
  window.addEventListener("hashchange", function () { render(); });

  function showFatal(err) {
    $("contentScroll").innerHTML = '<div class="state-msg">Could not load the board (' + esc(err.message || err) + "). Start the hub with <code class=\"mono\">node serve.mjs</code> and open the printed address. See README.md.</div>";
  }

  loadAll().then(function () {
    var hasRoute = location.hash && location.hash.length > 2;
    if (!hasRoute) restoreSelection();
    else if (parseHash().kind !== "list") restoreSelection();
    if (!hasRoute && selection !== "all") location.replace(hView("overview"));
    else render();
  }).catch(showFatal);
})();
