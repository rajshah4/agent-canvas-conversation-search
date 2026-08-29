/**
 * Conversation Search — Agent Canvas Extension
 *
 * Full-text search across conversation history (via local FTS5 server),
 * with a full conversation trace view when a result is clicked. The trace
 * uses the Agent Server events API, same as the conversation-trace extension.
 */

const ROOT_PATH = "/extensions/conversation-search/search";
const SEARCH_API =
  (typeof localStorage !== "undefined" &&
    localStorage.getItem("conv-search:api-base")) ||
  "http://localhost:8765";

const SEARCH_SESSION = {
  query: "",
  groups: [],
  selectedHit: null,
};


// ─── CSS (dark canvas theme) ────────────────────────────────────────────────

const STYLE = `
.conv-search {
  --cs-bg: var(--oh-background, #0b0c0e);
  --cs-panel: var(--oh-surface, #15171a);
  --cs-raised: var(--oh-surface-raised, #1d2024);
  --cs-text: var(--oh-foreground, #f1efe8);
  --cs-muted: var(--oh-text-secondary, #a4a6a9);
  --cs-dim: var(--oh-text-dim, #73777c);
  --cs-border: var(--oh-border-subtle, #30343a);
  --cs-accent: var(--oh-accent, #d6ff5f);
  --cs-user: #fbbf24;
  --cs-agent: #7dd3fc;
  --cs-tool: #c4b5fd;
  --cs-command: #fb923c;
  --cs-file: #5eead4;
  --cs-error: #fb7185;

  min-height: 100%;
  color: var(--cs-text);
  background: var(--cs-bg);
  font-family: -apple-system, "SF Pro", BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  font-size: 14px;
  display: flex;
  flex-direction: column;
}

.conv-search * { box-sizing: border-box; }

/* ── Search page layout ── */
.conv-search__search-page {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.conv-search__header {
  padding: 1rem 1.5rem;
  border-bottom: 1px solid var(--cs-border);
  background: var(--cs-panel);
  flex-shrink: 0;
}

.conv-search__title-row {
  display: flex;
  align-items: baseline;
  gap: .6rem;
  margin-bottom: .75rem;
}

.conv-search__title {
  font-size: 1.1rem;
  font-weight: 600;
}

.conv-search__stats {
  font-size: .72rem;
  color: var(--cs-dim);
  font-family: source-code-pro, Menlo, monospace;
}

.conv-search__bar {
  display: flex;
  gap: .5rem;
}

.conv-search__input {
  flex: 1;
  min-height: 2.25rem;
  border: 1px solid var(--cs-border);
  border-radius: .35rem;
  padding: .48rem .62rem;
  color: var(--cs-text);
  background: var(--cs-bg);
  font-size: .85rem;
  font-family: inherit;
  outline: none;
}

.conv-search__input:focus {
  border-color: var(--cs-accent);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--cs-accent) 25%, transparent);
}

.conv-search__input::placeholder { color: var(--cs-dim); }

.conv-search__btn {
  min-height: 2.25rem;
  border: 1px solid var(--cs-border);
  border-radius: .35rem;
  padding: .45rem .9rem;
  color: var(--cs-text);
  background: var(--cs-panel);
  font-size: .72rem;
  font-weight: 700;
  cursor: pointer;
  font-family: inherit;
}

.conv-search__btn:hover { border-color: var(--cs-muted); background: var(--cs-raised); }

.conv-search__body {
  flex: 1;
  display: flex;
  overflow: hidden;
}

.conv-search__sidebar {
  width: 200px;
  border-right: 1px solid var(--cs-border);
  background: var(--cs-panel);
  padding: .75rem;
  overflow-y: auto;
  flex-shrink: 0;
}

.conv-search__facet-group { margin-bottom: 1rem; }

.conv-search__facet-label {
  font-size: .6rem;
  font-weight: 800;
  text-transform: uppercase;
  letter-spacing: .11em;
  color: var(--cs-dim);
  margin-bottom: .4rem;
}

.conv-search__facet-item {
  display: flex;
  align-items: center;
  gap: .35rem;
  padding: .25rem .4rem;
  border-radius: .25rem;
  font-size: .72rem;
  cursor: pointer;
  color: var(--cs-text);
  transition: background .1s;
  overflow: hidden;
}

.conv-search__facet-item:hover { background: var(--cs-raised); }
.conv-search__facet-item--active {
  background: color-mix(in srgb, var(--cs-accent) 15%, transparent);
  color: var(--cs-accent);
  font-weight: 500;
}

.conv-search__facet-count {
  margin-left: auto;
  color: var(--cs-dim);
  font-size: .65rem;
  font-variant-numeric: tabular-nums;
  font-family: source-code-pro, Menlo, monospace;
}

.conv-search__results {
  flex: 1;
  overflow: auto;
  padding: 1rem 1.5rem;
}


.conv-search__table {
  min-width: 920px;
  border: 1px solid var(--cs-border);
  border-radius: .45rem;
  overflow: hidden;
  background: var(--cs-panel);
}

.conv-search__table-row {
  display: grid;
  grid-template-columns: 8rem minmax(17rem, 2fr) 7rem minmax(10rem, 1fr) 5rem 5rem 5rem;
  align-items: center;
  min-height: 3.25rem;
  border-bottom: 1px solid var(--cs-border);
}

.conv-search__table-row:last-child { border-bottom: 0; }
.conv-search__table-row--header {
  position: sticky;
  top: 0;
  z-index: 2;
  min-height: 2.4rem;
  background: var(--cs-bg);
  color: var(--cs-dim);
  font-size: .59rem;
  font-weight: 800;
  letter-spacing: .08em;
  text-transform: uppercase;
}

.conv-search__table-row--result {
  color: var(--cs-text);
  cursor: pointer;
  transition: background .1s;
}
.conv-search__table-row--result:hover,
.conv-search__table-row--result:focus-visible {
  background: var(--cs-raised);
  outline: none;
  box-shadow: inset 3px 0 var(--cs-accent);
}

.conv-search__table-cell {
  min-width: 0;
  padding: .55rem .7rem;
  overflow: hidden;
  font-size: .7rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.conv-search__table-cell--numeric {
  color: var(--cs-muted);
  font-family: source-code-pro, Menlo, monospace;
  font-variant-numeric: tabular-nums;
  text-align: right;
}
.conv-search__table-cell--updated {
  color: var(--cs-muted);
  font-family: source-code-pro, Menlo, monospace;
  font-size: .65rem;
}
.conv-search__table-title {
  overflow: hidden;
  color: var(--cs-text);
  font-size: .76rem;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.conv-search__table-model {
  overflow: hidden;
  color: var(--cs-muted);
  font-family: source-code-pro, Menlo, monospace;
  font-size: .64rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.conv-search__table-snippet {
  margin-top: .2rem;
  overflow: hidden;
  color: var(--cs-dim);
  font-family: source-code-pro, Menlo, monospace;
  font-size: .62rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.conv-search__results-footer {
  display: flex;
  justify-content: center;
  padding: 1rem;
}

.conv-search__result {
  padding: .85rem 1rem;
  margin-bottom: .5rem;
  border: 1px solid var(--cs-border);
  border-radius: .4rem;
  background: var(--cs-panel);
  cursor: pointer;
  transition: border-color .15s;
}

.conv-search__result:hover {
  border-color: var(--cs-accent);
  background: var(--cs-raised);
}

.conv-search__result-meta {
  display: flex;
  align-items: center;
  gap: .4rem;
  margin-bottom: .35rem;
  font-size: .65rem;
  color: var(--cs-dim);
  font-family: source-code-pro, Menlo, monospace;
  flex-wrap: wrap;
}

.conv-search__badge {
  display: inline-block;
  padding: .06rem .35rem;
  border-radius: .2rem;
  font-size: .6rem;
  font-weight: 600;
  font-family: source-code-pro, Menlo, monospace;
  background: var(--cs-bg);
  border: 1px solid var(--cs-border);
  color: var(--cs-muted);
}

.conv-search__badge--finished { color: #5eead4; border-color: color-mix(in srgb, #5eead4 30%, var(--cs-border)); }
.conv-search__badge--error { color: var(--cs-error); border-color: color-mix(in srgb, var(--cs-error) 30%, var(--cs-border)); }
.conv-search__badge--running { color: var(--cs-accent); border-color: color-mix(in srgb, var(--cs-accent) 30%, var(--cs-border)); }
.conv-search__badge--paused { color: #c4b5fd; border-color: color-mix(in srgb, #c4b5fd 30%, var(--cs-border)); }

.conv-search__result-title {
  font-size: .85rem;
  font-weight: 500;
  margin-bottom: .25rem;
  color: var(--cs-text);
}

.conv-search__snippet {
  font-size: .72rem;
  color: var(--cs-muted);
  line-height: 1.5;
  font-family: source-code-pro, Menlo, monospace;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 3.6em;
  overflow: hidden;
}

.conv-search__highlight {
  background: color-mix(in srgb, var(--cs-accent) 25%, transparent);
  color: var(--cs-accent);
  font-weight: 600;
  border-radius: 2px;
  padding: 0 1px;
}

.conv-search__empty {
  text-align: center;
  padding: 3rem 1.5rem;
  color: var(--cs-dim);
  font-size: .85rem;
}

.conv-search__loading {
  text-align: center;
  padding: 1.5rem;
  color: var(--cs-dim);
  font-size: .8rem;
}

.conv-search__error {
  padding: .75rem 1rem;
  border-radius: .35rem;
  background: color-mix(in srgb, var(--cs-error) 12%, var(--cs-panel));
  border: 1px solid color-mix(in srgb, var(--cs-error) 30%, var(--cs-border));
  color: var(--cs-error);
  font-size: .8rem;
  margin-bottom: .75rem;
}

.conv-search__error code {
  font-family: source-code-pro, Menlo, monospace;
  background: var(--cs-bg);
  padding: .1rem .3rem;
  border-radius: .2rem;
}

.conv-search__more {
  width: 100%;
  margin-top: .75rem;
}

/* ── Trace page ── */
.conv-search__trace-page {
  flex: 1;
  display: grid;
  grid-template-columns: 17rem minmax(28rem, 1fr) minmax(19rem, 25rem);
  min-height: 0;
  overflow: hidden;
}

.conv-search__trace-sidebar {
  min-width: 0;
  border-right: 1px solid var(--cs-border);
  background: var(--cs-panel);
  overflow-y: auto;
}

.conv-search__trace-back {
  position: sticky;
  top: 0;
  z-index: 2;
  display: flex;
  align-items: center;
  gap: .4rem;
  padding: .75rem 1rem;
  border: 0;
  border-bottom: 1px solid var(--cs-border);
  cursor: pointer;
  font-size: .72rem;
  color: var(--cs-muted);
  background: var(--cs-panel);
  width: 100%;
  font-family: inherit;
}

.conv-search__trace-back:hover { background: var(--cs-raised); color: var(--cs-accent); }

.conv-search__trace-results-label {
  padding: .8rem 1rem .45rem;
  color: var(--cs-dim);
  font-family: source-code-pro, Menlo, monospace;
  font-size: .6rem;
  font-weight: 800;
  letter-spacing: .12em;
  text-transform: uppercase;
}

.conv-search__trace-result {
  display: block;
  width: calc(100% - 1rem);
  margin: 0 .5rem .35rem;
  padding: .65rem .7rem;
  border: 1px solid transparent;
  border-radius: .35rem;
  background: transparent;
  color: var(--cs-text);
  text-align: left;
  font-family: inherit;
  cursor: pointer;
}

.conv-search__trace-result:hover { background: var(--cs-raised); }
.conv-search__trace-result--active {
  border-color: color-mix(in srgb, var(--cs-accent) 45%, var(--cs-border));
  background: var(--cs-raised);
}

.conv-search__trace-result-title {
  display: block;
  overflow: hidden;
  color: var(--cs-text);
  font-size: .72rem;
  font-weight: 650;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.conv-search__trace-result-meta {
  display: flex;
  justify-content: space-between;
  gap: .4rem;
  margin-top: .3rem;
  color: var(--cs-dim);
  font-family: source-code-pro, Menlo, monospace;
  font-size: .58rem;
}

.conv-search__trace-result-snippet {
  display: -webkit-box;
  margin-top: .35rem;
  overflow: hidden;
  color: var(--cs-muted);
  font-size: .65rem;
  line-height: 1.4;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}

.conv-search__trace-header {
  padding: 1rem 1.5rem;
  border-bottom: 1px solid var(--cs-border);
}

.conv-search__trace-eyebrow {
  color: var(--cs-accent);
  font-family: source-code-pro, Menlo, monospace;
  font-size: .6rem;
  font-weight: 800;
  letter-spacing: .16em;
  text-transform: uppercase;
  margin: 0 0 .25rem;
}

.conv-search__trace-title {
  font-size: 1rem;
  font-weight: 600;
  margin: 0;
}

.conv-search__trace-meta {
  display: flex;
  gap: .5rem;
  margin-top: .4rem;
  color: var(--cs-dim);
  font-family: source-code-pro, Menlo, monospace;
  font-size: .65rem;
  flex-wrap: wrap;
}

.conv-search__trace-main {
  min-width: 0;
  overflow-y: auto;
  padding: 1rem 1.25rem 3rem;
}

.conv-search__inspector-pane {
  min-width: 0;
  overflow-y: auto;
  border-left: 1px solid var(--cs-border);
  background: var(--cs-panel);
  padding: 1rem;
}

.conv-search__inspector-empty {
  display: grid;
  min-height: 12rem;
  place-items: center;
  padding: 1rem;
  color: var(--cs-dim);
  font-size: .72rem;
  line-height: 1.5;
  text-align: center;
}

.conv-search__trace-toolbar {
  display: flex;
  gap: .5rem;
  margin-bottom: 1rem;
  flex-wrap: wrap;
}

.conv-search__filter-btn {
  padding: .25rem .55rem;
  border: 1px solid var(--cs-border);
  border-radius: .3rem;
  background: var(--cs-panel);
  color: var(--cs-text);
  font-size: .68rem;
  cursor: pointer;
  font-family: source-code-pro, Menlo, monospace;
  font-family: inherit;
}

.conv-search__filter-btn:hover { background: var(--cs-raised); }
.conv-search__filter-btn--active {
  background: color-mix(in srgb, var(--filter-color, var(--cs-accent)) 15%, transparent);
  border-color: var(--filter-color, var(--cs-accent));
  color: var(--filter-color, var(--cs-accent));
}

.conv-search__timeline {
  display: flex;
  flex-direction: column;
  gap: .4rem;
}

.conv-search__event {
  display: flex;
  gap: .6rem;
  padding: .65rem .8rem;
  border: 1px solid var(--cs-border);
  border-left: 3px solid var(--event-color, var(--cs-border));
  border-radius: 0 .35rem .35rem 0;
  background: var(--cs-panel);
  cursor: pointer;
  transition: background .1s;
}

.conv-search__event:hover { background: var(--cs-raised); }
.conv-search__event--selected {
  background: var(--cs-raised);
  border-color: var(--event-color, var(--cs-border));
}

.conv-search__event-mark {
  font-size: .9rem;
  flex-shrink: 0;
  width: 1.2rem;
  text-align: center;
}

.conv-search__event-content {
  flex: 1;
  min-width: 0;
}

.conv-search__event-top {
  display: flex;
  justify-content: space-between;
  gap: .5rem;
  margin-bottom: .2rem;
}

.conv-search__event-name {
  font-size: .75rem;
  font-weight: 600;
  color: var(--cs-text);
}

.conv-search__event-cat {
  font-size: .6rem;
  text-transform: uppercase;
  letter-spacing: .08em;
  color: var(--event-color, var(--cs-dim));
  margin-right: .35rem;
  font-weight: 700;
}

.conv-search__event-time {
  font-size: .6rem;
  color: var(--cs-dim);
  font-family: source-code-pro, Menlo, monospace;
  flex-shrink: 0;
}

.conv-search__event-summary {
  font-size: .72rem;
  color: var(--cs-muted);
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 4.5em;
  overflow: hidden;
}

.conv-search__event-badges {
  display: flex;
  gap: .3rem;
  margin-top: .3rem;
  flex-wrap: wrap;
}

.conv-search__inspector {
  min-width: 0;
}

.conv-search__inspector-kicker {
  margin: 0 0 .35rem;
  color: var(--cs-accent);
  font-family: source-code-pro, Menlo, monospace;
  font-size: .58rem;
  font-weight: 800;
  letter-spacing: .12em;
  text-transform: uppercase;
}

.conv-search__inspector-title {
  font-size: .8rem;
  font-weight: 600;
  margin: 0 0 .5rem;
  color: var(--cs-text);
}

.conv-search__inspector-section { margin-bottom: .75rem; }

.conv-search__inspector-label {
  font-size: .6rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: .08em;
  color: var(--cs-dim);
  margin-bottom: .2rem;
}

.conv-search__inspector-content {
  font-size: .75rem;
  color: var(--cs-text);
  font-family: source-code-pro, Menlo, monospace;
  white-space: pre-wrap;
  word-break: break-word;
  line-height: 1.5;
  max-height: 300px;
  overflow-y: auto;
  background: var(--cs-bg);
  padding: .5rem .65rem;
  border-radius: .25rem;
  border: 1px solid var(--cs-border);
}


.conv-search__transcript {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  max-width: 54rem;
  margin: 0 auto;
}

.conv-search__turn {
  display: grid;
  grid-template-columns: 2.25rem minmax(0, 1fr);
  gap: .75rem;
  padding: .9rem;
  border: 1px solid transparent;
  border-radius: .6rem;
  cursor: pointer;
}

.conv-search__turn:hover { background: color-mix(in srgb, var(--cs-raised) 55%, transparent); }
.conv-search__turn--user { background: color-mix(in srgb, var(--cs-accent) 7%, transparent); }
.conv-search__turn--selected {
  border-color: var(--cs-accent);
  background: color-mix(in srgb, var(--cs-accent) 11%, transparent);
}

.conv-search__turn-avatar {
  display: grid;
  place-items: center;
  width: 2.1rem;
  height: 2.1rem;
  border-radius: .45rem;
  background: var(--cs-raised);
  color: var(--cs-muted);
  font-size: .62rem;
  font-weight: 800;
}

.conv-search__turn--user .conv-search__turn-avatar {
  background: color-mix(in srgb, var(--cs-accent) 20%, transparent);
  color: var(--cs-accent);
}

.conv-search__turn-body { min-width: 0; }
.conv-search__turn-heading {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 1rem;
  margin-bottom: .45rem;
  color: var(--cs-text);
  font-size: .78rem;
  font-weight: 700;
}
.conv-search__turn-heading time,
.conv-search__turn-tool time {
  color: var(--cs-dim);
  font-family: source-code-pro, Menlo, monospace;
  font-size: .6rem;
  font-weight: 400;
}

.conv-search__turn-content {
  color: var(--cs-text);
  font-size: .83rem;
  line-height: 1.65;
  white-space: pre-wrap;
  word-break: break-word;
}

.conv-search__turn-tools,
.conv-search__orphan-tools {
  margin-top: .75rem;
  border: 1px solid var(--cs-border);
  border-radius: .45rem;
  overflow: hidden;
  background: color-mix(in srgb, var(--cs-panel) 75%, transparent);
}
.conv-search__orphan-tools { max-width: 54rem; margin: 0 auto; }

.conv-search__turn-tools-summary {
  display: flex;
  align-items: center;
  gap: .35rem;
  padding: .48rem .65rem;
  color: var(--cs-muted);
  font-size: .68rem;
  cursor: pointer;
  list-style-position: inside;
}

.conv-search__turn-tool {
  display: grid;
  grid-template-columns: 4.5rem minmax(7rem, auto) auto;
  gap: .55rem;
  width: 100%;
  padding: .48rem .65rem;
  border: 0;
  border-top: 1px solid var(--cs-border);
  background: transparent;
  color: var(--cs-muted);
  text-align: left;
  cursor: pointer;
}
.conv-search__turn-tool:hover { background: var(--cs-raised); }
.conv-search__turn-tool--selected {
  background: color-mix(in srgb, var(--cs-accent) 12%, transparent);
  box-shadow: inset 3px 0 var(--cs-accent);
}
.conv-search__turn-tool-kind {
  color: var(--cs-dim);
  font-size: .58rem;
  font-weight: 800;
  letter-spacing: .06em;
  text-transform: uppercase;
}
.conv-search__turn-tool-title { color: var(--cs-text); font-size: .7rem; font-weight: 600; }
.conv-search__turn-tool-summary {
  grid-column: 2 / -1;
  overflow: hidden;
  color: var(--cs-dim);
  font-family: source-code-pro, Menlo, monospace;
  font-size: .64rem;
  line-height: 1.45;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.conv-search__notice {
  text-align: center;
  padding: 2rem;
  color: var(--cs-dim);
  font-size: .8rem;
}

@media (prefers-reduced-motion: reduce) {
  * { transition: none !important; }
}

@media (max-width: 1200px) {
  .conv-search__trace-page { grid-template-columns: 15rem minmax(24rem, 1fr); }
  .conv-search__inspector-pane { display: none; }
}

@media (max-width: 820px) {
  .conv-search__sidebar,
  .conv-search__trace-sidebar { display: none; }
  .conv-search__trace-page { grid-template-columns: minmax(0, 1fr); }
  .conv-search__trace-main { padding: .75rem; }
}
`;

// ─── Categories (mirrors conversation-trace) ────────────────────────────────

const CATEGORY = {
  message:  { label: "Message",  color: "var(--cs-agent)",   mark: "💬" },
  command:  { label: "Command",  color: "var(--cs-command)", mark: "⚙" },
  file:     { label: "File",     color: "var(--cs-file)",    mark: "📝" },
  tool:     { label: "Tool",     color: "var(--cs-tool)",    mark: "🔧" },
  error:    { label: "Error",    color: "var(--cs-error)",   mark: "✕" },
  approval: { label: "Approval", color: "#facc15",           mark: "🔒" },
  state:    { label: "State",    color: "var(--cs-dim)",     mark: "•" },
  other:    { label: "Other",    color: "var(--cs-dim)",     mark: "•" },
};

// ─── Helpers ────────────────────────────────────────────────────────────────

function el(tag, className, ...children) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  for (const child of children) {
    if (child == null || child === false) continue;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

function appendHighlighted(node, text, query) {
  const value = String(text ?? "");
  const term = String(query ?? "").trim();
  if (!term) {
    node.append(document.createTextNode(value));
    return;
  }
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const matcher = new RegExp(`(${escaped})`, "ig");
  for (const part of value.split(matcher)) {
    if (!part) continue;
    node.append(matcher.test(part)
      ? el("mark", "conv-search__highlight", part)
      : document.createTextNode(part));
    matcher.lastIndex = 0;
  }
}


function fmtDate(iso) {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) +
      " " + d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  } catch { return iso; }
}

function fmtTime(iso) {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  } catch { return iso; }
}

function fmtNum(n) {
  if (!n) return "0";
  if (n >= 1e9) return (n / 1e9).toFixed(1) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "k";
  return String(n);
}

function record(v) { return (v && typeof v === "object" && !Array.isArray(v)) ? v : null; }

function textContent(content) {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((c) => (typeof c === "string" ? c : c?.text || "")).join("");
  }
  return "";
}

async function searchApi(path) {
  const resp = await fetch(`${SEARCH_API}${path}`);
  if (!resp.ok) throw new Error(`Search API ${resp.status}`);
  return resp.json();
}

async function fetchAllEvents(host, conversationId) {
  const events = [];
  const seenIds = new Set();
  let nextPageId = null;
  const limit = 100;
  let safety = 0;
  const MAX_EVENTS = 500;
  while (safety++ < 200) {
    let path = `/api/conversations/${encodeURIComponent(conversationId)}/events/search?limit=${limit}`;
    if (nextPageId) path += `&page_id=${encodeURIComponent(nextPageId)}`;
    const data = await host.agentServer.request({ path });
    const batch = data.events || data.items || [];
    let added = 0;
    for (const event of batch) {
      if (seenIds.has(event.id)) continue;
      seenIds.add(event.id);
      events.push(event);
      added += 1;
    }
    nextPageId = data.next_page_id || null;
    if (!nextPageId || batch.length < limit || added === 0 || events.length >= MAX_EVENTS) break;
  }
  return events.slice(0, MAX_EVENTS);
}

function kindOf(e) { return typeof e?.kind === "string" ? e.kind : "UnknownEvent"; }
function payloadKind(e) { return e?.action?.kind ?? e?.observation?.kind ?? ""; }

function categoryOf(event) {
  const kind = `${kindOf(event)} ${payloadKind(event)} ${event?.tool_name ?? ""}`.toLowerCase();
  const obs = record(event?.observation);
  if (kind.includes("error") || obs?.error || obs?.is_error === true) return "error";
  if (kind.includes("reject") || kind.includes("confirm") || kind.includes("approval")) return "approval";
  if (kind.includes("fileeditor") || kind.includes("strreplace") || kind.includes("planningfile")) return "file";
  if (kind.includes("bash") || kind.includes("terminal") || kind.includes("command")) return "command";
  if (kind.includes("message")) return "message";
  if (kind.includes("action") || kind.includes("observation") || kind.includes("tool")) return "tool";
  if (kind.includes("state") || kind.includes("pause") || kind.includes("interrupt") || kind.includes("stats")) return "state";
  return "other";
}

function eventTitle(event) {
  const kind = kindOf(event);
  const payload = record(event.action) ?? record(event.observation);
  if (kind === "MessageEvent") return `${event.source === "user" ? "User" : "Agent"} message`;
  if (kind === "ActionEvent") return event.summary || event.tool_name || payload?.kind || "Tool call";
  if (kind === "ObservationEvent") return `${event.tool_name || payload?.kind || "Tool"} result`;
  if (kind === "ConversationErrorEvent") return event.code || "Conversation error";
  if (kind === "ConversationStateUpdateEvent") return event.key === "stats" ? "Usage stats" : `${event.key || ""} state`;
  return kind.replace(/Event$/, "").replace(/([a-z])([A-Z])/g, "$1 $2");
}

function eventSummary(event) {
  const action = record(event.action);
  const obs = record(event.observation);
  const kind = kindOf(event);
  if (kind === "MessageEvent") return textContent(event.llm_message?.content ?? event.content ?? event.message?.content) || "";
  if (event.summary) return String(event.summary);
  if (action?.command) return String(action.command);
  if (action?.path) return `${action.command ?? "edit"} ${action.path}`;
  if (action?.url) return String(action.url);
  if (event.error) return String(event.error);
  if (obs?.output) return String(obs.output);
  if (obs?.content) return textContent(obs.content);
  if (obs?.command) return String(obs.command);
  if (event.snippet) return String(event.snippet).replace(/[⟦⟧]/g, "");
  return "";
}

function eventDetails(event) {
  const sections = [];
  const action = record(event.action);
  const obs = record(event.observation);
  const msg = textContent(event.llm_message?.content ?? event.content ?? event.message?.content);
  const thought = textContent(event.thought);
  const indexedSnippet = event.snippet ? String(event.snippet).replace(/[⟦⟧]/g, "") : "";
  if (msg) sections.push(["Content", msg]);
  else if (indexedSnippet) sections.push(["Indexed match", indexedSnippet]);
  if (thought) sections.push(["Thought", thought]);
  if (event.reasoning_content) sections.push(["Reasoning", String(event.reasoning_content)]);
  if (action?.command) sections.push(["Command", String(action.command)]);
  if (action?.path) sections.push(["Path", String(action.path)]);
  if (action?.old_str) sections.push(["Removed", String(action.old_str)]);
  if (action?.new_str) sections.push(["Added", String(action.new_str)]);
  if (obs?.output) sections.push(["Output", String(obs.output)]);
  const obsContent = textContent(obs?.content);
  if (obsContent && obsContent !== obs?.output) sections.push(["Result", obsContent]);
  if (obs?.error) sections.push(["Error", String(obs.error)]);
  if (event.error) sections.push(["Error", String(event.error)]);
  return sections;
}

function messageRole(event) {
  const role = event.llm_message?.role || event.message?.role || event.source;
  return role === "user" ? "user" : "assistant";
}

function conversationTurns(events) {
  const turns = [];
  let pendingActivity = [];

  const attachPending = () => {
    if (!pendingActivity.length) return;
    const assistant = [...turns].reverse().find((turn) => turn.role === "assistant");
    if (assistant) assistant.activity.push(...pendingActivity);
    else turns.push({ id: `activity-${pendingActivity[0].id}`, role: "activity", event: null, activity: pendingActivity });
    pendingActivity = [];
  };

  for (const event of events) {
    if (kindOf(event) !== "MessageEvent") {
      if (!["state", "other"].includes(categoryOf(event))) pendingActivity.push(event);
      continue;
    }

    const role = messageRole(event);
    if (role === "user") {
      attachPending();
      turns.push({ id: event.id, role, event, activity: [] });
      continue;
    }

    turns.push({ id: event.id, role, event, activity: pendingActivity });
    pendingActivity = [];
  }
  attachPending();
  return turns;
}

function renderConversationTranscript(events, selectedId, highlightQuery, onSelect) {
  const transcript = el("div", "conv-search__transcript");
  let selectedNode = null;

  for (const turn of conversationTurns(events)) {
    const selectedInActivity = turn.activity.some((event) => event.id === selectedId);
    if (turn.event) {
      const selected = turn.event.id === selectedId;
      const article = el("article", `conv-search__turn conv-search__turn--${turn.role}${selected ? " conv-search__turn--selected" : ""}`);
      article.append(el("div", "conv-search__turn-avatar", turn.role === "user" ? "You" : "AI"));
      const body = el("div", "conv-search__turn-body");
      const heading = el("div", "conv-search__turn-heading",
        el("span", null, turn.role === "user" ? "You" : "Assistant"),
        el("time", null, fmtTime(turn.event.timestamp)));
      const content = el("div", "conv-search__turn-content");
      const message = eventSummary(turn.event);
      if (selected) appendHighlighted(content, message, highlightQuery);
      else content.append(document.createTextNode(message));
      body.append(heading, content);
      article.append(body);
      article.addEventListener("click", () => onSelect(turn.event.id));
      if (selected) selectedNode = article;

      if (turn.activity.length) {
        const details = el("details", "conv-search__turn-tools");
        details.open = selectedInActivity;
        const counts = new Map();
        for (const event of turn.activity) counts.set(categoryOf(event), (counts.get(categoryOf(event)) || 0) + 1);
        const summary = el("summary", "conv-search__turn-tools-summary", `${turn.activity.length} work ${turn.activity.length === 1 ? "event" : "events"}`);
        for (const [category, count] of counts) summary.append(el("span", "conv-search__badge", `${CATEGORY[category].label} ${count}`));
        details.append(summary);
        for (const event of turn.activity) {
          const selected = event.id === selectedId;
          const row = el("button", `conv-search__turn-tool${selected ? " conv-search__turn-tool--selected" : ""}`);
          row.append(
            el("span", "conv-search__turn-tool-kind", CATEGORY[categoryOf(event)].label),
            el("span", "conv-search__turn-tool-title", eventTitle(event)),
            el("time", null, fmtTime(event.timestamp)),
          );
          const activitySummary = eventSummary(event).replace(/\s+/g, " ").slice(0, 220);
          if (activitySummary) {
            const text = el("span", "conv-search__turn-tool-summary");
            if (selected) appendHighlighted(text, activitySummary, highlightQuery);
            else text.append(document.createTextNode(activitySummary));
            row.append(text);
          }
          row.addEventListener("click", (clickEvent) => { clickEvent.stopPropagation(); onSelect(event.id); });
          details.append(row);
          if (selected) selectedNode = row;
        }
        body.append(details);
      }
      transcript.append(article);
      continue;
    }

    const details = el("details", "conv-search__orphan-tools");
    details.open = selectedInActivity;
    details.append(el("summary", "conv-search__turn-tools-summary", `${turn.activity.length} setup events`));
    for (const event of turn.activity) {
      const selected = event.id === selectedId;
      const row = el("button", `conv-search__turn-tool${selected ? " conv-search__turn-tool--selected" : ""}`,
        el("span", "conv-search__turn-tool-kind", CATEGORY[categoryOf(event)].label),
        el("span", "conv-search__turn-tool-title", eventTitle(event)));
      row.addEventListener("click", () => onSelect(event.id));
      details.append(row);
      if (selected) selectedNode = row;
    }
    transcript.append(details);
  }

  return { transcript, selectedNode };
}

function selectedConversationId(path) {
  const match = /^conversations\/([^/]+)$/.exec(path.replace(/^\/+|\/+$/g, ""));
  if (!match) return null;
  try { return decodeURIComponent(match[1]); } catch { return match[1]; }
}

function groupConversationHits(hits) {
  const groups = new Map();
  for (const hit of hits) {
    const conversationId = hit.conversation_id || hit.id;
    if (!conversationId) continue;
    const existing = groups.get(conversationId);
    if (existing) {
      existing.hits.push(hit);
      existing.matchCount += 1;
      if ((hit.rank ?? Infinity) < (existing.bestHit.rank ?? Infinity)) existing.bestHit = hit;
      continue;
    }
    groups.set(conversationId, {
      ...hit,
      conversation_id: conversationId,
      hits: [hit],
      bestHit: hit,
      matchCount: 1,
    });
  }
  return [...groups.values()];
}


// ─── Search page ────────────────────────────────────────────────────────────

function mountSearchPage(host, { container, navigate }) {
  let disposed = false;
  let searchTimer = null;
  let lastAbort = null;
  let facetsData = null;

  const state = {
    query: SEARCH_SESSION.query, model: "", status: "", tool: "", kind: "", role: "",
    limit: 60, offset: 0, total: 0,
    rawResults: [], results: [], loading: false, error: null,
  };

  const root = el("div", "conv-search__search-page");
  const statsSpan = el("span", "conv-search__stats");
  const input = el("input", "conv-search__input");
  input.type = "search";
  input.placeholder = "Search messages, commands, file edits, errors…";
  input.value = state.query;
  input.addEventListener("input", (e) => {
    state.query = e.target.value;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => doSearch(), 250);
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { clearTimeout(searchTimer); doSearch(); }
  });

  const searchBtn = el("button", "conv-search__btn", "Search");
  searchBtn.addEventListener("click", () => doSearch());

  const header = el("div", "conv-search__header");
  header.append(
    el("div", "conv-search__title-row",
      el("div", "conv-search__title", "Conversation Search"),
      statsSpan),
    el("div", "conv-search__bar", input, searchBtn),
  );

  const sidebar = el("div", "conv-search__sidebar");
  const resultsDiv = el("div", "conv-search__results");
  const body = el("div", "conv-search__body", sidebar, resultsDiv);
  root.append(header, body);
  container.append(root);

  function renderFacets() {
    sidebar.replaceChildren();
    if (!facetsData) return;
    const groups = [
      { label: "Model", key: "model", items: facetsData.models, active: state.model },
      { label: "Status", key: "status", items: facetsData.statuses.map(value => ({ value })), active: state.status },
      { label: "Participant", key: "role", items: [{ value: "user", label: "User" }, { value: "assistant", label: "Assistant" }], active: state.role },
      { label: "Event type", key: "kind", items: (facetsData.kinds || []).map(value => ({ value, label: value.replace(/Event$/, "") })), active: state.kind },
      { label: "Tool", key: "tool", items: facetsData.tools.map(value => ({ value })), active: state.tool },
    ];
    for (const g of groups) {
      const group = el("div", "conv-search__facet-group", el("div", "conv-search__facet-label", g.label));
      group.append(el("div", `conv-search__facet-item${g.active ? "" : " conv-search__facet-item--active"}`, `All ${g.label.toLowerCase()}`));
      group.lastChild.addEventListener("click", () => { state[g.key] = ""; doSearch(); });
      for (const item of g.items.slice(0, 15)) {
        const val = typeof item === "string" ? item : item.value;
        const label = typeof item === "object" ? item.label || val : val;
        const count = typeof item === "object" ? item.count : null;
        const itemEl = el("div", `conv-search__facet-item${g.active === val ? " conv-search__facet-item--active" : ""}`);
        itemEl.append(el("span", null, label || "(none)"));
        if (count != null) itemEl.append(el("span", "conv-search__facet-count", fmtNum(count)));
        itemEl.addEventListener("click", () => { state[g.key] = g.active === val ? "" : val; doSearch(); });
        group.append(itemEl);
      }
      sidebar.append(group);
    }
  }

  function renderResults() {
    resultsDiv.replaceChildren();
    if (state.error) {
      resultsDiv.append(el("div", "conv-search__error"));
      resultsDiv.lastChild.innerHTML = state.error;
      return;
    }
    if (state.loading) {
      resultsDiv.append(el("div", "conv-search__loading", "Searching…"));
      return;
    }
    if (!state.results.length) {
      resultsDiv.append(el("div", "conv-search__empty",
        state.query ? `No results for “${state.query}”` : "No conversations match these filters."));
      return;
    }

    const table = el("div", "conv-search__table");
    table.setAttribute("role", "table");
    const headerRow = el("div", "conv-search__table-row conv-search__table-row--header");
    headerRow.setAttribute("role", "row");
    for (const [label, numeric] of [["Updated ↓", false], ["Conversation", false], ["Status", false], ["Model", false], ["Messages", true], ["Events", true], ["Cost", true]]) {
      const cell = el("div", `conv-search__table-cell${numeric ? " conv-search__table-cell--numeric" : ""}`, label);
      cell.setAttribute("role", "columnheader");
      headerRow.append(cell);
    }
    table.append(headerRow);

    for (const group of state.results) {
      const hit = group.bestHit || group;
      const cid = group.conversation_id || group.id;
      const row = el("div", "conv-search__table-row conv-search__table-row--result");
      row.tabIndex = 0;
      row.setAttribute("role", "row");
      row.append(el("div", "conv-search__table-cell conv-search__table-cell--updated", fmtDate(hit.updated_at || hit.created_at || hit.timestamp)));

      const titleCell = el("div", "conv-search__table-cell");
      const title = el("div", "conv-search__table-title", hit.title || "(untitled)");
      if (group.matchCount > 1) title.append(" ", el("span", "conv-search__badge", `${group.matchCount} matches`));
      titleCell.append(title);
      if (hit.snippet) {
        const snippet = el("div", "conv-search__table-snippet");
        appendHighlighted(snippet, hit.snippet.replace(/[⟦⟧]/g, ""), state.query);
        titleCell.append(snippet);
      }
      row.append(titleCell);

      const statusCell = el("div", "conv-search__table-cell");
      if (hit.status) statusCell.append(el("span", `conv-search__badge conv-search__badge--${hit.status}`, hit.status));
      else statusCell.append("—");
      row.append(statusCell);
      row.append(el("div", "conv-search__table-cell conv-search__table-model", hit.model || "—"));
      const messages = Number(hit.n_user_msgs || 0) + Number(hit.n_assistant_msgs || 0);
      row.append(
        el("div", "conv-search__table-cell conv-search__table-cell--numeric", messages ? fmtNum(messages) : "—"),
        el("div", "conv-search__table-cell conv-search__table-cell--numeric", hit.n_events != null ? fmtNum(hit.n_events) : "—"),
        el("div", "conv-search__table-cell conv-search__table-cell--numeric", Number(hit.cost) > 0 ? `$${Number(hit.cost).toFixed(2)}` : "—"),
      );

      const openResult = () => {
        SEARCH_SESSION.query = state.query;
        SEARCH_SESSION.groups = state.results;
        SEARCH_SESSION.selectedHit = hit;
        navigate(`${ROOT_PATH}/conversations/${encodeURIComponent(cid)}`);
      };
      row.addEventListener("click", openResult);
      row.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") { event.preventDefault(); openResult(); }
      });
      table.append(row);
    }
    resultsDiv.append(table);

    if (state.rawResults.length < state.total) {
      const footer = el("div", "conv-search__results-footer");
      const more = el("button", "conv-search__btn conv-search__more",
        `Load more (${state.rawResults.length} of ${state.total})`);
      more.addEventListener("click", () => { state.offset += state.limit; doSearch(true); });
      footer.append(more);
      resultsDiv.append(footer);
    }
  }

  async function doSearch(append = false) {
    if (disposed) return;
    if (lastAbort) lastAbort.abort();
    const ctrl = new AbortController();
    lastAbort = ctrl;
    if (!append) state.offset = 0;
    state.loading = true;
    state.error = null;
    renderResults();
    try {
      const params = new URLSearchParams();
      if (state.query) params.set("q", state.query);
      if (state.model) params.set("model", state.model);
      if (state.status) params.set("status", state.status);
      if (state.tool) params.set("tool", state.tool);
      if (state.kind) params.set("kind", state.kind);
      if (state.role) params.set("role", state.role);
      params.set("limit", String(state.limit));
      params.set("offset", String(state.offset));
      const data = await searchApi(`/api/search?${params}`);
      if (disposed || ctrl.signal.aborted) return;
      const hits = data.hits || data.conversations || [];
      state.rawResults = append ? state.rawResults.concat(hits) : hits;
      state.results = groupConversationHits(state.rawResults);
      state.total = data.total || 0;
      state.loading = false;
      SEARCH_SESSION.query = state.query;
      SEARCH_SESSION.groups = state.results;
      statsSpan.textContent = state.query
        ? `${fmtNum(state.total)} matches · ${state.results.length} conversations loaded`
        : `${fmtNum(state.total)} conversations`;
      renderResults();
    } catch (err) {
      if (disposed || ctrl.signal.aborted) return;
      state.loading = false;
      state.error = `Search server unavailable at <code>${SEARCH_API}</code>. Is <code>server.py</code> running?`;
      renderResults();
    }
  }

  searchApi("/api/facets").then((data) => { if (!disposed) { facetsData = data; renderFacets(); } }).catch(() => {});
  searchApi("/api/stats").then((data) => { if (!disposed) statsSpan.textContent = `${fmtNum(data.conversations)} conversations · ${fmtNum(data.events)} events indexed`; }).catch(() => {});
  doSearch();

  return () => {
    disposed = true;
    clearTimeout(searchTimer);
    if (lastAbort) lastAbort.abort();
    root.remove();
  };
}

// ─── Trace page ─────────────────────────────────────────────────────────────

function mountTracePage(host, { container, path, navigate }) {
  let disposed = false;
  const convId = selectedConversationId(path);
  const state = {
    events: [], loading: true, error: null,
    eventQuery: "", viewMode: "conversation", categoryFilter: "activity",
    selectedEventId: null, convMeta: null,
    hasScrolledToMatch: false,
  };

  const root = el("div", "conv-search__trace-page");
  const sidebar = el("aside", "conv-search__trace-sidebar");
  const backBtn = el("button", "conv-search__trace-back", "← Search conversations");
  backBtn.addEventListener("click", () => navigate(ROOT_PATH));
  sidebar.append(backBtn);

  if (SEARCH_SESSION.groups.length) {
    sidebar.append(el("div", "conv-search__trace-results-label",
      SEARCH_SESSION.query ? `Results for “${SEARCH_SESSION.query}”` : "Recent conversations"));
    for (const group of SEARCH_SESSION.groups) {
      const hit = group.bestHit || group;
      const cid = group.conversation_id || group.id;
      const result = el("button", `conv-search__trace-result${cid === convId ? " conv-search__trace-result--active" : ""}`);
      result.append(el("span", "conv-search__trace-result-title", hit.title || "(untitled)"));
      const resultMeta = el("span", "conv-search__trace-result-meta");
      resultMeta.append(el("span", null, hit.status || "conversation"));
      resultMeta.append(el("span", null, group.matchCount > 1 ? `${group.matchCount} matches` : fmtDate(hit.timestamp || hit.updated_at)));
      result.append(resultMeta);
      if (hit.snippet) result.append(el("span", "conv-search__trace-result-snippet", hit.snippet.replace(/[⟦⟧]/g, "")));
      result.addEventListener("click", () => {
        SEARCH_SESSION.selectedHit = hit;
        navigate(`${ROOT_PATH}/conversations/${encodeURIComponent(cid)}`);
      });
      sidebar.append(result);
    }
  }

  const main = el("main", "conv-search__trace-main");
  const inspectorPane = el("aside", "conv-search__inspector-pane");
  root.append(sidebar, main, inspectorPane);
  container.append(root);

  function paint() {
    if (disposed) return;
    main.replaceChildren();
    inspectorPane.replaceChildren();

    if (state.loading) {
      main.append(el("div", "conv-search__notice", "Loading conversation trace…"));
      return;
    }
    if (state.error) {
      main.append(el("div", "conv-search__error", state.error));
      return;
    }
    if (!state.events.length) {
      main.append(el("div", "conv-search__notice", "This conversation has no persisted events."));
      return;
    }

    // Header
    const header = el("div", "conv-search__trace-header");
    header.append(
      el("p", "conv-search__trace-eyebrow", "Conversation trace"),
      el("h2", "conv-search__trace-title", state.convMeta?.title || convId),
    );
    const meta = el("div", "conv-search__trace-meta");
    if (state.convMeta?.execution_status || state.convMeta?.status)
      meta.append(el("span", null, state.convMeta?.execution_status || state.convMeta?.status));
    meta.append(el("span", null, convId));
    if (state.convMeta?.current_model_name || state.convMeta?.current_model_id)
      meta.append(el("span", null, state.convMeta?.current_model_name || state.convMeta?.current_model_id));
    header.append(meta);
    main.append(header);

    // Category counts
    const categories = new Map();
    for (const e of state.events) categories.set(categoryOf(e), (categories.get(categoryOf(e)) ?? 0) + 1);

    // Toolbar
    const toolbar = el("div", "conv-search__trace-toolbar");
    const searchInput = el("input", "conv-search__input");
    searchInput.type = "search";
    searchInput.placeholder = "Filter transcript · press Enter";
    searchInput.value = state.eventQuery;
    searchInput.addEventListener("input", () => { state.eventQuery = searchInput.value; });
    searchInput.addEventListener("keydown", (event) => { if (event.key === "Enter") paint(); });
    searchInput.addEventListener("change", paint);
    toolbar.append(searchInput);

    const messageCount = categories.get("message") || 0;
    const conversationBtn = el("button", `conv-search__filter-btn${state.viewMode === "conversation" ? " conv-search__filter-btn--active" : ""}`,
      `Conversation ${messageCount}`);
    conversationBtn.style.setProperty("--filter-color", "var(--cs-accent)");
    conversationBtn.addEventListener("click", () => { state.viewMode = "conversation"; paint(); });
    toolbar.append(conversationBtn);

    const activityCount = state.events.filter((event) => !["state", "other"].includes(categoryOf(event))).length;
    const activityBtn = el("button", `conv-search__filter-btn${state.viewMode === "trace" && state.categoryFilter === "activity" ? " conv-search__filter-btn--active" : ""}`,
      `Raw trace ${activityCount}`);
    activityBtn.style.setProperty("--filter-color", "var(--cs-tool)");
    activityBtn.addEventListener("click", () => { state.viewMode = "trace"; state.categoryFilter = "activity"; paint(); });
    toolbar.append(activityBtn);

    for (const [key, def] of Object.entries(CATEGORY)) {
      if (!categories.has(key)) continue;
      const btn = el("button", `conv-search__filter-btn${state.viewMode === "trace" && state.categoryFilter === key ? " conv-search__filter-btn--active" : ""}`,
        `${def.label} ${categories.get(key) ?? 0}`);
      btn.style.setProperty("--filter-color", def.color);
      btn.addEventListener("click", () => { state.viewMode = "trace"; state.categoryFilter = key; paint(); });
      toolbar.append(btn);
    }
    main.append(toolbar);

    // Filtered events: routine state and system events stay out of the default transcript.
    const query = state.eventQuery.trim().toLowerCase();
    const visible = state.events.filter((event) => {
      const category = categoryOf(event);
      const categoryMatches = state.viewMode === "conversation" || state.categoryFilter === "activity"
        ? !["state", "other"].includes(category)
        : category === state.categoryFilter;
      return categoryMatches && (!query || eventSummary(event).toLowerCase().includes(query) || eventTitle(event).toLowerCase().includes(query));
    });

    if (!visible.length) {
      main.append(el("div", "conv-search__notice", "No events match these filters."));
      return;
    }

    const selected = visible.find((e) => e.id === state.selectedEventId) ?? visible[0];
    state.selectedEventId = selected?.id ?? null;

    let selectedNode = null;
    if (state.viewMode === "conversation") {
      const rendered = renderConversationTranscript(
        visible,
        state.selectedEventId,
        state.eventQuery || SEARCH_SESSION.query,
        (eventId) => { state.selectedEventId = eventId; paint(); },
      );
      selectedNode = rendered.selectedNode;
      main.append(rendered.transcript);
    } else {
      const MAX_VISIBLE = 500;
      const truncated = visible.length > MAX_VISIBLE;
      let displayed = truncated ? visible.slice(0, MAX_VISIBLE) : visible;
      if (truncated && state.selectedEventId && !displayed.some((event) => event.id === state.selectedEventId)) {
        const selectedIndex = visible.findIndex((event) => event.id === state.selectedEventId);
        const start = Math.max(0, selectedIndex - Math.floor(MAX_VISIBLE / 2));
        displayed = visible.slice(start, start + MAX_VISIBLE);
      }
      const timeline = el("div", "conv-search__timeline");
      for (const event of displayed) {
        const cat = categoryOf(event);
        const def = CATEGORY[cat];
        const eventEl = el("div", `conv-search__event${event.id === state.selectedEventId ? " conv-search__event--selected" : ""}`);
        eventEl.style.setProperty("--event-color", def.color);
        if (event.id === state.selectedEventId) selectedNode = eventEl;
        eventEl.append(el("span", "conv-search__event-mark", def.mark));
        const content = el("div", "conv-search__event-content");
        const top = el("div", "conv-search__event-top");
        const name = el("span", "conv-search__event-name");
        name.append(el("span", "conv-search__event-cat", def.label), document.createTextNode(eventTitle(event)));
        top.append(name, el("time", "conv-search__event-time", fmtTime(event.timestamp)));
        content.append(top);
        const summary = eventSummary(event).replace(/\s+/g, " ").slice(0, 280);
        if (summary) content.append(el("div", "conv-search__event-summary", summary));
        const badges = el("div", "conv-search__event-badges");
        if (event.source) badges.append(el("span", "conv-search__badge", event.source));
        if (event.tool_name) badges.append(el("span", "conv-search__badge", event.tool_name));
        const obs = record(event.observation);
        if (typeof obs?.exit_code === "number") badges.append(el("span", "conv-search__badge", `exit ${obs.exit_code}`));
        if (badges.children.length) content.append(badges);
        eventEl.append(content);
        eventEl.addEventListener("click", () => { state.selectedEventId = event.id; paint(); });
        timeline.append(eventEl);
      }
      main.append(timeline);
      if (truncated) main.append(el("div", "conv-search__notice", `Showing ${MAX_VISIBLE} of ${visible.length} events around the selected match.`));
    }

    if (!state.hasScrolledToMatch && selectedNode && SEARCH_SESSION.selectedHit?.conversation_id === convId) {
      state.hasScrolledToMatch = true;
      requestAnimationFrame(() => selectedNode.scrollIntoView({ block: "center", behavior: "smooth" }));
    }

    // Selected event inspector
    if (selected) {
      const inspector = el("div", "conv-search__inspector");
      inspector.append(
        el("p", "conv-search__inspector-kicker", "Selected event"),
        el("h3", "conv-search__inspector-title", eventTitle(selected)),
      );
      const eventMeta = el("div", "conv-search__trace-meta");
      eventMeta.append(
        el("span", null, CATEGORY[categoryOf(selected)].label),
        el("span", null, fmtTime(selected.timestamp)),
      );
      if (selected.source) eventMeta.append(el("span", null, selected.source));
      inspector.append(eventMeta);

      const sections = eventDetails(selected);
      for (const [label, content] of sections) {
        const sec = el("div", "conv-search__inspector-section");
        sec.append(el("div", "conv-search__inspector-label", label));
        sec.append(el("div", "conv-search__inspector-content", content));
        inspector.append(sec);
      }
      if (!sections.length) inspector.append(el("div", "conv-search__inspector-empty", "This event has no additional displayable content."));
      inspectorPane.append(inspector);
    } else {
      inspectorPane.append(el("div", "conv-search__inspector-empty", "Select an event to inspect its complete content and metadata."));
    }
  }

  // Load events
  host.agentServer.request({ path: `/api/conversations/${encodeURIComponent(convId)}` })
    .then((conv) => { if (!disposed) { state.convMeta = conv; paint(); } })
    .catch(() => {});

  fetchAllEvents(host, convId)
    .then((events) => {
      if (disposed) return;
      state.events = events.sort((a, b) => new Date(a.timestamp || 0) - new Date(b.timestamp || 0));
      const hit = SEARCH_SESSION.selectedHit;
      if (hit?.conversation_id === convId) {
        let matched = state.events.find((event) =>
          event.timestamp === hit.timestamp &&
          (!hit.kind || kindOf(event) === hit.kind) &&
          (!hit.tool_name || event.tool_name === hit.tool_name));
        if (!matched) {
          matched = {
            ...hit,
            id: `indexed-match-${hit.seq ?? hit.timestamp}`,
            source: hit.role || "index",
            indexedMatch: true,
          };
          state.events.push(matched);
          state.events.sort((a, b) => new Date(a.timestamp || 0) - new Date(b.timestamp || 0));
        }
        state.selectedEventId = matched.id;
      }
      state.loading = false;
      paint();
    })
    .catch((err) => {
      if (disposed) return;
      state.loading = false;
      state.error = `Unable to load conversation events: ${err.message}`;
      paint();
    });

  return () => { disposed = true; root.remove(); };
}

// ─── Activate ───────────────────────────────────────────────────────────────

export function activate(host) {
  if (host?.apiVersion !== "1") {
    throw new Error("Conversation Search requires Agent Canvas host API 1.");
  }

  return host.registerPage("search", (context) => {
    const style = el("style");
    style.textContent = STYLE;

    const shell = el("section", "conv-search");
    shell.setAttribute("aria-label", "Conversation Search");
    context.container.append(style, shell);

    const pageContext = { ...context, container: shell };
    const convId = selectedConversationId(context.path);
    const disposePage = convId
      ? mountTracePage(host, pageContext)
      : mountSearchPage(host, pageContext);

    return () => {
      disposePage?.();
      style.remove();
      shell.remove();
    };
  });
}
