import type { Entry } from "../src/store.js";
import type { Daily, Monthly, Insight, Evidence } from "../src/ai.js";
const app = document.querySelector<HTMLElement>("#app")!;
const status = document.querySelector<HTMLElement>("#status")!;
const nav = document.querySelector<HTMLElement>("#nav")!;
const dialog = document.querySelector<HTMLDialogElement>("#dialog")!;
const dialogContent = document.querySelector<HTMLElement>("#dialogContent")!;
let session: {
  csrf: string;
  today: string;
  timezone: string;
  aiConfigured: boolean;
};
let view: "journal" | "month" = "journal",
  selectedDay = "",
  selectedMonth = "",
  epoch = 0,
  consent = false;
let composing = "",
  key = crypto.randomUUID(),
  saving = false,
  generating = new Set<string>();
let pendingText: string | null = null;
let authEpoch = 0;
let authenticated = false;
const inflight = new Set<AbortController>();
let refreshReport: (() => Promise<void>) | null = null;
let reportScope = 0,
  reportRequest = 0;
let reportTimer: ReturnType<typeof setTimeout> | null = null;
function invalidateReport() {
  reportScope++;
  if (reportTimer !== null) clearTimeout(reportTimer);
  reportTimer = null;
  refreshReport = null;
}
function lockNavigation(locked: boolean) {
  nav.querySelectorAll("button").forEach((b) => {
    b.disabled = locked;
  });
}
function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text = "",
  cls = "",
): HTMLElementTagNameMap[K] {
  const x = document.createElement(tag);
  x.textContent = text;
  if (cls) x.className = cls;
  return x;
}
function button(
  text: string,
  action: () => void | Promise<void>,
  cls = "",
): HTMLButtonElement {
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
  session = {
    csrf: "",
    today: "",
    timezone: "Asia/Shanghai",
    aiConfigured: false,
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
async function api<T>(
  url: string,
  method = "GET",
  body?: unknown,
  headers: Record<string, string> = {},
  allowUnauthenticated = false,
): Promise<T> {
  if (!authenticated && url !== "/login" && !allowUnauthenticated)
    throw new Error("请重新登录后操作");
  const generation = authEpoch;
  const controller = new AbortController();
  inflight.add(controller);
  try {
    const res = await fetch("/api" + url, {
      signal: controller.signal,
      method,
      credentials: "same-origin",
      cache: "no-store",
      headers: {
        "Content-Type": "application/json",
        ...(session ? { "X-CSRF-Token": session.csrf } : {}),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const data = await res.json();
    if (generation !== authEpoch) throw new Error("会话已改变，请重新操作");
    if (!res.ok) {
      if (res.status === 401 && url !== "/login") {
        clearPrivate(true);
        login();
      }
      throw new Error(data.error || "请求失败", { cause: res.status });
    }
    return data;
  } finally {
    inflight.delete(controller);
  }
}
function login() {
  const form = el("form"),
    label = el("label", "私人随笔 · 密码"),
    input = el("input");
  input.type = "password";
  input.id = "password";
  input.autocomplete = "current-password";
  input.required = true;
  input.maxLength = 1024;
  label.htmlFor = input.id;
  const submit = el("button", "进入", "primary");
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
      message((err as Error).message);
    } finally {
      submit.disabled = false;
    }
  };
  input.focus();
}
async function start() {
  session = await api("/session", "GET", undefined, {}, true);
  authenticated = true;
  selectedDay = session.today;
  selectedMonth = session.today.slice(0, 7);
  nav.hidden = false;
  view = "journal";
  message();
  await render();
}
function time(e: Entry) {
  if (e.timeUnknown) return "补录 · 时间未记录";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: session.timezone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(e.createdAt));
}
function labeledInput(
  labelText: string,
  type: string,
  value: string,
  action: (v: string) => void,
) {
  const wrapper = el("div"),
    label = el("label", labelText),
    input = el("input");
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
    ["monthNav", "month"],
  ] as const) {
    const control = document.querySelector<HTMLButtonElement>("#" + id)!;
    if (view === target) control.setAttribute("aria-current", "page");
    else control.removeAttribute("aria-current");
  }
  const mine = ++epoch;
  invalidateReport();
  app.replaceChildren();
  message();
  if (view === "month") {
    app.append(
      labeledInput("选择月份", "month", selectedMonth, (v) => {
        selectedMonth = v;
        void render().catch((e) => message(e.message));
      }),
    );
    const root = el("div");
    app.append(root);
    await report(root, "month", selectedMonth, mine);
    return;
  }
  {
    const current = await api<typeof session>("/session");
    if (mine !== epoch) return;
    if (selectedDay === session.today) selectedDay = current.today;
    session = current;
    const form = el("form");
    form.id = "composer";
    const label = el("label", "此刻，想记下什么？"),
      input = el("textarea");
    input.id = "draft";
    input.maxLength = 8000;
    input.value = composing;
    label.htmlFor = input.id;
    const row = el("div", "", "actions"),
      submit = el("button", "完成", "primary");
    submit.type = "submit";
    submit.disabled = saving || (!composing.trim() && pendingText === null);
    if (pendingText !== null && composing !== pendingText)
      submit.textContent = "确认上次保存";
    row.append(submit);
    input.oninput = () => {
      composing = input.value;
      submit.disabled = saving || (!composing.trim() && pendingText === null);
      submit.textContent =
        pendingText !== null && composing !== pendingText
          ? "确认上次保存"
          : "完成";
    };
    form.onsubmit = async (event) => {
      event.preventDefault();
      if (saving || (!input.value.trim() && pendingText === null)) return;
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
          { "Idempotency-Key": key },
        );
        composing = currentText === savedText ? "" : currentText;
        input.value = composing;
        key = crypto.randomUUID();
        pendingText = null;
        input.focus();
        message(
          currentText === savedText
            ? "已保存"
            : "上次提交已确认保存；新增草稿已保留，请点击完成保存新草稿。",
        );
        // Refresh after successful save, but never mislabel a refresh failure as a save failure.
        const current = await api<typeof session>("/session");
        if (mine !== epoch) return;
        session = current;
        // The page stays mounted to preserve composer state, but its report range changes.
        invalidateReport();
        selectedDay = session.today;
        dateInput.value = selectedDay;
        dates.value = selectedDay;
        recordTitle.textContent = `${selectedDay} · 原始记录`;
        markdownLink.href = "/api/export?format=markdown&day=" + selectedDay;
        await records(recordsRoot, selectedDay, mine, recordTools);
        await report(reportRoot, "day", selectedDay, mine);
      } catch (err) {
        message(
          (err as Error).message +
            (input.value
              ? "（输入已保留，请先重试确认上次保存；期间的新草稿也会保留）"
              : ""),
        );
      } finally {
        saving = false;
        lockNavigation(false);
        submit.disabled = !input.value.trim() && pendingText === null;
        submit.textContent =
          pendingText !== null && input.value !== pendingText
            ? "确认上次保存"
            : "完成";
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
        "草稿仅在当前页面内存保留；刷新、关闭或退出会丢失。最长 8000 字符。",
        "muted",
      ),
    );
    app.append(form);
    input.focus();
  }
  const dateControl = labeledInput("查看日期", "date", selectedDay, (v) => {
    selectedDay = v;
    void render().catch((e) => message(e.message));
  });
  const dateInput = dateControl.querySelector("input")!;
  app.append(dateControl);
  const dates = el("select");
  dates.setAttribute("aria-label", "已有记录的日期");
  const blank = el("option", "选择已有记录日期");
  blank.value = "";
  dates.append(blank);
  app.append(dates);
  const days = await api<{ day: string; count: number }[]>("/dates");
  if (mine !== epoch) return;
  for (const d of days) {
    const o = el("option", `${d.day} · ${d.count} 条`);
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
  const searchForm = el("form"),
    searchLabel = el("label", "原文搜索（最多 200 条）"),
    search = el("input");
  search.id = "search";
  search.type = "search";
  search.maxLength = 200;
  searchLabel.htmlFor = search.id;
  const b = el("button", "搜索");
  b.type = "submit";
  searchForm.append(searchLabel, search, b);

  searchForm.onsubmit = async (e) => {
    e.preventDefault();
    try {
      const data = await api<Entry[]>(
        "/entries?q=" + encodeURIComponent(search.value),
      );
      if (mine === epoch) drawEntries(recordsRoot, data, recordTools);
    } catch (err) {
      message((err as Error).message);
    }
  };
  const recordsRoot = el("div", "", "entry-list"),
    reportRoot = el("div"),
    recordHeading = el("div", "", "record-heading"),
    recordTools = el("details", "", "entry-tools");
  const recordTitle = el("h2", `${selectedDay} · 原始记录`);
  recordHeading.append(recordTitle, recordTools);
  app.append(reportRoot, recordHeading, recordsRoot, searchForm);
  const downloads = el("div", "", "row");
  let markdownLink!: HTMLAnchorElement;
  for (const [format, title] of [
    ["json", "导出全部 JSON"],
    ["markdown", "导出当日 Markdown"],
  ]) {
    const a = el("a", title, "download");
    a.href =
      "/api/export?format=" +
      format +
      (format === "markdown" ? "&day=" + selectedDay : "");
    if (format === "markdown") markdownLink = a;
    downloads.append(a);
  }
  app.append(downloads);
  await records(recordsRoot, selectedDay, mine, recordTools);
  await report(reportRoot, "day", selectedDay, mine);
}
async function records(
  root: HTMLElement,
  day: string,
  mine: number,
  tools: HTMLDetailsElement,
) {
  const entries = await api<Entry[]>("/entries?day=" + day);
  if (mine === epoch) drawEntries(root, [...entries].reverse(), tools);
}
function drawEntries(
  root: HTMLElement,
  entries: Entry[],
  tools: HTMLDetailsElement,
) {
  root.replaceChildren();
  tools.replaceChildren();
  tools.open = false;
  tools.hidden = entries.length === 0;
  if (!entries.length) {
    root.append(el("p", "还没有记录，随时写下第一句。", "muted"));
    return;
  }
  let selected = entries[0];
  const selectors: { entry: Entry; control: HTMLButtonElement }[] = [];
  const chosen = el("p", "", "muted");
  function select(e: Entry) {
    selected = e;
    chosen.textContent = `已选：${e.day} ${time(e)} · ${e.text.slice(0, 24)}`;
    for (const item of selectors)
      item.control.setAttribute("aria-pressed", String(item.entry.id === e.id));
  }
  const menu = el("div", "", "entry-menu");
  menu.append(
    chosen,
    button("修改", () => {
      tools.open = false;
      edit(selected);
    }),
    button("删除", async () => {
      if (
        !confirm(
          "永久删除选中的这条原文？已有 AI 整理仍保留，只有再次生成才更新；已有备份不受影响。",
        )
      )
        return;
      await api("/entries/" + selected.id, "DELETE", {
        version: selected.version,
      });
      await render();
    }),
  );
  tools.append(el("summary", "修改 / 删除"), menu);
  for (const e of entries) {
    const article = el("article", "", "entry");
    article.id = "entry-" + e.id;
    const control = button("", () => select(e), "entry-select");
    control.title = "选中此条记录以修改或删除";
    control.append(
      el("span", e.day + " · " + time(e), "meta"),
      el("span", e.text, "entry-body"),
    );
    article.append(control);
    root.append(article);
    selectors.push({ entry: e, control });
  }
  select(selected);
}
function edit(e: Entry) {
  const label = el("label", "修改原文"),
    input = el("textarea");
  input.id = "edit-text";
  input.value = e.text;
  input.maxLength = 8000;
  label.htmlFor = input.id;
  const save = button(
    "保存修改",
    async () => {
      save.disabled = true;
      try {
        await api("/entries/" + e.id, "PUT", {
          text: input.value,
          version: e.version,
        });
        dialog.close();
        dialogContent.replaceChildren();
        await render();
      } finally {
        save.disabled = false;
      }
    },
    "primary",
  );
  dialogContent.replaceChildren(label, input, save);
  dialog.showModal();
  input.focus();
}
async function showSources(ids: string[]) {
  const mine = epoch,
    generation = authEpoch;
  const content = el("div");
  for (const id of ids) {
    try {
      const e = await api<Entry>("/entries/" + id);
      if (mine !== epoch || generation !== authEpoch) return;
      content.append(
        el("h2", e.day + " · " + time(e)),
        el("p", e.id, "meta"),
        el("p", e.text, "body"),
        button("回看这一天", async () => {
          dialog.close();
          dialogContent.replaceChildren();
          selectedDay = e.day;
          view = "journal";
          await render();
        }),
      );
    } catch (error) {
      if (!(error instanceof Error) || error.cause !== 404) throw error;
      content.append(el("p", id, "meta"), el("p", "原文已删除", "muted"));
    }
  }
  if (mine !== epoch || generation !== authEpoch) return;
  dialogContent.replaceChildren(content);
  if (!dialog.open) dialog.showModal();
}
function source(id: string, day?: string, quote?: string): HTMLElement {
  const wrap = el("div");
  if (quote) wrap.append(el("blockquote", quote));
  wrap.append(
    button(
      "查看来源" + (day ? " · " + day : ""),
      () => showSources([id]),
      "source",
    ),
  );
  return wrap;
}
function showInsight(root: HTMLElement, item: Insight) {
  const section = el("section");
  section.append(el("h3", "事实 / 原文表达"), el("p", item.fact, "body"));
  if (item.hypothesis?.trim())
    section.append(
      el("h3", "AI 提出的可能解释"),
      el("p", item.hypothesis, "body"),
    );
  if (item.limitation?.trim())
    section.append(el("p", "其他解释 / 局限：" + item.limitation, "body"));
  if (item.question?.trim())
    section.append(el("p", "追问：" + item.question, "body"));
  for (const e of item.evidence) section.append(source(e.id, e.day, e.quote));
  root.append(section);
}
function showEvidence(root: HTMLElement, evidence: Evidence[]) {
  for (const e of evidence) root.append(source(e.id, e.day, e.quote));
}
async function report(
  root: HTMLElement,
  kind: "day" | "month",
  period: string,
  mine: number,
  scope = reportScope,
  readFailures = 0,
) {
  if (mine !== epoch || scope !== reportScope) return;
  const request = ++reportRequest;
  if (reportTimer !== null) clearTimeout(reportTimer);
  reportTimer = null;
  const current = () =>
    mine === epoch && scope === reportScope && request === reportRequest;
  const retryMessage =
    "整理状态读取失败，将自动重试（最多 3 次）；原内容保留。";
  const schedule = (failures = 0) => {
    reportTimer = setTimeout(() => {
      if (current()) void report(root, kind, period, mine, scope, failures);
    }, 2500);
  };
  let result;
  try {
    result = await api<{
      state: string | null;
      error: string | null;
      generatedAt: string | null;
      model: string | null;
      outdated: boolean;
      change: "none" | "added" | "removed" | "mixed";
      data: (Daily & Monthly & { sources: { id: string }[] }) | null;
    } | null>(`/result?kind=${kind}&period=${period}`);
  } catch {
    // This request owns both success and failure: stale errors never reach button().
    if (!current()) return;
    if (readFailures < 3) {
      message(retryMessage);
      schedule(readFailures + 1);
    } else {
      message(
        "整理状态读取仍失败，已停止自动重试；请切页或刷新重试，原内容保留。",
      );
    }
    return;
  }
  if (!current()) return;
  if (status.textContent === retryMessage) message();
  refreshReport = () => report(root, kind, period, mine, scope);
  root.replaceChildren();
  root.className = "report";
  root.append(el("h2", kind === "day" ? "当日整理" : "月度回顾"));
  const generate = button(result?.data ? "重新生成" : "AI 整理", async () => {
    const taskKey = `${kind}:${period}`;
    if (generating.has(taskKey) || !current()) return;
    if (!consent) {
      if (
        !confirm(
          "AI 功能会把所选日期 / 月份的全部原文发送到服务端配置的模型服务商。可能包含家庭或心理等私密内容；AI 可能遗漏或误解，原文始终是依据。确认发送？",
        )
      )
        return;
      consent = true;
    }
    generating.add(taskKey);
    generate.disabled = true;
    message("正在生成，可继续写随笔。本次仅发送所选范围的原文。");
    try {
      const task = api("/generate", "POST", {
        kind,
        period,
        consent: true,
      }).then(
        () => null,
        (error: unknown) => error,
      );
      // Render the running task without hiding the previous successful content.
      await report(root, kind, period, mine, scope);
      const error = await task;
      if (error) throw error;
      if (mine === epoch && scope === reportScope) message("生成完成");
    } catch (e) {
      if (mine === epoch && scope === reportScope)
        message((e as Error).message);
    } finally {
      generating.delete(taskKey);
      if (mine === epoch && scope === reportScope)
        await report(root, kind, period, mine, scope);
    }
  });
  generate.disabled =
    generating.has(`${kind}:${period}`) ||
    !session.aiConfigured ||
    result?.state === "running";
  root.append(generate);
  if (!session.aiConfigured)
    root.append(
      el("p", "未配置模型，AI 暂不可用；普通记录不受影响。", "warning"),
    );
  if (!result?.state && !result?.data) {
    root.append(
      el(
        "p",
        "尚未生成；手动确认可发送原文，服务也会在每日 01:00 自动整理昨天。",
        "muted",
      ),
    );
    return;
  }
  if (result!.state === "running" || result!.state === "failed") {
    root.append(
      el(
        "p",
        result!.state === "running"
          ? result!.data
            ? "正在生成新一轮整理，以下是上一次整理。"
            : "正在生成，可继续记录。"
          : result!.data
            ? `本次生成失败：${result!.error}；以下是上一次整理。`
            : result!.error || "生成失败，可重试",
        "warning",
      ),
    );
    if (result!.state === "running") schedule();
  }
  if (!result?.data) return;
  if (result.outdated)
    root.append(
      el(
        "p",
        result.change === "removed"
          ? "生成后原文有删除，以下是上一次整理。"
          : kind === "day"
            ? "整理后有新内容，以下是上一次整理。"
            : "本次回顾后有新内容，以下是上一次回顾。",
        "warning",
      ),
    );
  const data = result.data;
  root.append(
    el(
      "p",
      `${period} · ${data.sources.length} 条来源 · ${result.model} · ${new Date(result.generatedAt!).toLocaleString("zh-CN")} · AI 整理，可对照原文`,
      "meta",
    ),
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
              "segment body",
            ),
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
  const grid = el("div", "", "reportGrid"),
    chart = el("div"),
    narrative = el("div");
  grid.append(chart, narrative);
  root.append(grid);
  chart.append(
    el("h3", "主题分布"),
    el(
      "p",
      `${data.total} 条记录 · ${data.activeDays} 个记录日。按分类来源去重计数；一条可属多个主题，合计不必为 100%。频次不是重要性、投入时间或生活占比。AI 标签可能有误。`,
      "muted",
    ),
  );
  for (const t of data.themes) {
    const block = el("div", "", "theme"),
      meter = el("progress");
    meter.className = "bar";
    meter.max = data.total;
    meter.value = t.count;
    meter.setAttribute("aria-label", `${t.name} ${t.count} 条`);
    block.append(el("div", `${t.name} · ${t.count} 条`), meter);
    const details = el("details");
    details.append(el("summary", "分类来源"));
    for (const id of t.sources) details.append(source(id));
    block.append(details);
    chart.append(block);
  }
  for (const [title, items] of [
    ["关键洞察", data.insights],
    ["思考变化（不是成长评分）", data.changes],
    ["可能的联系", data.connections],
  ] as const) {
    narrative.append(el("h3", title));
    if (!items.length)
      narrative.append(el("p", "材料不足，暂不作结论。", "muted"));
    for (const item of items) showInsight(narrative, item);
  }
  narrative.append(el("h3", "开放问题"));
  for (const q of data.questions) {
    narrative.append(el("p", q.text, "body"));
    showEvidence(narrative, q.evidence);
  }
}
document.querySelector("#closeDialog")!.addEventListener("click", () => {
  dialog.close();
  dialogContent.replaceChildren();
});
for (const [id, target] of [
  ["journalNav", "journal"],
  ["monthNav", "month"],
] as const)
  document.querySelector("#" + id)!.addEventListener("click", () => {
    if (!authenticated) return;
    view = target;
    // Returning to 随笔 keeps the day the user was viewing; only a fresh
    // session or a newly saved entry jumps back to today.
    if (target === "journal" && !selectedDay) selectedDay = session.today;
    void render().catch((e) => message(e.message));
  });
document.querySelector("#logout")!.addEventListener("click", () => {
  void (async () => {
    try {
      await api("/logout", "POST", {});
      clearPrivate();
      login();
      message("已退出，本页敏感内容已清除");
    } catch (e) {
      if (!authenticated) {
        clearPrivate();
        login();
      }
      message((e as Error).message);
    }
  })();
});
window.addEventListener("pageshow", (event) => {
  if (event.persisted) location.reload();
});
let checkingToday = false;
async function refreshToday() {
  if (
    !authenticated ||
    nav.hidden ||
    view !== "journal" ||
    saving ||
    checkingToday ||
    document.hidden
  )
    return;
  checkingToday = true;
  const mine = epoch;
  try {
    const current = await api<typeof session>("/session");
    if (mine === epoch && current.today !== session.today) await render();
  } catch {
    /* A network outage must not replace or clear the current draft. */
  } finally {
    checkingToday = false;
  }
}
window.addEventListener("focus", () => void refreshToday());
document.addEventListener("visibilitychange", () => void refreshToday());
setInterval(() => void refreshToday(), 60000);
void start().catch(() => {
  clearPrivate();
  login();
  message();
});
