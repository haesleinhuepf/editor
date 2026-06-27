const state = {
  docs: [],
  currentTab: -1,
  autoSave: true,
  autoSaveDelayMs: 800,
  settings: {
    server: "http://localhost:11434/v1",
    api_key: "",
    model: "gemma4:12b",
  },
  promptTask: {
    id: 0,
    active: false,
    label: "Idle",
    controller: null,
  },
};

function splitSections(text) {
  const normalized = text.replace(/\r\n/g, "\n");
  if (!normalized.trim()) return [""];
  return normalized
    .split(/\n\s*\n+/)
    .map((section) => section.trim())
    .filter((section) => section.length > 0);
}

function joinSections(sections) {
  return sections.map((s) => s.replace(/\s+$/g, "")).join("\n\n") + "\n";
}

function headingForSection(text) {
  const lines = text.split("\n");
  for (const line of lines) {
    const m = line.trim().match(/^(#{1,6})\s+(.+)$/);
    if (m) return { title: m[2].trim(), level: m[1].length };
  }
  const first = lines.find((x) => x.trim());
  return { title: first ? first.slice(0, 60) : "(empty)", level: 1 };
}

function currentDoc() {
  return state.docs[state.currentTab] || null;
}

function beginSectionEdit(doc, idx) {
  doc.editingSection = {
    index: idx,
    original: doc.sections[idx] || "",
    wasDirty: doc.dirty,
  };
}

function commitSectionEdit(doc) {
  doc.editingSection = null;
  renderAll();
}

function cancelSectionEdit(doc) {
  const editing = doc.editingSection;
  if (!editing) return;
  doc.sections[editing.index] = editing.original;
  doc.dirty = editing.wasDirty;
  if (doc.autoSaveTimer) {
    clearTimeout(doc.autoSaveTimer);
    doc.autoSaveTimer = null;
  }
  if (doc.dirty) scheduleAutoSave(doc);
  doc.editingSection = null;
  renderAll();
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(body.detail || res.statusText);
  }
  return res.json();
}

function updatePromptStatus() {
  const hourglass = document.getElementById("prompt-hourglass");
  const cancelBtn = document.getElementById("prompt-cancel");
  const label = document.getElementById("prompt-label");
  if (!hourglass || !cancelBtn || !label) return;

  const active = state.promptTask.active;
  hourglass.hidden = !active;
  cancelBtn.hidden = !active;
  label.textContent = state.promptTask.label;
}

function cancelPromptTask() {
  if (!state.promptTask.active || !state.promptTask.controller) return;
  state.promptTask.controller.abort();
}

function beginPromptTask(label) {
  if (state.promptTask.active) {
    throw new Error("Another prompt is already running. Cancel it or wait for completion.");
  }
  const controller = new AbortController();
  const taskId = state.promptTask.id + 1;
  state.promptTask = {
    id: taskId,
    active: true,
    label,
    controller,
  };
  updatePromptStatus();
  return { taskId, signal: controller.signal };
}

function endPromptTask(taskId) {
  if (state.promptTask.id !== taskId) return;
  state.promptTask = {
    id: taskId,
    active: false,
    label: "Idle",
    controller: null,
  };
  updatePromptStatus();
}

function ensurePromptNotCancelled(signal) {
  if (signal.aborted) throw new DOMException("Prompt cancelled", "AbortError");
}

function isDocOpen(doc) {
  return state.docs.includes(doc);
}

function runPromptTask(label, worker) {
  let task;
  try {
    task = beginPromptTask(label);
  } catch (err) {
    alert(err.message);
    return;
  }

  worker(task.signal)
    .catch((err) => {
      if (err && err.name === "AbortError") return;
      alert(err?.message || String(err));
    })
    .finally(() => endPromptTask(task.taskId));
}

function addDoc(path, content) {
  const name = path ? path.split(/[\\/]/).pop() : "Untitled";
  state.docs.push({
    path: path || null,
    name,
    dirty: false,
    sections: splitSections(content || ""),
    activeSection: 0,
    editingSection: null,
    selectedText: "",
  });
  state.currentTab = state.docs.length - 1;
  renderAll();
}

function markDirty(doc, val = true) {
  doc.dirty = val;
  if (!val) {
    if (doc.autoSaveTimer) {
      clearTimeout(doc.autoSaveTimer);
      doc.autoSaveTimer = null;
    }
  } else {
    scheduleAutoSave(doc);
  }
  renderTabs();
}

function scheduleAutoSave(doc) {
  if (!state.autoSave || !doc || !doc.dirty || !doc.path) return;
  if (doc.autoSaveTimer) clearTimeout(doc.autoSaveTimer);
  doc.autoSaveTimer = setTimeout(() => {
    doc.autoSaveTimer = null;
    void saveDoc(doc, { silent: true });
  }, state.autoSaveDelayMs);
}

function toggleAutoSave() {
  state.autoSave = !state.autoSave;
  if (state.autoSave) {
    state.docs.forEach((doc) => {
      if (doc.dirty) scheduleAutoSave(doc);
    });
  } else {
    state.docs.forEach((doc) => {
      if (doc.autoSaveTimer) {
        clearTimeout(doc.autoSaveTimer);
        doc.autoSaveTimer = null;
      }
    });
  }
  renderMenusAndToolbar();
}

function renderMenusAndToolbar() {
  const actions = {
    newFile,
    openFile,
    saveFile,
    saveFileAs,
    closeFile,
    cutText,
    copyText,
    pasteText,
    promptCurrentSection,
    promptWholeDocument,
    promptInsertAfterCurrent,
    configurePrompt,
    toggleAutoSave,
  };

  const fileMenu = [
    ["✨ New", actions.newFile],
    ["📂 Open", actions.openFile],
    ["💾 Save", actions.saveFile],
    ["📝 Save As", actions.saveFileAs],
    [`${state.autoSave ? "☑" : "☐"} Auto-Save`, actions.toggleAutoSave],
    ["❎ Close", actions.closeFile],
  ];
  const editMenu = [
    ["✂️ Cut", actions.cutText],
    ["📋 Copy", actions.copyText],
    ["📥 Paste", actions.pasteText],
  ];
  const promptMenu = [
    ["🤖 Prompt Current Section", actions.promptCurrentSection],
    ["📄 Prompt Entire Document", actions.promptWholeDocument],
    ["➕ Prompt Insert Section", actions.promptInsertAfterCurrent],
    ["Configure Prompt ⚙️", actions.configurePrompt],
  ];

  fillMenu(document.getElementById("menu-file"), fileMenu);
  fillMenu(document.getElementById("menu-edit"), editMenu);
  fillMenu(document.getElementById("menu-prompt"), promptMenu);

  const toolbar = document.getElementById("toolbar");
  toolbar.innerHTML = "";
  [
    ["✨", actions.newFile],
    ["📂", actions.openFile],
    ["💾", actions.saveFile],
    ["❎", actions.closeFile],
    ["|", null],
    ["✂️", actions.cutText],
    ["📋", actions.copyText],
    ["📥", actions.pasteText],
    ["|", null],
    ["📄🤖", actions.promptWholeDocument],
  ].forEach(([label, fn]) => {
    if (label === "|") {
      const sep = document.createElement("span");
      sep.textContent = "|";
      sep.style.color = "#8491aa";
      toolbar.appendChild(sep);
      return;
    }
    const b = document.createElement("button");
    b.textContent = label;
    b.onclick = fn;
    toolbar.appendChild(b);
  });
}

function fillMenu(el, items) {
  el.innerHTML = "";
  items.forEach(([label, fn]) => {
    const b = document.createElement("button");
    b.textContent = label;
    b.onclick = () => {
      fn();
      document.querySelectorAll("details.menu").forEach((d) => d.removeAttribute("open"));
    };
    el.appendChild(b);
  });
}

function renderTabs() {
  const strip = document.getElementById("tab-strip");
  strip.innerHTML = "";
  state.docs.forEach((doc, i) => {
    const t = document.createElement("div");
    t.className = `tab ${i === state.currentTab ? "active" : ""}`;
    t.textContent = doc.name + (doc.dirty ? " *" : "");
    t.onclick = () => {
      state.currentTab = i;
      renderAll();
    };
    strip.appendChild(t);
  });
}

function renderOutline() {
  const outline = document.getElementById("outline");
  outline.innerHTML = "";
  const doc = currentDoc();
  if (!doc) return;
  doc.sections.forEach((section, idx) => {
    const item = document.createElement("div");
    const heading = headingForSection(section);
    item.className = `outline-item ${idx === doc.activeSection ? "active" : ""}`;
    item.style.paddingLeft = `${8 + (heading.level - 1) * 14}px`;
    item.textContent = `${idx + 1}. ${heading.title}`;
    item.onclick = () => {
      doc.activeSection = idx;
      document.getElementById(`section-${idx}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
      renderOutline();
    };
    outline.appendChild(item);
  });
}

function createInsertRow(position) {
  const row = document.createElement("div");
  row.className = "insert-row";

  const insert = document.createElement("button");
  insert.textContent = "➕";
  insert.onclick = () => {
    const doc = currentDoc();
    if (!doc) return;
    doc.sections.splice(position, 0, "");
    doc.activeSection = position;
    markDirty(doc);
    renderAll();
  };

  const promptBtn = document.createElement("button");
  promptBtn.textContent = "🤖";
  promptBtn.onclick = () => promptInsertAt(position);

  row.append(insert, promptBtn);
  return row;
}

async function renderSection(sectionText, sourcePath) {
  const data = await api("/api/markdown/render", {
    method: "POST",
    body: JSON.stringify({ text: sectionText, source_path: sourcePath || null }),
  });
  return data.html;
}

function renderSections() {
  const target = document.getElementById("sections");
  target.innerHTML = "";
  const doc = currentDoc();
  if (!doc) return;

  target.appendChild(createInsertRow(0));

  doc.sections.forEach((section, idx) => {
    const row = document.createElement("div");
    row.className = "section-row";
    row.id = `section-${idx}`;

    const card = document.createElement("div");
    card.className = "section-card";

    if (doc.editingSection?.index === idx) {
      card.classList.add("editing");
      const ta = document.createElement("textarea");
      ta.value = section;
      ta.oninput = () => {
        doc.sections[idx] = ta.value;
        markDirty(doc);
      };
      ta.onkeydown = (evt) => {
        const isCommit = evt.key === "Enter" && (evt.shiftKey || evt.ctrlKey);
        const isCancel = evt.key === "Escape" && (evt.shiftKey || evt.ctrlKey);
        if (!isCommit && !isCancel) return;

        evt.preventDefault();
        evt.stopPropagation();
        if (isCommit) commitSectionEdit(doc);
        else cancelSectionEdit(doc);
      };
      ta.onblur = () => {
        if (doc.editingSection?.index === idx) commitSectionEdit(doc);
      };
      ta.onfocus = () => {
        doc.activeSection = idx;
        renderOutline();
      };
      card.appendChild(ta);
      setTimeout(() => ta.focus(), 0);
    } else {
      card.classList.add("rendered");
      card.ondblclick = () => {
        beginSectionEdit(doc, idx);
        doc.activeSection = idx;
        renderAll();
      };
      card.onclick = () => {
        doc.activeSection = idx;
        const sel = window.getSelection();
        doc.selectedText = sel ? String(sel) : "";
        renderOutline();
      };
      renderSection(section, doc.path)
        .then((html) => {
          card.innerHTML = `<div class=\"md-render\">${html}</div>`;
        })
        .catch((err) => {
          card.textContent = `Render error: ${err.message}`;
        });
    }

    const controls = document.createElement("div");
    controls.className = "section-controls";
    controls.append(
      mkButton("⬆️", () => moveUp(idx), "section-action"),
      mkButton("⬇️", () => moveDown(idx), "section-action"),
      mkButton("🤖", () => promptSectionAt(idx), "section-action"),
      mkButton("🗑️", () => removeSection(idx), "section-action danger")
    );

    row.append(card, controls);
    target.appendChild(row);
    target.appendChild(createInsertRow(idx + 1));
  });
}

function mkButton(label, fn, cls = "") {
  const b = document.createElement("button");
  b.textContent = label;
  b.onclick = fn;
  if (cls) b.classList.add(...cls.split(/\s+/).filter(Boolean));
  return b;
}

function moveUp(idx) {
  const doc = currentDoc();
  if (!doc || idx <= 0) return;
  [doc.sections[idx - 1], doc.sections[idx]] = [doc.sections[idx], doc.sections[idx - 1]];
  doc.activeSection = idx - 1;
  markDirty(doc);
  renderAll();
}

function moveDown(idx) {
  const doc = currentDoc();
  if (!doc || idx >= doc.sections.length - 1) return;
  [doc.sections[idx + 1], doc.sections[idx]] = [doc.sections[idx], doc.sections[idx + 1]];
  doc.activeSection = idx + 1;
  markDirty(doc);
  renderAll();
}

function removeSection(idx) {
  const doc = currentDoc();
  if (!doc) return;
  if (doc.sections.length === 1) doc.sections[0] = "";
  else doc.sections.splice(idx, 1);
  doc.activeSection = Math.max(0, Math.min(doc.activeSection, doc.sections.length - 1));
  markDirty(doc);
  renderAll();
}

async function askPrompt(title) {
  const dlg = document.getElementById("prompt-dialog");
  document.getElementById("prompt-title").textContent = title;
  const ta = document.getElementById("prompt-text");
  ta.value = "";

  ta.onkeydown = (evt) => {
    const isSubmit = evt.key === "Enter" && (evt.shiftKey || evt.ctrlKey);
    const isCancel = evt.key === "Escape" && (evt.shiftKey || evt.ctrlKey);
    if (!isSubmit && !isCancel) return;

    evt.preventDefault();
    evt.stopPropagation();
    dlg.close(isSubmit ? "ok" : "cancel");
  };

  dlg.showModal();
  const result = await new Promise((resolve) => {
    dlg.addEventListener("close", () => resolve(dlg.returnValue), { once: true });
  });
  const prompt = ta.value.trim();
  return result === "ok" && prompt ? prompt : null;
}

function renderDiffLines(container, rawLines) {
  container.innerHTML = "";
  const lines = Array.isArray(rawLines) ? rawLines : [];

  if (lines.length === 0) {
    const empty = document.createElement("div");
    empty.className = "diff-line diff-context";
    empty.textContent = "  (No changes)";
    container.appendChild(empty);
    return;
  }

  lines.forEach((entry) => {
    const kind = entry?.kind === "add" || entry?.kind === "remove" ? entry.kind : "context";
    const text = String(entry?.text ?? "");
    const line = document.createElement("div");
    line.className = `diff-line diff-${kind}`;
    line.textContent = `${kind === "add" ? "+" : kind === "remove" ? "-" : " "} ${text}`;
    container.appendChild(line);
  });
}

async function showDiff(original, proposed) {
  const diff = await api("/api/diff", {
    method: "POST",
    body: JSON.stringify({ original, proposed }),
  });
  const dlg = document.getElementById("diff-dialog");
  renderDiffLines(document.getElementById("diff-view"), diff.lines);
  const resultField = document.getElementById("diff-result");
  resultField.value = proposed;

  dlg.showModal();
  const result = await new Promise((resolve) => {
    dlg.addEventListener("close", () => resolve(dlg.returnValue), { once: true });
  });

  if (result === "undo") return original;
  if (result === "accept" || result === "edited") return resultField.value;
  return null;
}

async function promptSectionAt(idx) {
  const doc = currentDoc();
  if (!doc) return;
  doc.activeSection = idx;
  const selected = (doc.selectedText || "").trim();
  const source = selected || doc.sections[idx] || "";
  const prompt = await askPrompt("Prompt Current Section");
  if (!prompt) return;

  runPromptTask("Prompting section", async (signal) => {
    const payload = await api("/api/prompt/edit", {
      method: "POST",
      body: JSON.stringify({ prompt, source }),
      signal,
    });
    ensurePromptNotCancelled(signal);
    if (!isDocOpen(doc)) return;

    const result = String(payload?.result || "");
    if (!result) return;
    const applied = await showDiff(source, result);
    if (applied == null) return;
    ensurePromptNotCancelled(signal);
    if (!isDocOpen(doc)) return;

    if (selected && doc.sections[idx].includes(selected)) doc.sections[idx] = doc.sections[idx].replace(selected, applied);
    else doc.sections[idx] = applied;
    doc.selectedText = "";
    markDirty(doc);
    renderAll();
  });
}

async function promptInsertAt(position) {
  const doc = currentDoc();
  if (!doc) return;
  const prompt = await askPrompt("Prompt Insert Sections");
  if (!prompt) return;

  runPromptTask("Generating section", async (signal) => {
    const payload = await api("/api/prompt/insert", {
      method: "POST",
      body: JSON.stringify({ prompt, source: "" }),
      signal,
    });
    ensurePromptNotCancelled(signal);
    if (!isDocOpen(doc)) return;

    const result = String(payload?.result || "");
    if (!result) return;
    const chunks = result
      .split("<!-- section -->")
      .map((x) => x.trim())
      .filter(Boolean);

    (chunks.length ? chunks : [result.trim()]).forEach((chunk, i) => {
      doc.sections.splice(position + i, 0, chunk);
    });
    doc.activeSection = position;
    markDirty(doc);
    renderAll();
  });
}

async function configurePrompt() {
  const dlg = document.getElementById("settings-dialog");
  document.getElementById("cfg-server").value = state.settings.server;
  document.getElementById("cfg-key").value = state.settings.api_key;
  document.getElementById("cfg-model").value = state.settings.model;

  dlg.showModal();
  const result = await new Promise((resolve) => {
    dlg.addEventListener("close", () => resolve(dlg.returnValue), { once: true });
  });
  if (result !== "ok") return;

  state.settings.server = document.getElementById("cfg-server").value.trim();
  state.settings.api_key = document.getElementById("cfg-key").value.trim();
  state.settings.model = document.getElementById("cfg-model").value.trim();

  await api("/api/settings", {
    method: "POST",
    body: JSON.stringify(state.settings),
  }).catch((err) => alert(err.message));
}

function cutText() { document.execCommand("cut"); }
function copyText() { document.execCommand("copy"); }
function pasteText() { document.execCommand("paste"); }

function newFile() {
  addDoc(null, "");
}

async function openFile() {
  const path = window.prompt("Open file path (absolute or relative to server working directory):");
  if (!path) return;
  const data = await api(`/api/file/load?path=${encodeURIComponent(path)}`).catch((err) => {
    alert(err.message);
    return null;
  });
  if (!data) return;
  addDoc(data.path, data.content);
}

async function saveFile() {
  const doc = currentDoc();
  if (!doc) return;
  if (!doc.path) return saveFileAs();

  await saveDoc(doc, { silent: false });
}

async function saveDoc(doc, { pathOverride = null, silent = false } = {}) {
  const targetPath = pathOverride || doc.path;
  if (!targetPath) return false;

  await api("/api/file/save", {
    method: "POST",
    body: JSON.stringify({ path: targetPath, content: joinSections(doc.sections) }),
  }).catch((err) => {
    if (!silent) alert(err.message);
    throw err;
  });

  markDirty(doc, false);
  return true;
}

async function saveFileAs() {
  const doc = currentDoc();
  if (!doc) return;
  const path = window.prompt("Save file as path:", doc.path || "untitled.md");
  if (!path) return;
  try {
    await saveDoc(doc, { pathOverride: path, silent: false });
  } catch {
    return;
  }
  doc.path = path;
  doc.name = path.split(/[\\/]/).pop();
  renderTabs();
}

function closeFile() {
  if (state.currentTab < 0) return;
  const doc = currentDoc();
  if (doc && doc.dirty && !window.confirm(`Discard unsaved changes in ${doc.name}?`)) return;
  state.docs.splice(state.currentTab, 1);
  if (state.docs.length === 0) addDoc(null, "");
  else {
    state.currentTab = Math.max(0, Math.min(state.currentTab, state.docs.length - 1));
    renderAll();
  }
}

function promptCurrentSection() {
  const doc = currentDoc();
  if (!doc) return;
  void promptSectionAt(doc.activeSection);
}

function promptInsertAfterCurrent() {
  const doc = currentDoc();
  if (!doc) return;
  void promptInsertAt(doc.activeSection + 1);
}

async function promptWholeDocument() {
  const doc = currentDoc();
  if (!doc) return;

  const prompt = await askPrompt("Prompt Entire Document");
  if (!prompt) return;

  const sourceDocument = joinSections(doc.sections);
  runPromptTask("Prompting document", async (signal) => {
    const response = await api("/api/prompt/document", {
      method: "POST",
      body: JSON.stringify({
        prompt,
        document: sourceDocument,
        sections: doc.sections,
      }),
      signal,
    });
    ensurePromptNotCancelled(signal);
    if (!isDocOpen(doc)) return;

    let proposedDocument = null;
    if (response.action === "rewrite") {
      proposedDocument = String(response.document || "");
    } else if (response.action === "replace_sections") {
      const replacements = Array.isArray(response.replacements) ? response.replacements : [];
      const nextSections = [...doc.sections];

      replacements.forEach((item) => {
        const sectionNumber = Math.trunc(Number(item?.section_number));
        if (!Number.isFinite(sectionNumber)) return;
        const idx = sectionNumber - 1;
        if (idx < 0 || idx >= nextSections.length) return;
        nextSections[idx] = String(item?.content ?? "");
      });
      proposedDocument = joinSections(nextSections);
    } else {
      throw new Error("Prompt response action is not supported.");
    }

    const applied = await showDiff(sourceDocument, proposedDocument);
    if (applied == null) return;
    ensurePromptNotCancelled(signal);
    if (!isDocOpen(doc)) return;

    doc.sections = splitSections(applied);
    doc.activeSection = Math.min(doc.activeSection, Math.max(doc.sections.length - 1, 0));
    doc.selectedText = "";
    markDirty(doc);
    renderAll();
  });
}

function renderAll() {
  renderTabs();
  renderOutline();
  renderSections();
}

async function bootstrap() {
  renderMenusAndToolbar();
  updatePromptStatus();
  document.getElementById("prompt-cancel").onclick = cancelPromptTask;

  state.settings = await api("/api/settings").catch(() => state.settings);

  const initial = await api("/api/initial-file").catch(() => ({ path: null, content: "" }));
  addDoc(initial.path, initial.content);

  window.addEventListener("beforeunload", (evt) => {
    if (state.docs.some((d) => d.dirty)) {
      evt.preventDefault();
      evt.returnValue = "";
    }
  });
}

bootstrap();
