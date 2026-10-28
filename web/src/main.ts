// Teaching console UI. It renders only what the server returns: emulator transcript (reader token), read-only
// state snapshots and the C5 report as written. It never computes a pass/fail of its own; the banner is the
// report's banner, and a success badge appears only when that report says green.
import "./style.css";

type Fact = boolean | number | string;
interface Scenario { id: string; title: string; summary: string; expected_source: string; injected_fault?: string; layers: Record<string, string> }
interface Msg { ts: string; author: string; bot: boolean; text: string; buttons: string[]; replies: Msg[] }
interface Assertion { id: string; required: boolean; expected: Fact; observed: Fact | null; status: string; evidence_refs: string[]; reason: string | null }
interface Report {
  case_id: string; run_id: string; profile: string; mode: string; tree_sha: string; candidate_revision: string; dirty: boolean; status: string;
  all_lanes_status: string; banner: { green: boolean; text: string }; assertions: Assertion[]; limitations: string[]; artifacts: string[];
  simulated_faults: string[]; mutation: string; cleanup_status: string;
}
interface Job {
  job_id: number; scenario: string; phase: string; phases: { phase: string; at: string }[]; run_id: string | null; error: string | null;
  transcript: { workspace: string; channel: string; read_via: string; messages: Msg[] } | null;
  before: { label: string; rows: { key: string; value: string }[] } | null; after: Job["before"]; report: Report | null;
}
interface ConsoleInfo {
  app: { candidate_revision: string; tree_sha: string; dirty: boolean; profile: string; mode: string };
  synthetic_notice: string; scenarios: Scenario[];
  profiles: { profile: string; status: string; reason: string; parity?: string; prerequisites: { id: string; description: string; satisfied: boolean }[] }[];
}

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> & { dataset?: Record<string, string> } = {}, ...kids: (Node | string)[]) => {
  const n = document.createElement(tag);
  const { dataset, ...rest } = props;
  Object.assign(n, rest);
  if (dataset) Object.assign(n.dataset, dataset);
  n.append(...kids);
  return n;
};
const fmt = (v: Fact | null) => (v === null ? "— (not observed)" : JSON.stringify(v));
const short = (s: string) => s.slice(0, 12);

let info: ConsoleInfo;
let selected = "W01-H";
let job: Job | null = null;

function chip(status: string) {
  return el("span", { className: `chip s-${status.toLowerCase()}`, textContent: status, dataset: { status } });
}

function renderDetails() {
  const r = job?.report;
  const items: [string, string, string][] = [
    ["profile", "Profile", r?.profile ?? info.app.profile],
    ["mode", "Mode", r?.mode ?? info.app.mode],
    ["run-id", "Run ID", job?.run_id ?? "no run yet"],
    ["tree", "Tree SHA", r?.tree_sha ?? info.app.tree_sha],
    ["commit", "Commit", short(r?.candidate_revision ?? info.app.candidate_revision)],
    ["dirty", "Working tree", (r?.dirty ?? info.app.dirty) ? "dirty (bound to patch digest)" : "clean"],
  ];
  $("run-details").replaceChildren(...items.flatMap(([k, label, value]) => [el("dt", { textContent: label }), el("dd", { textContent: value, dataset: { field: k } })]));
}

function renderScenarios() {
  $("scenarios").replaceChildren(...info.scenarios.map((s) => {
    const b = el("button", { type: "button", className: "scenario", dataset: { scenario: s.id } },
      el("span", { className: "sid", textContent: s.id }), el("span", { className: "stitle", textContent: s.title }));
    b.setAttribute("aria-pressed", String(s.id === selected));
    b.addEventListener("click", () => {
      selected = s.id;
      renderScenarios();
      renderLayers();
    });
    return el("li", {}, b);
  }));
  const s = info.scenarios.find((x) => x.id === selected)!;
  $("run-button").textContent = `Run ${s.id}: ${s.title}`;
}

function renderLayers() {
  const s = info.scenarios.find((x) => x.id === selected)!;
  const names: [string, string][] = [["execution", "Execution"], ["emulation", "Emulation"], ["authorization", "Authorization"], ["evidence", "Evidence"]];
  $("layers").replaceChildren(
    el("p", { className: "summary", textContent: s.summary }),
    ...names.flatMap(([k, label]) => [el("dt", { textContent: label }), el("dd", { textContent: s.layers[k] ?? "" })]),
    el("dt", { textContent: "Judged against" }), el("dd", { textContent: s.expected_source }),
    ...(s.injected_fault ? [el("dt", { textContent: "Injected fault" }), el("dd", { className: "fault", textContent: s.injected_fault })] : []),
  );
}

function renderBanner() {
  const b = $("banner");
  b.replaceChildren();
  delete b.dataset.green;
  b.className = "banner";
  if (!job) {
    b.dataset.state = "idle";
    b.append(el("strong", { textContent: "Nothing verified yet." }), " Pick a scenario and run it; results appear only after the independent collector reports.");
    return;
  }
  b.dataset.state = job.phase;
  if (job.phase === "error") {
    b.classList.add("fail");
    b.append(el("strong", { textContent: "Run error — no result." }), ` ${job.error ?? ""}`);
    return;
  }
  if (!job.report) {
    b.classList.add("pending");
    b.append(el("strong", { textContent: `Running ${job.scenario} — not verified yet.` }), ` Phase: ${job.phase}.`);
    return;
  }
  const r = job.report;
  b.dataset.reportStatus = r.status;
  b.dataset.green = String(r.banner.green);
  const failed = r.assertions.filter((a) => a.required && a.status !== "PASS");
  if (r.banner.green && failed.length === 0) {
    b.classList.add("pass");
    b.append(el("span", { className: "badge", textContent: "PASS", dataset: { successBadge: "true" } }), " ", el("strong", { textContent: r.banner.text }));
  } else {
    b.classList.add("fail");
    b.append(el("span", { className: "badge", textContent: r.status }), " ", el("strong", { textContent: r.banner.text }),
      el("span", { className: "failing", textContent: failed.length ? ` Required assertions not passing: ${failed.map((a) => `${a.id} (${a.status})`).join(", ")}.` : "" }));
  }
  if (r.simulated_faults.length) b.append(el("span", { className: "faultnote", textContent: ` Injected fault: ${r.simulated_faults.join("; ")}` }));
}

function renderMsg(m: Msg, reply = false): HTMLLIElement {
  const li = el("li", { className: `msg${m.bot ? " bot" : ""}${reply ? " reply" : ""}`, dataset: { ts: m.ts } },
    el("div", { className: "who" }, el("span", { className: "avatar", textContent: m.author[0]?.toUpperCase() ?? "?", ariaHidden: "true" }), el("strong", { textContent: m.author }),
      el("span", { className: "ts", textContent: new Date(Number(m.ts) * 1000).toLocaleTimeString([], { hour12: false }) })),
    el("p", { className: "text", textContent: m.text }));
  if (m.buttons.length) li.append(el("div", { className: "buttons" }, ...m.buttons.map((t) => el("span", { className: "fakebtn", textContent: t }))));
  if (m.replies.length) li.append(el("ol", { className: "thread", ariaLabel: `${m.replies.length} thread replies` }, ...m.replies.map((r) => renderMsg(r, true))));
  return li;
}

function renderWorkflow() {
  const t = job?.transcript;
  $("slack-sub").textContent = t ? `${t.workspace} · ${t.channel} · read from emulator state via ${t.read_via}` : "No emulator running for the selected view.";
  $("transcript").replaceChildren(...(t?.messages.length ? t.messages.map((m) => renderMsg(m)) : [el("li", { className: "empty", textContent: job ? "Waiting for the first message in the emulator…" : "No messages yet." })]));
  $("phases").replaceChildren(...(job?.phases ?? []).map((p) => el("li", { dataset: { phase: p.phase } }, el("strong", { textContent: p.phase }), ` ${new Date(p.at).toLocaleTimeString([], { hour12: false })}`)));
  const before = job?.before, after = job?.after;
  if (!before) return void $("state").replaceChildren(el("p", { className: "empty", textContent: "No state captured yet." }));
  const keys = [...new Set([...before.rows, ...(after?.rows ?? [])].map((r) => r.key))];
  const val = (s: typeof before | null, k: string) => s?.rows.find((r) => r.key === k)?.value ?? "—";
  $("state").replaceChildren(el("table", { className: "state" },
    el("thead", {}, el("tr", {}, el("th", { scope: "col", textContent: "Record" }), el("th", { scope: "col", textContent: before.label }), el("th", { scope: "col", textContent: after?.label ?? "after (pending)" }))),
    el("tbody", {}, ...keys.map((k) => {
      const changed = after && val(before, k) !== val(after, k);
      return el("tr", { className: changed ? "changed" : "" }, el("th", { scope: "row", textContent: k }), el("td", { textContent: val(before, k) }), el("td", { textContent: val(after ?? null, k) }));
    }))));
}

function renderReport() {
  const r = job?.report;
  $("report-sub").textContent = r
    ? `Case ${r.case_id} · run ${r.run_id} · profile ${r.profile} · mode ${r.mode} · local core ${r.status} · cleanup ${r.cleanup_status}. Values are copied from report.json without reinterpretation.`
    : "No report yet. A report exists only after the independent collector finishes.";
  const head = el("thead", {}, el("tr", {}, ...["Assertion", "Required", "Expected", "Observed", "Status", "Evidence refs"].map((h) => el("th", { scope: "col", textContent: h }))));
  const row = (a: Assertion) => el("tr", { dataset: { assertion: a.id, status: a.status } },
    el("th", { scope: "row", textContent: a.id }), el("td", { textContent: a.required ? "yes" : "no" }),
    el("td", { className: "mono", textContent: fmt(a.expected), dataset: { col: "expected" } }),
    el("td", { className: "mono", textContent: fmt(a.observed), dataset: { col: "observed" } }),
    el("td", { dataset: { col: "status" } }, chip(a.status)),
    el("td", { className: "mono refs", textContent: a.evidence_refs.join(", ") || (a.reason ?? "—"), dataset: { col: "evidence" } }));
  $("assertions").replaceChildren(head, el("tbody", {}, ...(r?.assertions ?? []).map(row)));
  $("limitations").replaceChildren(...(r?.limitations ?? []).map((l) => el("li", { textContent: l })));
  $("evidence").replaceChildren(...(r?.artifacts ?? []).map((a) => el("li", { textContent: a })));
}

function renderProfiles() {
  const r = job?.report;
  const head = el("thead", {}, el("tr", {}, ...["Lane", "Status", "Why", "Prerequisites"].map((h) => el("th", { scope: "col", textContent: h }))));
  const local = el("tr", { dataset: { lane: "local" } }, el("th", { scope: "row", textContent: "local core (Emulate + Floci + SQLite)" }), el("td", {}, chip(r?.status ?? "NOT_RUN")),
    el("td", { textContent: r ? `From run ${short(r.run_id)}: ${r.banner.text}` : "No local run in this view yet." }), el("td", { textContent: "Docker, Node 24, pinned Floci image" }));
  $("profiles").replaceChildren(head, el("tbody", {}, local, ...info.profiles.map((p) => el("tr", { dataset: { lane: p.profile } },
    el("th", { scope: "row", textContent: p.profile }),
    el("td", {}, chip(p.status), ...(p.parity ? [el("span", { className: "parity", textContent: " parity " }), chip(p.parity)] : [])),
    el("td", { textContent: p.reason }),
    el("td", {}, el("ul", { className: "prereq" }, ...p.prerequisites.map((q) => {
      const text = `${q.satisfied ? "present" : "missing"}: ${q.description}`;
      return el("li", { className: q.satisfied ? "ok" : "missing", textContent: text, title: text });
    })))))));
}

function render() {
  renderDetails();
  renderBanner();
  renderWorkflow();
  renderReport();
  renderProfiles();
  document.body.dataset.runState = job ? (job.report ? "reported" : job.phase) : "idle";
  if (job?.run_id) document.body.dataset.runId = job.run_id;
}

function selectTab(id: string, focus = true) {
  for (const t of document.querySelectorAll<HTMLButtonElement>("[role=tab]")) {
    const on = t.id === id;
    t.setAttribute("aria-selected", String(on));
    t.tabIndex = on ? 0 : -1;
    $(t.getAttribute("aria-controls")!).hidden = !on;
    if (on && focus) t.focus();
  }
}

async function poll(id: number) {
  for (;;) {
    job = (await (await fetch(`/api/jobs/${id}`)).json()) as Job;
    render();
    if (job.phase === "error" || job.report) return;
    await new Promise((r) => setTimeout(r, 300));
  }
}

async function main() {
  info = (await (await fetch("/api/console")).json()) as ConsoleInfo;
  $("synthetic-notice").textContent = info.synthetic_notice;
  const params = new URLSearchParams(location.search);
  if (params.get("scenario") && info.scenarios.some((s) => s.id === params.get("scenario"))) selected = params.get("scenario")!;
  const run = params.get("run");
  if (run) {
    const res = await fetch(`/api/runs/${encodeURIComponent(run)}`);
    if (res.ok) {
      job = (await res.json()) as Job;
      selected = job.scenario;
    }
  }
  renderScenarios();
  renderLayers();
  render();
  if (params.get("tab")) selectTab(`tab-${params.get("tab")}`, false);
  $("run-button").addEventListener("click", async () => {
    const res = await fetch(`/api/scenarios/${selected}/run`, { method: "POST" });
    if (!res.ok) return;
    selectTab("tab-workflow");
    await poll(((await res.json()) as { job_id: number }).job_id);
  });
  const tabs = [...document.querySelectorAll<HTMLButtonElement>("[role=tab]")];
  for (const t of tabs) {
    t.addEventListener("click", () => selectTab(t.id));
    t.addEventListener("keydown", (e) => {
      const i = tabs.indexOf(t);
      if (e.key === "ArrowRight" || e.key === "ArrowLeft") selectTab(tabs[(i + (e.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length]!.id);
    });
  }
}

void main();
