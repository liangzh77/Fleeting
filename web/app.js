// Fleeting 前端（由原 TypeScript 源转换为可直接部署的原生 JS，避免 Node 构建链）。
var app = document.querySelector("#app");
var status = document.querySelector("#status");
var nav = document.querySelector("#nav");
var dialog = document.querySelector("#dialog");
var dialogContent = document.querySelector("#dialogContent");
var apiBase = new URL(".", location.href).pathname.replace(/\/+$/, "");
var session;
var view = "journal";
var selectedDay = "";
var selectedMonth = "";
var epoch = 0;
var consent = false;
var composing = "";
var key = crypto.randomUUID();
var saving = false;
var generating = /* @__PURE__ */ new Set();
var pendingText = null;
var authEpoch = 0;
var authenticated = false;
var inflight = /* @__PURE__ */ new Set();
var entryCache = /* @__PURE__ */ new Map();
var refreshReport = null;
var reportScope = 0;
var reportRequest = 0;
var reportTimer = null;
function invalidateReport() {
  reportScope++;
  if (reportTimer !== null) clearTimeout(reportTimer);
  reportTimer = null;
  refreshReport = null;
}
function lockNavigation(locked) {
  nav.querySelectorAll("button").forEach((b) => {
    b.disabled = locked;
  });
}
function el(tag, text = "", cls = "") {
  const x = document.createElement(tag);
  x.textContent = text;
  if (cls) x.className = cls;
  return x;
}
function button(text, action, cls = "") {
  const b = el("button", text, cls);
  b.type = "button";
  b.onclick = () => {
    Promise.resolve(action()).catch((e) => message(e.message));
  };
  return b;
}
function message(text = "") {
  status.textContent = text;
}
function clearPrivate(preserveDraft = false) {
  authenticated = false;
  authEpoch++;
  for (const controller of inflight) controller.abort();
  inflight.clear();
  entryCache.clear();
  session = {
    csrf: "",
    today: "",
    timezone: "Asia/Shanghai",
    aiConfigured: false
  };
  epoch++;
  if (!preserveDraft) {
    composing = "";
    key = crypto.randomUUID();
    pendingText = null;
  }
  consent = false;
  invalidateReport();
  dialog.close();
  dialogContent.replaceChildren();
  app.replaceChildren();
  nav.hidden = true;
}
async function api(url, method = "GET", body, headers = {}, allowUnauthenticated = false) {
  if (!authenticated && url !== "/login" && !allowUnauthenticated)
    throw new Error("\u8BF7\u91CD\u65B0\u767B\u5F55\u540E\u64CD\u4F5C");
  const generation = authEpoch;
  const controller = new AbortController();
  inflight.add(controller);
  try {
    const res = await fetch(apiBase + "/api" + url, {
      signal: controller.signal,
      method,
      credentials: "same-origin",
      cache: "no-store",
      headers: {
        "Content-Type": "application/json",
        ...session ? { "X-CSRF-Token": session.csrf } : {},
        ...headers
      },
      ...body === void 0 ? {} : { body: JSON.stringify(body) }
    });
    const data = await res.json();
    if (generation !== authEpoch) throw new Error("\u4F1A\u8BDD\u5DF2\u6539\u53D8\uFF0C\u8BF7\u91CD\u65B0\u64CD\u4F5C");
    if (!res.ok) {
      if (res.status === 401 && url !== "/login") {
        clearPrivate(true);
        login();
      }
      throw new Error(data.error || "\u8BF7\u6C42\u5931\u8D25", { cause: res.status });
    }
    return data;
  } finally {
    inflight.delete(controller);
  }
}
function login() {
  const form = el("form"), label = el("label", "\u79C1\u4EBA\u968F\u7B14 \xB7 \u5BC6\u7801"), input = el("input");
  input.type = "password";
  input.id = "password";
  input.autocomplete = "current-password";
  input.required = true;
  input.maxLength = 1024;
  label.htmlFor = input.id;
  const submit = el("button", "\u8FDB\u5165", "primary");
  submit.type = "submit";
  form.append(label, input, submit);
  app.replaceChildren(form);
  form.onsubmit = async (e) => {
    e.preventDefault();
    submit.disabled = true;
    try {
      await api("/login", "POST", { password: input.value });
      input.value = "";
      await start();
    } catch (err) {
      message(err.message);
    } finally {
      submit.disabled = false;
    }
  };
  input.focus();
}
async function start() {
  session = await api("/session", "GET", void 0, {}, true);
  authenticated = true;
  selectedDay = session.today;
  selectedMonth = session.today.slice(0, 7);
  nav.hidden = false;
  view = "journal";
  message();
  await render();
}
function time(e) {
  if (e.timeUnknown) return "\u8865\u5F55 \xB7 \u65F6\u95F4\u672A\u8BB0\u5F55";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: session.timezone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).format(new Date(e.createdAt));
}
function labeledInput(labelText, type, value, action) {
  const wrapper = el("div"), label = el("label", labelText), input = el("input");
  input.type = type;
  input.value = value;
  input.id = "input-" + type;
  label.htmlFor = input.id;
  input.onchange = () => action(input.value);
  wrapper.append(label, input);
  return wrapper;
}
async function render() {
  if (!authenticated) return;
  for (const [id, target] of [
    ["journalNav", "journal"],
    ["monthNav", "month"]
  ]) {
    const control = document.querySelector("#" + id);
    if (view === target) control.setAttribute("aria-current", "page");
    else control.removeAttribute("aria-current");
  }
  const mine = ++epoch;
  invalidateReport();
  app.replaceChildren();
  message();
  if (view === "month") {
    app.append(
      labeledInput("\u9009\u62E9\u6708\u4EFD", "month", selectedMonth, (v) => {
        selectedMonth = v;
        void render().catch((e) => message(e.message));
      })
    );
    const root = el("div");
    app.append(root);
    await report(root, "month", selectedMonth, mine);
    return;
  }
  {
    const current = await api("/session");
    if (mine !== epoch) return;
    if (selectedDay === session.today) selectedDay = current.today;
    session = current;
    const form = el("form");
    form.id = "composer";
    const label = el("label", "\u6B64\u523B\uFF0C\u60F3\u8BB0\u4E0B\u4EC0\u4E48\uFF1F"), input = el("textarea");
    input.id = "draft";
    input.maxLength = 8e3;
    input.value = composing;
    label.htmlFor = input.id;
    const row = el("div", "", "actions"), submit = el("button", "\u5B8C\u6210", "primary");
    submit.type = "submit";
    submit.disabled = saving || !composing.trim() && pendingText === null;
    if (pendingText !== null && composing !== pendingText)
      submit.textContent = "\u786E\u8BA4\u4E0A\u6B21\u4FDD\u5B58";
    row.append(submit);
    input.oninput = () => {
      composing = input.value;
      submit.disabled = saving || !composing.trim() && pendingText === null;
      submit.textContent = pendingText !== null && composing !== pendingText ? "\u786E\u8BA4\u4E0A\u6B21\u4FDD\u5B58" : "\u5B8C\u6210";
    };
    form.onsubmit = async (event) => {
      event.preventDefault();
      if (saving || !input.value.trim() && pendingText === null) return;
      const currentText = input.value;
      saving = true;
      lockNavigation(true);
      submit.disabled = true;
      input.readOnly = true;
      const savedText = pendingText ?? currentText;
      pendingText = savedText;
      try {
        await api(
          "/entries",
          "POST",
          { text: savedText },
          { "Idempotency-Key": key }
        );
        composing = currentText === savedText ? "" : currentText;
        input.value = composing;
        key = crypto.randomUUID();
        pendingText = null;
        input.focus();
        message(
          currentText === savedText ? "\u5DF2\u4FDD\u5B58" : "\u4E0A\u6B21\u63D0\u4EA4\u5DF2\u786E\u8BA4\u4FDD\u5B58\uFF1B\u65B0\u589E\u8349\u7A3F\u5DF2\u4FDD\u7559\uFF0C\u8BF7\u70B9\u51FB\u5B8C\u6210\u4FDD\u5B58\u65B0\u8349\u7A3F\u3002"
        );
        const current2 = await api("/session");
        if (mine !== epoch) return;
        session = current2;
        invalidateReport();
        selectedDay = session.today;
        dateInput.value = selectedDay;
        dates.value = selectedDay;
        recordTitle.textContent = `${selectedDay} \xB7 \u539F\u59CB\u8BB0\u5F55`;
        markdownLink.href = apiBase + "/api/export?format=markdown&day=" + selectedDay;
        await records(recordsRoot, selectedDay, mine, recordTools);
        await report(reportRoot, "day", selectedDay, mine);
      } catch (err) {
        message(
          err.message + (input.value ? "\uFF08\u8F93\u5165\u5DF2\u4FDD\u7559\uFF0C\u8BF7\u5148\u91CD\u8BD5\u786E\u8BA4\u4E0A\u6B21\u4FDD\u5B58\uFF1B\u671F\u95F4\u7684\u65B0\u8349\u7A3F\u4E5F\u4F1A\u4FDD\u7559\uFF09" : "")
        );
      } finally {
        saving = false;
        lockNavigation(false);
        submit.disabled = !input.value.trim() && pendingText === null;
        submit.textContent = pendingText !== null && input.value !== pendingText ? "\u786E\u8BA4\u4E0A\u6B21\u4FDD\u5B58" : "\u5B8C\u6210";
        input.readOnly = false;
      }
    };
    input.onkeydown = (e) => {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        form.requestSubmit();
      }
    };
    form.append(
      label,
      input,
      row,
      el(
        "p",
        "\u8349\u7A3F\u4EC5\u5728\u5F53\u524D\u9875\u9762\u5185\u5B58\u4FDD\u7559\uFF1B\u5237\u65B0\u3001\u5173\u95ED\u6216\u9000\u51FA\u4F1A\u4E22\u5931\u3002\u6700\u957F 8000 \u5B57\u7B26\u3002",
        "muted"
      )
    );
    app.append(form);
    input.focus();
  }
  const dateControl = labeledInput("\u67E5\u770B\u65E5\u671F", "date", selectedDay, (v) => {
    selectedDay = v;
    void render().catch((e) => message(e.message));
  });
  const dateInput = dateControl.querySelector("input");
  app.append(dateControl);
  const dates = el("select");
  dates.setAttribute("aria-label", "\u5DF2\u6709\u8BB0\u5F55\u7684\u65E5\u671F");
  const blank = el("option", "\u9009\u62E9\u5DF2\u6709\u8BB0\u5F55\u65E5\u671F");
  blank.value = "";
  dates.append(blank);
  app.append(dates);
  const days = await api("/dates");
  if (mine !== epoch) return;
  for (const d of days) {
    const o = el("option", `${d.day} \xB7 ${d.count} \u6761`);
    o.value = d.day;
    dates.append(o);
  }
  dates.value = selectedDay;
  dates.onchange = () => {
    if (dates.value) {
      selectedDay = dates.value;
      void render().catch((e) => message(e.message));
    }
  };
  const searchForm = el("form"), searchLabel = el("label", "\u539F\u6587\u641C\u7D22\uFF08\u6700\u591A 200 \u6761\uFF09"), search = el("input");
  search.id = "search";
  search.type = "search";
  search.maxLength = 200;
  searchLabel.htmlFor = search.id;
  const b = el("button", "\u641C\u7D22");
  b.type = "submit";
  searchForm.append(searchLabel, search, b);
  searchForm.onsubmit = async (e) => {
    e.preventDefault();
    try {
      const data = await api(
        "/entries?q=" + encodeURIComponent(search.value)
      );
      if (mine === epoch) drawEntries(recordsRoot, data, recordTools);
    } catch (err) {
      message(err.message);
    }
  };
  const recordsRoot = el("div", "", "entry-list"), reportRoot = el("div"), recordHeading = el("div", "", "record-heading"), recordTools = el("details", "", "entry-tools");
  const recordTitle = el("h2", `${selectedDay} \xB7 \u539F\u59CB\u8BB0\u5F55`);
  recordHeading.append(recordTitle, recordTools);
  app.append(reportRoot, recordHeading, recordsRoot, searchForm);
  const downloads = el("div", "", "row");
  let markdownLink;
  for (const [format, title] of [
    ["json", "\u5BFC\u51FA\u5168\u90E8 JSON"],
    ["markdown", "\u5BFC\u51FA\u5F53\u65E5 Markdown"]
  ]) {
    const a = el("a", title, "download");
    a.href = apiBase + "/api/export?format=" + format + (format === "markdown" ? "&day=" + selectedDay : "");
    if (format === "markdown") markdownLink = a;
    downloads.append(a);
  }
  app.append(downloads);
  await records(recordsRoot, selectedDay, mine, recordTools);
  await report(reportRoot, "day", selectedDay, mine);
}
async function records(root, day, mine, tools) {
  const entries = await api("/entries?day=" + day);
  if (mine === epoch) drawEntries(root, [...entries].reverse(), tools);
}
function drawEntries(root, entries, tools) {
  root.replaceChildren();
  tools.replaceChildren();
  tools.open = false;
  tools.hidden = entries.length === 0;
  if (!entries.length) {
    root.append(el("p", "\u8FD8\u6CA1\u6709\u8BB0\u5F55\uFF0C\u968F\u65F6\u5199\u4E0B\u7B2C\u4E00\u53E5\u3002", "muted"));
    return;
  }
  let selected = entries[0];
  const selectors = [];
  const chosen = el("p", "", "muted");
  function select(e) {
    selected = e;
    chosen.textContent = `\u5DF2\u9009\uFF1A${e.day} ${time(e)} \xB7 ${e.text.slice(0, 24)}`;
    for (const item of selectors)
      item.control.setAttribute("aria-pressed", String(item.entry.id === e.id));
  }
  const menu = el("div", "", "entry-menu");
  menu.append(
    chosen,
    button("\u4FEE\u6539", () => {
      tools.open = false;
      edit(selected);
    }),
    button("\u5220\u9664", async () => {
      if (!confirm(
        "\u6C38\u4E45\u5220\u9664\u9009\u4E2D\u7684\u8FD9\u6761\u539F\u6587\uFF1F\u5DF2\u6709 AI \u6574\u7406\u4ECD\u4FDD\u7559\uFF0C\u53EA\u6709\u518D\u6B21\u751F\u6210\u624D\u66F4\u65B0\uFF1B\u5DF2\u6709\u5907\u4EFD\u4E0D\u53D7\u5F71\u54CD\u3002"
      ))
        return;
      await api("/entries/" + selected.id, "DELETE", {
        version: selected.version
      });
      entryCache.delete(selected.id);
      await render();
    })
  );
  tools.append(el("summary", "\u4FEE\u6539 / \u5220\u9664"), menu);
  for (const e of entries) {
    const article = el("article", "", "entry");
    article.id = "entry-" + e.id;
    const control = button("", () => select(e), "entry-select");
    control.title = "\u9009\u4E2D\u6B64\u6761\u8BB0\u5F55\u4EE5\u4FEE\u6539\u6216\u5220\u9664";
    control.append(
      el("span", e.day + " \xB7 " + time(e), "meta"),
      el("span", e.text, "entry-body")
    );
    article.append(control);
    root.append(article);
    selectors.push({ entry: e, control });
  }
  select(selected);
}
function edit(e) {
  const label = el("label", "\u4FEE\u6539\u539F\u6587"), input = el("textarea");
  input.id = "edit-text";
  input.value = e.text;
  input.maxLength = 8e3;
  label.htmlFor = input.id;
  const save = button(
    "\u4FDD\u5B58\u4FEE\u6539",
    async () => {
      save.disabled = true;
      try {
        await api("/entries/" + e.id, "PUT", {
          text: input.value,
          version: e.version
        });
        entryCache.delete(e.id);
        dialog.close();
        dialogContent.replaceChildren();
        await render();
      } finally {
        save.disabled = false;
      }
    },
    "primary"
  );
  dialogContent.replaceChildren(label, input, save);
  dialog.showModal();
  input.focus();
}
async function loadEntry(id) {
  if (!entryCache.has(id)) {
    entryCache.set(
      id,
      api("/entries/" + id).catch((error) => {
        if (error instanceof Error && error.cause === 404) return null;
        throw error;
      })
    );
  }
  return entryCache.get(id);
}
function previewText(text) {
  const flat = text.replace(/\s+/g, " ").trim();
  const chars = Array.from(flat);
  if (chars.length <= 64) return flat;
  const head = chars.slice(0, 64).join("");
  const boundary = Math.max(
    head.lastIndexOf("\u3002"),
    head.lastIndexOf("\uFF01"),
    head.lastIndexOf("\uFF1F"),
    head.lastIndexOf("\uFF1B")
  );
  return boundary >= 20 ? head.slice(0, boundary + 1) : head + "\u2026";
}
async function showSources(ids) {
  const mine = epoch, generation = authEpoch;
  const content = el("div");
  for (const id of ids) {
    try {
      const e = await loadEntry(id);
      if (mine !== epoch || generation !== authEpoch) return;
      if (e === null) {
        content.append(el("p", id, "meta"), el("p", "\u539F\u6587\u5DF2\u5220\u9664", "muted"));
        continue;
      }
      content.append(
        el("h2", e.day + " \xB7 " + time(e)),
        el("p", e.id, "meta"),
        el("p", e.text, "body"),
        button("\u56DE\u770B\u8FD9\u4E00\u5929", async () => {
          dialog.close();
          dialogContent.replaceChildren();
          selectedDay = e.day;
          view = "journal";
          await render();
        })
      );
    } catch (error) {
      if (!(error instanceof Error) || error.cause !== 404) throw error;
      content.append(el("p", id, "meta"), el("p", "\u539F\u6587\u5DF2\u5220\u9664", "muted"));
    }
  }
  if (mine !== epoch || generation !== authEpoch) return;
  dialogContent.replaceChildren(content);
  if (!dialog.open) dialog.showModal();
}
function source(id, day, quote, gist) {
  const wrap = el("div");
  if (quote) wrap.append(el("blockquote", quote));
  const row = el("div", "", "source-row");
  row.append(
    button(
      "\u67E5\u770B\u6765\u6E90" + (day ? " \xB7 " + day : ""),
      () => showSources([id]),
      "source"
    )
  );
  if (!quote) {
    if (gist?.trim()) {
      row.append(el("span", gist, "source-preview"));
    } else {
      const preview = el("span", "\u52A0\u8F7D\u4E2D\u2026", "source-preview");
      row.append(preview);
      loadEntry(id).then((entry) => {
        if (!preview.isConnected) return;
        if (entry === null) {
          preview.textContent = "\u539F\u6587\u5DF2\u5220\u9664";
          return;
        }
        preview.textContent = (day ? "" : entry.day + " \xB7 ") + previewText(entry.text);
      }).catch(() => {
        if (preview.isConnected) preview.textContent = "\u7B80\u4ECB\u52A0\u8F7D\u5931\u8D25";
      });
    }
  }
  wrap.append(row);
  return wrap;
}
function showInsight(root, item) {
  const section = el("section");
  section.append(el("h3", "\u4E8B\u5B9E / \u539F\u6587\u8868\u8FBE"), el("p", item.fact, "body"));
  const advice = item.advice ?? item.hypothesis;
  if (advice?.trim())
    section.append(
      el("h3", "AI \u5BF9\u6211\u7684\u5EFA\u8BAE"),
      el("p", advice, "body")
    );
  if (item.limitation?.trim())
    section.append(el("p", "\u9002\u7528\u6761\u4EF6 / \u5C40\u9650\uFF1A" + item.limitation, "body"));
  if (item.question?.trim())
    section.append(el("p", "\u8FFD\u95EE\uFF1A" + item.question, "body"));
  for (const e of item.evidence) section.append(source(e.id, e.day, e.quote));
  root.append(section);
}
function showEvidence(root, evidence) {
  for (const e of evidence) root.append(source(e.id, e.day, e.quote));
}
async function report(root, kind, period, mine, scope = reportScope, readFailures = 0) {
  if (mine !== epoch || scope !== reportScope) return;
  const request = ++reportRequest;
  if (reportTimer !== null) clearTimeout(reportTimer);
  reportTimer = null;
  const current = () => mine === epoch && scope === reportScope && request === reportRequest;
  const retryMessage = "\u6574\u7406\u72B6\u6001\u8BFB\u53D6\u5931\u8D25\uFF0C\u5C06\u81EA\u52A8\u91CD\u8BD5\uFF08\u6700\u591A 3 \u6B21\uFF09\uFF1B\u539F\u5185\u5BB9\u4FDD\u7559\u3002";
  const schedule = (failures = 0) => {
    reportTimer = setTimeout(() => {
      if (current()) void report(root, kind, period, mine, scope, failures);
    }, 2500);
  };
  let result;
  try {
    result = await api(`/result?kind=${kind}&period=${period}`);
  } catch {
    if (!current()) return;
    if (readFailures < 3) {
      message(retryMessage);
      schedule(readFailures + 1);
    } else {
      message(
        "\u6574\u7406\u72B6\u6001\u8BFB\u53D6\u4ECD\u5931\u8D25\uFF0C\u5DF2\u505C\u6B62\u81EA\u52A8\u91CD\u8BD5\uFF1B\u8BF7\u5207\u9875\u6216\u5237\u65B0\u91CD\u8BD5\uFF0C\u539F\u5185\u5BB9\u4FDD\u7559\u3002"
      );
    }
    return;
  }
  if (!current()) return;
  if (status.textContent === retryMessage) message();
  refreshReport = () => report(root, kind, period, mine, scope);
  root.replaceChildren();
  root.className = "report";
  root.append(el("h2", kind === "day" ? "\u5F53\u65E5\u6574\u7406" : "\u6708\u5EA6\u56DE\u987E"));
  const generate = button(result?.data ? "\u91CD\u65B0\u751F\u6210" : "AI \u6574\u7406", async () => {
    const taskKey = `${kind}:${period}`;
    if (generating.has(taskKey) || !current()) return;
    if (!consent) {
      if (!confirm(
        "AI \u529F\u80FD\u4F1A\u628A\u6240\u9009\u65E5\u671F / \u6708\u4EFD\u7684\u5168\u90E8\u539F\u6587\u53D1\u9001\u5230\u670D\u52A1\u7AEF\u914D\u7F6E\u7684\u6A21\u578B\u670D\u52A1\u5546\u3002\u53EF\u80FD\u5305\u542B\u5BB6\u5EAD\u6216\u5FC3\u7406\u7B49\u79C1\u5BC6\u5185\u5BB9\uFF1BAI \u53EF\u80FD\u9057\u6F0F\u6216\u8BEF\u89E3\uFF0C\u539F\u6587\u59CB\u7EC8\u662F\u4F9D\u636E\u3002\u786E\u8BA4\u53D1\u9001\uFF1F"
      ))
        return;
      consent = true;
    }
    generating.add(taskKey);
    generate.disabled = true;
    message("\u6B63\u5728\u751F\u6210\uFF0C\u53EF\u7EE7\u7EED\u5199\u968F\u7B14\u3002\u672C\u6B21\u4EC5\u53D1\u9001\u6240\u9009\u8303\u56F4\u7684\u539F\u6587\u3002");
    try {
      const task = api("/generate", "POST", {
        kind,
        period,
        consent: true
      }).then(
        () => null,
        (error2) => error2
      );
      await report(root, kind, period, mine, scope);
      const error = await task;
      if (error) throw error;
      if (mine === epoch && scope === reportScope) message("\u751F\u6210\u5B8C\u6210");
    } catch (e) {
      if (mine === epoch && scope === reportScope)
        message(e.message);
    } finally {
      generating.delete(taskKey);
      if (mine === epoch && scope === reportScope)
        await report(root, kind, period, mine, scope);
    }
  });
  generate.disabled = generating.has(`${kind}:${period}`) || !session.aiConfigured || result?.state === "running";
  root.append(generate);
  if (!session.aiConfigured)
    root.append(
      el("p", "\u672A\u914D\u7F6E\u6A21\u578B\uFF0CAI \u6682\u4E0D\u53EF\u7528\uFF1B\u666E\u901A\u8BB0\u5F55\u4E0D\u53D7\u5F71\u54CD\u3002", "warning")
    );
  if (!result?.state && !result?.data) {
    root.append(
      el(
        "p",
        "\u5C1A\u672A\u751F\u6210\uFF1B\u624B\u52A8\u786E\u8BA4\u53EF\u53D1\u9001\u539F\u6587\uFF0C\u670D\u52A1\u4E5F\u4F1A\u5728\u6BCF\u65E5 01:00 \u81EA\u52A8\u6574\u7406\u6628\u5929\u3002",
        "muted"
      )
    );
    return;
  }
  if (result.state === "running" || result.state === "failed") {
    root.append(
      el(
        "p",
        result.state === "running" ? result.data ? "\u6B63\u5728\u751F\u6210\u65B0\u4E00\u8F6E\u6574\u7406\uFF0C\u4EE5\u4E0B\u662F\u4E0A\u4E00\u6B21\u6574\u7406\u3002" : "\u6B63\u5728\u751F\u6210\uFF0C\u53EF\u7EE7\u7EED\u8BB0\u5F55\u3002" : result.data ? `\u672C\u6B21\u751F\u6210\u5931\u8D25\uFF1A${result.error}\uFF1B\u4EE5\u4E0B\u662F\u4E0A\u4E00\u6B21\u6574\u7406\u3002` : result.error || "\u751F\u6210\u5931\u8D25\uFF0C\u53EF\u91CD\u8BD5",
        "warning"
      )
    );
    if (result.state === "running") schedule();
  }
  if (!result?.data) return;
  if (result.outdated)
    root.append(
      el(
        "p",
        result.change === "removed" ? "\u751F\u6210\u540E\u539F\u6587\u6709\u5220\u9664\uFF0C\u4EE5\u4E0B\u662F\u4E0A\u4E00\u6B21\u6574\u7406\u3002" : kind === "day" ? "\u6574\u7406\u540E\u6709\u65B0\u5185\u5BB9\uFF0C\u4EE5\u4E0B\u662F\u4E0A\u4E00\u6B21\u6574\u7406\u3002" : "\u672C\u6B21\u56DE\u987E\u540E\u6709\u65B0\u5185\u5BB9\uFF0C\u4EE5\u4E0B\u662F\u4E0A\u4E00\u6B21\u56DE\u987E\u3002",
        "warning"
      )
    );
  const data = result.data;
  root.append(
    el(
      "p",
      `${period} \xB7 ${data.sources.length} \u6761\u6765\u6E90 \xB7 ${result.model} \xB7 ${new Date(result.generatedAt).toLocaleString("zh-CN")} \xB7 AI \u6574\u7406\uFF0C\u53EF\u5BF9\u7167\u539F\u6587`,
      "meta"
    )
  );
  if (kind === "day") {
    for (const s of data.sections) {
      const section = el("section");
      section.append(el("h3", s.period));
      if (s.segments) {
        for (const segment of s.segments)
          section.append(
            button(
              segment.text,
              () => showSources(segment.sources),
              "segment body"
            )
          );
      } else {
        section.append(el("p", s.text, "body"));
        for (const id of s.sources) section.append(source(id));
      }
      root.append(section);
    }
    return;
  }
  root.append(el("p", data.overview, "body"));
  const grid = el("div", "", "reportGrid"), chart = el("div"), narrative = el("div");
  grid.append(chart, narrative);
  root.append(grid);
  chart.append(
    el("h3", "\u4E3B\u9898\u5206\u5E03"),
    el(
      "p",
      `${data.total} \u6761\u8BB0\u5F55 \xB7 ${data.activeDays} \u4E2A\u8BB0\u5F55\u65E5\u3002\u6309\u5206\u7C7B\u6765\u6E90\u53BB\u91CD\u8BA1\u6570\uFF1B\u4E00\u6761\u53EF\u5C5E\u591A\u4E2A\u4E3B\u9898\uFF0C\u5408\u8BA1\u4E0D\u5FC5\u4E3A 100%\u3002\u9891\u6B21\u4E0D\u662F\u91CD\u8981\u6027\u3001\u6295\u5165\u65F6\u95F4\u6216\u751F\u6D3B\u5360\u6BD4\u3002AI \u6807\u7B7E\u53EF\u80FD\u6709\u8BEF\u3002`,
      "muted"
    )
  );
  const gists = /* @__PURE__ */ new Map();
  for (const item of data.classifications || []) {
    if (item.gist?.trim()) gists.set(item.id, item.gist);
  }
  const sourceDays = /* @__PURE__ */ new Map();
  for (const item of data.sources || []) sourceDays.set(item.id, item.day);
  for (const t of data.themes) {
    const block = el("div", "", "theme"), meter = el("progress");
    meter.className = "bar";
    meter.max = data.total;
    meter.value = t.count;
    meter.setAttribute("aria-label", `${t.name} ${t.count} \u6761`);
    block.append(el("div", `${t.name} \xB7 ${t.count} \u6761`), meter);
    const details = el("details");
    details.append(el("summary", "\u5206\u7C7B\u6765\u6E90"));
    for (const id of t.sources) details.append(source(id, sourceDays.get(id), void 0, gists.get(id)));
    block.append(details);
    chart.append(block);
  }
  for (const [title, items] of [
    ["\u5173\u952E\u6D1E\u5BDF", data.insights],
    ["\u601D\u8003\u53D8\u5316\uFF08\u4E0D\u662F\u6210\u957F\u8BC4\u5206\uFF09", data.changes],
    ["\u53EF\u80FD\u7684\u8054\u7CFB", data.connections]
  ]) {
    narrative.append(el("h3", title));
    if (!items.length)
      narrative.append(el("p", "\u6750\u6599\u4E0D\u8DB3\uFF0C\u6682\u4E0D\u4F5C\u7ED3\u8BBA\u3002", "muted"));
    for (const item of items) showInsight(narrative, item);
  }
  narrative.append(el("h3", "\u7ED3\u5408\u5EFA\u8BAE\u7684\u8FFD\u95EE"));
  for (const q of data.questions) {
    narrative.append(el("p", q.text, "body"));
    showEvidence(narrative, q.evidence);
  }
}
document.querySelector("#closeDialog").addEventListener("click", () => {
  dialog.close();
  dialogContent.replaceChildren();
});
for (const [id, target] of [
  ["journalNav", "journal"],
  ["monthNav", "month"]
])
  document.querySelector("#" + id).addEventListener("click", () => {
    if (!authenticated) return;
    view = target;
    if (target === "journal" && !selectedDay) selectedDay = session.today;
    void render().catch((e) => message(e.message));
  });
document.querySelector("#logout").addEventListener("click", () => {
  void (async () => {
    try {
      await api("/logout", "POST", {});
      clearPrivate();
      login();
      message("\u5DF2\u9000\u51FA\uFF0C\u672C\u9875\u654F\u611F\u5185\u5BB9\u5DF2\u6E05\u9664");
    } catch (e) {
      if (!authenticated) {
        clearPrivate();
        login();
      }
      message(e.message);
    }
  })();
});
window.addEventListener("pageshow", (event) => {
  if (event.persisted) location.reload();
});
var checkingToday = false;
async function refreshToday() {
  if (!authenticated || nav.hidden || view !== "journal" || saving || checkingToday || document.hidden)
    return;
  checkingToday = true;
  const mine = epoch;
  try {
    const current = await api("/session");
    if (mine === epoch && current.today !== session.today) await render();
  } catch {
  } finally {
    checkingToday = false;
  }
}
window.addEventListener("focus", () => void refreshToday());
document.addEventListener("visibilitychange", () => void refreshToday());
setInterval(() => void refreshToday(), 6e4);
void start().catch(() => {
  clearPrivate();
  login();
  message();
});
