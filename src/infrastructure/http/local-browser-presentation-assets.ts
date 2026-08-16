export const LOCAL_BROWSER_PRESENTATION_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Flow run</title>
<link rel="stylesheet" href="/app.css">
<script type="module" src="/app.js"></script>
</head>
<body>
<header class="masthead">
  <div><p class="eyebrow">Flow durable run</p><h1 id="run-title">Connecting</h1></div>
  <p id="connection-status" class="connection" role="status">Opening private session</p>
</header>
<div class="shell">
  <aside class="rail" aria-label="Run identity">
    <dl id="run-facts"></dl>
  </aside>
  <main id="run-content" tabindex="-1" aria-live="polite"></main>
  <aside class="controls" aria-labelledby="controls-title">
    <h2 id="controls-title">Available actions</h2>
    <div id="run-actions"></div>
  </aside>
</div>
</body>
</html>
`;

export const LOCAL_BROWSER_PRESENTATION_CSS = `:root {
  color-scheme: light;
  --flow-canvas: #e9eff1;
  --flow-surface: #f9fbfc;
  --flow-ink: #17283b;
  --flow-muted: #5c6c76;
  --flow-line: #bdcbd0;
  --flow-accent: #a9552c;
  --flow-teal: #216e70;
  --flow-danger: #a3363f;
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; color: var(--flow-ink); background: var(--flow-canvas); }
.masthead { display: flex; align-items: end; justify-content: space-between; gap: 2rem; padding: 2rem 3rem 1.5rem; border-bottom: 1px solid var(--flow-line); background: var(--flow-surface); }
.eyebrow { margin: 0 0 .35rem; color: var(--flow-accent); font: 700 .72rem/1 ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: .13em; text-transform: uppercase; }
h1 { margin: 0; font-size: clamp(1.75rem, 4vw, 3.5rem); line-height: .98; letter-spacing: -.04em; }
.connection { margin: 0; padding: .55rem .75rem; border: 1px solid var(--flow-line); border-radius: 999px; background: #fff; font-size: .82rem; }
.shell { display: grid; grid-template-columns: minmax(11rem, 16rem) minmax(0, 1fr) minmax(12rem, 18rem); gap: 1.25rem; padding: 1.25rem; }
.rail, .controls, section { border: 1px solid var(--flow-line); background: var(--flow-surface); box-shadow: 0 12px 32px rgb(23 40 59 / 8%); }
.rail, .controls { align-self: start; position: sticky; top: 1.25rem; padding: 1.1rem; }
.rail { border-left: .4rem solid var(--flow-teal); }
.rail dl, .facts { margin: 0; }
.rail dt, .facts dt { color: var(--flow-muted); font-size: .7rem; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
.rail dd, .facts dd { margin: .2rem 0 1rem; overflow-wrap: anywhere; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
main { display: grid; gap: 1rem; min-width: 0; }
section { padding: 1.25rem; }
section > h2 { margin: 0 0 1rem; font-size: 1rem; letter-spacing: .03em; text-transform: uppercase; }
.component + .component { margin-top: 1rem; }
.component h2, .component h3, .component h4 { margin: 0; }
.facts { display: grid; grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr)); gap: .85rem; }
.notice { padding: .85rem 1rem; border-left: .3rem solid var(--flow-teal); background: #edf6f4; }
.notice[data-tone="warning"] { border-color: var(--flow-accent); background: #fff4e9; }
.notice[data-tone="danger"] { border-color: var(--flow-danger); background: #fff0f1; }
.notice[data-tone="success"] { border-color: var(--flow-teal); }
progress { width: 100%; accent-color: var(--flow-teal); }
.table-wrap { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; font-size: .88rem; }
th, td { padding: .65rem; border-bottom: 1px solid var(--flow-line); text-align: left; vertical-align: top; }
th { color: var(--flow-muted); font-size: .72rem; text-transform: uppercase; }
.controls h2 { margin: 0 0 .9rem; font-size: .85rem; text-transform: uppercase; }
#run-actions { display: grid; gap: .6rem; }
button { width: 100%; min-height: 2.75rem; padding: .65rem .8rem; border: 1px solid var(--flow-ink); background: var(--flow-ink); color: #fff; font: inherit; font-weight: 700; cursor: pointer; }
button[data-kind="deny"], button[data-kind="cancel"] { background: transparent; color: var(--flow-danger); border-color: var(--flow-danger); }
button:hover { filter: brightness(1.12); }
button:focus-visible { outline: .22rem solid #e2a349; outline-offset: .15rem; }
button:disabled { cursor: wait; opacity: .55; }
@media (max-width: 960px) { .shell { grid-template-columns: 12rem minmax(0, 1fr); } .controls { grid-column: 1 / -1; position: static; } #run-actions { grid-template-columns: repeat(auto-fit, minmax(12rem, 1fr)); } }
@media (max-width: 640px) { .masthead { align-items: start; flex-direction: column; padding: 1.4rem 1rem 1rem; } .shell { display: flex; flex-direction: column; padding: .75rem; } .rail, .controls { position: static; width: 100%; } .rail dl { display: grid; grid-template-columns: 1fr 1fr; gap: .5rem 1rem; } section { padding: 1rem; } }
@media (prefers-reduced-motion: reduce) { *, *::before, *::after { scroll-behavior: auto !important; transition: none !important; } }
`;

export const LOCAL_BROWSER_PRESENTATION_JAVASCRIPT = `const TOKEN_KEY = "flow-browser-session";
const MAX_DOCUMENT_BYTES = 1024 * 1024;
const statusNode = document.getElementById("connection-status");
const titleNode = document.getElementById("run-title");
const factsNode = document.getElementById("run-facts");
const contentNode = document.getElementById("run-content");
const actionsNode = document.getElementById("run-actions");
let currentDocument;

const fragmentToken = location.hash.startsWith("#") ? location.hash.slice(1) : "";
if (fragmentToken.length > 0) {
  rememberSessionToken(fragmentToken);
  history.replaceState(null, "", location.pathname);
}
const token = fragmentToken || readSessionToken();
if (!/^[0-9a-f]{64}$/.test(token)) {
  setStatus("Private session is unavailable");
} else {
  void observe();
}

async function observe() {
  try {
    const response = await fetch("/api/documents", requestOptions("GET"));
    if (!response.ok || response.body === null) throw new Error("stream rejected");
    setStatus("Connected");
    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let pending = "";
    for (;;) {
      const item = await reader.read();
      pending += decoder.decode(item.value || new Uint8Array(), { stream: !item.done });
      if (new TextEncoder().encode(pending).byteLength > MAX_DOCUMENT_BYTES + 1) throw new Error("document too large");
      let newline;
      while ((newline = pending.indexOf("\\n")) !== -1) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        if (line.length === 0) throw new Error("empty document");
        render(JSON.parse(line));
      }
      if (item.done) {
        if (pending.length !== 0) throw new Error("partial document");
        setStatus("Run observation ended");
        forgetSessionToken();
        return;
      }
    }
  } catch {
    setStatus("Run observation failed");
  }
}

function requestOptions(method, body) {
  return {
    method,
    headers: { authorization: \`Bearer \${token}\`, ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body } : {}),
    cache: "no-store",
    credentials: "omit",
    redirect: "error",
    referrerPolicy: "no-referrer",
  };
}

function render(value) {
  if (!value || typeof value !== "object" || !value.run || !Array.isArray(value.sections) || !Array.isArray(value.actions)) throw new Error("invalid document");
  currentDocument = value;
  titleNode.textContent = value.run.workflowId;
  factsNode.replaceChildren(fact("Run", value.run.runId), fact("Status", value.run.status), fact("Sequence", String(value.run.sequence)));
  const sections = value.sections.map(renderSection);
  contentNode.replaceChildren(...sections);
  actionsNode.replaceChildren(...value.actions.map(renderAction));
  if (value.actions.length === 0) actionsNode.append(textNode("No actions are currently available."));
}

function renderSection(section) {
  const node = element("section");
  node.setAttribute("aria-labelledby", \`section-\${section.id}\`);
  const heading = textElement("h2", section.title || section.id);
  heading.id = \`section-\${section.id}\`;
  node.append(heading, ...section.components.map(renderComponent));
  return node;
}

function renderComponent(component) {
  const wrapper = element("div", "component");
  if (component.kind === "heading") wrapper.append(textElement(\`h\${component.level + 1}\`, component.text));
  else if (component.kind === "facts") {
    const list = element("dl", "facts");
    list.append(...component.items.map((item) => fact(item.label, item.value)));
    wrapper.append(list);
  } else if (component.kind === "progress") {
    const label = textElement("label", component.label);
    const progress = element("progress");
    progress.max = component.total;
    progress.value = component.completed;
    label.append(progress);
    wrapper.append(label);
  } else if (component.kind === "table") wrapper.append(renderTable(component));
  else if (component.kind === "notice") {
    wrapper.classList.add("notice");
    wrapper.dataset.tone = component.tone;
    wrapper.textContent = component.text;
  } else if (component.kind === "divider") wrapper.append(element("hr"));
  else throw new Error("unsupported component");
  return wrapper;
}

function renderTable(component) {
  const container = element("div", "table-wrap");
  const table = element("table");
  const head = element("thead");
  const headRow = element("tr");
  headRow.append(...component.columns.map((column) => textElement("th", column.label)));
  head.append(headRow);
  const body = element("tbody");
  for (const row of component.rows) {
    const tableRow = element("tr");
    tableRow.append(...row.cells.map((cell) => textElement("td", cell)));
    body.append(tableRow);
  }
  table.append(head, body);
  container.append(table);
  return container;
}

function renderAction(action) {
  const button = textElement("button", action.label);
  button.type = "button";
  button.dataset.kind = action.kind;
  button.addEventListener("click", async () => {
    if (!currentDocument) return;
    button.disabled = true;
    try {
      const body = JSON.stringify({ documentSequence: currentDocument.run.sequence, actionId: action.actionId });
      const response = await fetch("/api/actions", requestOptions("POST", body));
      if (!response.ok) throw new Error("action rejected");
      setStatus("Action accepted");
    } catch {
      button.disabled = false;
      setStatus("Action was not accepted");
    }
  });
  return button;
}

function fact(label, value) {
  const group = element("div");
  group.append(textElement("dt", label), textElement("dd", value));
  return group;
}
function rememberSessionToken(value) { try { sessionStorage.setItem(TOKEN_KEY, value); } catch {} }
function readSessionToken() { try { return sessionStorage.getItem(TOKEN_KEY) || ""; } catch { return ""; } }
function forgetSessionToken() { try { sessionStorage.removeItem(TOKEN_KEY); } catch {} }
function textNode(value) { const node = element("p"); node.textContent = value; return node; }
function textElement(tag, value) { const node = element(tag); node.textContent = value; return node; }
function element(tag, className) { const node = document.createElement(tag); if (className) node.className = className; return node; }
function setStatus(value) { statusNode.textContent = value; }
`;
