const FIELDS = ["Description", "Help", "Value", "ID", "Secondary Actions", "Details", "URL"];
const FIELD_RE = new RegExp(`(^|, | )(${FIELDS.join("|")}): `, "g");
const ROLE_PREFIX_RE = /^[a-z]+(?: [a-z]+)*(?: \([^)]*\))?$/;
const FLAGS = new Set(["disabled", "settable", "selectable", "selected", "expanded", "collapsed", "float", "boolean"]);
const ROLES = [
  "button", "toggle button", "radio button", "check box", "pop up button", "menu button", "sort button",
  "close button", "minimize button", "zoom button", "full screen button", "switch", "slider", "value indicator",
  "text", "text field", "search text field", "secure text field", "text entry area", "combo box", "row", "cell",
  "column", "table", "outline", "list", "container", "group", "split group", "splitter", "scroll area",
  "scroll bar", "tab", "tab group", "toolbar", "menu bar", "menu bar item", "menu", "menu item",
  "standard window", "dialog", "sheet", "image", "link", "heading", "page", "gallery", "web area",
  "progress indicator", "level indicator", "incrementor", "disclosure triangle", "color well", "unknown",
  "HTML content", "bookmark button", "column header",
].sort((a, b) => b.length - a.length);
const INVISIBLE_RE = /[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g;
const MAX_LINE = 160;
const MAX_CANDIDATES = 10;
export const FIND_LIMIT = 20;
export const COMPACT_THRESHOLD = 8000;
export const COMPACT_BUDGET = 5000;
const SUMMARY_CHARS = 100;
const ELEMENT_RE = /^([+~])?(\t*)(\d+) (.*)$/;
const DIFF_RE = /^(The following is a (cumulative )?diff from|There has been no change in the accessibility tree)/;
const TRAILER_RE = /^(Selected:$|The focused UI element is |Note: Pay special attention)/;

export interface AxNode {
  change?: "+" | "~";
  index: string;
  depth: number;
  line: string;
  body: string;
  head: string;
  fields: Record<string, string>;
  parent: AxNode | null;
}

export interface Target {
  role?: string;
  name: string;
  match: "exact" | "contains";
}

export interface AxTree {
  header: string[];
  nodes: AxNode[];
  trailer: string[];
  diff: boolean;
}

export function readAxTree(text: string): AxTree {
  const lines = text.split("\n");
  const header: string[] = [];
  const nodes: AxNode[] = [];
  const stack: AxNode[] = [];
  let last: AxNode | null = null;
  const open = lines.indexOf("<app_state>");
  let i = 0;
  for (; i <= open; i++) header.push(lines[i]);
  let end = lines.indexOf("</app_state>", i);
  if (end === -1) end = lines.length;
  const firstSeen = new Set<string>();
  let lastNewElement = -1;
  for (let j = i; j < end; j++) {
    const m = ELEMENT_RE.exec(lines[j]);
    if (m && !firstSeen.has(m[3])) {
      firstSeen.add(m[3]);
      lastNewElement = j;
    }
  }
  for (; i < end; i++) {
    const raw = lines[i];
    if (i > lastNewElement && TRAILER_RE.test(raw)) break;
    const m = ELEMENT_RE.exec(raw);
    if (!m) {
      if (last) last.line += `\n${raw}`;
      else header.push(raw);
      continue;
    }
    const depth = m[2].length;
    while (stack.length && stack[stack.length - 1].depth >= depth) stack.pop();
    last = { change: m[1] as AxNode["change"], index: m[3], depth, line: m[4], body: "", head: "", fields: {}, parent: stack[stack.length - 1] ?? null };
    nodes.push(last);
    stack.push(last);
  }
  while (last && i > 0 && lines[i - 1] === "" && last.line.endsWith("\n")) {
    last.line = last.line.slice(0, -1);
    i--;
  }
  for (const node of nodes) splitFields(node);
  return { header, nodes, trailer: lines.slice(i), diff: header.some((h) => DIFF_RE.test(h)) };
}

export function parseAxTree(text: string): AxNode[] {
  return readAxTree(text).nodes;
}

function splitFields(node: AxNode): void {
  const text = node.line.replace(INVISIBLE_RE, "");
  const marks: RegExpExecArray[] = [];
  for (const mark of text.matchAll(FIELD_RE)) {
    const commaDelimited = mark[1] === ", ";
    if (marks.length ? commaDelimited : commaDelimited || mark.index === 0 || isRolePrefix(text.slice(0, mark.index))) marks.push(mark);
  }
  node.body = clean(marks.length ? text.slice(0, marks[0].index) : text);
  const { role, name } = splitHead(node.body);
  node.head = [role, name].filter(Boolean).join(" ");
  marks.forEach((mark, i) => {
    const start = mark.index! + mark[0].length;
    const end = i + 1 < marks.length ? marks[i + 1].index! : text.length;
    node.fields[mark[2]] = clean(text.slice(start, end));
  });
}

function isRolePrefix(text: string): boolean {
  if (ROLE_PREFIX_RE.test(text)) return true;
  const role = ROLES.find((r) => text === r || text.startsWith(`${r} (`));
  return role !== undefined && (text === role || stripFlags(text.slice(role.length + 1)) === "");
}

function splitHead(body: string, role = ROLES.find((r) => body === r || body.startsWith(`${r} `))): { role?: string; name: string } {
  if (role === undefined) return { name: stripFlags(body) };
  if (body !== role && !body.startsWith(`${role} `)) return { name: "" };
  return { role, name: stripFlags(body.slice(role.length).trim()) };
}

function stripFlags(text: string): string {
  const m = /^\(([^)]*)\)(?: |$)/.exec(text);
  if (!m || !m[1].split(", ").every((flag) => FLAGS.has(flag))) return text;
  return text.slice(m[0].length);
}

function clean(s: string): string {
  return s.replace(INVISIBLE_RE, "").replace(/\s+/g, " ").trim();
}

function norm(s: string): string {
  return clean(s).toLowerCase();
}

export function parseTarget(value: unknown): Target {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("target must be an object with a name.");
  }
  const { role, name, match, ...rest } = value as Record<string, unknown>;
  const unknown = Object.keys(rest);
  if (unknown.length) throw new Error(`Unknown target field(s): ${unknown.join(", ")}`);
  if (typeof name !== "string" || !clean(name)) throw new Error("target.name must be a non-empty string.");
  if (role !== undefined && (typeof role !== "string" || !clean(role))) throw new Error("target.role must be a non-empty string.");
  if (match !== undefined && match !== "exact" && match !== "contains") throw new Error('target.match must be "exact" or "contains".');
  return { role: role === undefined ? undefined : clean(role as string), name: clean(name), match: match ?? "exact" };
}

function labels(node: AxNode, role: string | undefined): string[] | null {
  let name: string;
  if (role) {
    const bodyRole = node.body.slice(0, role.length);
    if (norm(bodyRole) !== norm(role) || (node.body.length > role.length && node.body[role.length] !== " ")) return null;
    name = splitHead(node.body, bodyRole).name;
  } else {
    name = splitHead(node.body).name;
  }
  return [name, node.fields.Description, node.fields.Value, node.fields.ID]
    .filter((s): s is string => !!s)
    .map(norm);
}

export function matchesTarget(node: AxNode, target: Target): boolean {
  const candidates = labels(node, target.role);
  if (!candidates) return false;
  const want = norm(target.name);
  return target.match === "contains" ? candidates.some((c) => c.includes(want)) : candidates.includes(want);
}

function label(node: AxNode): string {
  const text = node.head || node.fields.Description || node.fields.ID || node.fields.Value || "";
  return text.length > 40 ? `${text.slice(0, 40)}…` : text;
}

export function path(node: AxNode): string {
  const parts: string[] = [];
  for (let p = node.parent; p?.parent; p = p.parent) {
    const text = label(p);
    if (text) parts.unshift(text);
  }
  return parts.join(" > ");
}

export function describe(node: AxNode, withPath = true): string {
  const first = node.line.split("\n")[0];
  const line = first.length > MAX_LINE ? `${first.slice(0, MAX_LINE)}…` : first;
  const where = withPath ? path(node) : "";
  return where ? `${node.index} ${line}  [${where}]` : `${node.index} ${line}`;
}

function describeTarget(target: Target): string {
  const role = target.role ? `${target.role} ` : "";
  return `${role}"${target.name}"${target.match === "contains" ? " (contains)" : ""}`;
}

export type Resolution = { node: AxNode } | { error: string };

const DIFF_TARGET_ERROR =
  "The app returned only the elements that changed since an earlier read, so the target cannot be checked against every element; " +
  "nothing was done. This happens while an app's content keeps changing. Use element_index from get_app_state.";

export function resolveTarget(text: string, target: Target): Resolution {
  const { nodes, diff } = readAxTree(text);
  if (diff) return { error: DIFF_TARGET_ERROR };
  const matches = nodes.filter((n) => matchesTarget(n, target));
  if (matches.length === 1) return { node: matches[0] };
  if (matches.length > 1) {
    const shown = matches.slice(0, MAX_CANDIDATES).map((n) => describe(n));
    const more = matches.length > shown.length ? `\n…and ${matches.length - shown.length} more` : "";
    return { error: `${matches.length} elements match ${describeTarget(target)}; nothing was done. Use element_index or a more specific target:\n${shown.join("\n")}${more}` };
  }
  const near = nodes.filter((n) => matchesTarget(n, { name: target.name, match: "contains" })).slice(0, 5).map((n) => describe(n));
  const hint = near.length ? `\nSimilar elements:\n${near.join("\n")}` : "";
  return { error: `No element matches ${describeTarget(target)}; nothing was done.${hint}` };
}

export function findInTree(text: string, query: string, limit = FIND_LIMIT): string {
  const want = norm(query);
  const { nodes, diff } = readAxTree(text);
  const matches = nodes.filter((n) =>
    [n.head, n.fields.Description, n.fields.Value, n.fields.ID, n.fields.Help]
      .some((s) => s && norm(s).includes(want))
  );
  const header = diff
    ? `find "${query}": ${matches.length} of ${nodes.length} changed elements (the app returned only what changed since an earlier read)`
    : `find "${query}": ${matches.length} of ${nodes.length} elements`;
  if (!matches.length) return header;
  const shown = matches.slice(0, limit).map((n) => describe(n));
  const more = matches.length > shown.length ? `\n…${matches.length - shown.length} more; narrow the query` : "";
  return `${header}\n${shown.join("\n")}${more}`;
}

function summaryName(node: AxNode): string {
  const text = splitHead(node.body).name || node.fields.Description || node.fields.ID || "";
  return text.length > 40 ? `${text.slice(0, 40)}…` : text;
}

export interface Compacted { text: string; shown: number; total: number }

export function compactTree(text: string, budget = COMPACT_BUDGET, threshold = COMPACT_THRESHOLD): Compacted | null {
  if (text.length <= threshold) return null;
  const tree = readAxTree(text);
  const nodes = tree.nodes;
  if (tree.diff || !nodes.length) return null;
  const roots = nodes.filter((n) => !n.parent);
  const children = new Map<AxNode, AxNode[]>(nodes.map((n) => [n, []]));
  for (const n of nodes) if (n.parent) children.get(n.parent)!.push(n);
  const render = (n: AxNode) => `${n.change ?? ""}${"\t".repeat(n.depth)}${n.index} ${n.line}`;

  const select = (limit: number) => {
    const shown = new Set<AxNode>();
    const queue = [...roots];
    let used = 0;
    for (let q = 0; q < queue.length; q++) {
      const n = queue[q];
      const cost = render(n).length + 1;
      if (used + cost > limit) continue;
      shown.add(n);
      used += cost;
      for (const c of children.get(n)!) queue.push(c);
    }
    return shown;
  };

  const layout = (shown: Set<AxNode>) => {
    const out: string[] = [];
    const summary = (siblings: AxNode[], depth: number) => {
      const hidden = siblings.filter((n) => !shown.has(n));
      if (!hidden.length) return null;
      for (let h = 0; h < hidden.length; h++) for (const c of children.get(hidden[h])!) hidden.push(c);
      const names: string[] = [];
      let length = 0;
      for (const n of hidden) {
        const name = summaryName(n);
        if (!name || names.includes(name)) continue;
        if (length + name.length > SUMMARY_CHARS) { names.push("…"); break; }
        names.push(name);
        length += name.length + 2;
      }
      return `${"\t".repeat(depth)}… ${hidden.length} more${names.length ? `: ${names.join(", ")}` : ""}`;
    };
    const stack: Array<AxNode | string> = [];
    const rootSummary = summary(roots, roots[0].depth);
    if (rootSummary) stack.push(rootSummary);
    for (let r = roots.length - 1; r >= 0; r--) if (shown.has(roots[r])) stack.push(roots[r]);
    while (stack.length) {
      const item = stack.pop()!;
      if (typeof item === "string") { out.push(item); continue; }
      out.push(render(item));
      const kids = children.get(item)!;
      const kidSummary = summary(kids, item.depth + 1);
      if (kidSummary) stack.push(kidSummary);
      for (let k = kids.length - 1; k >= 0; k--) if (shown.has(kids[k])) stack.push(kids[k]);
    }
    return out;
  };

  const measure = (lines: string[]) => lines.reduce((sum, line) => sum + line.length + 1, 0);
  let shown = select(budget);
  let out = layout(shown);
  if (measure(out) > budget) {
    let low = 0;
    let high = budget;
    shown = select(0);
    out = layout(shown);
    while (high - low > 1) {
      const mid = Math.floor((low + high) / 2);
      const trialShown = select(mid);
      const trial = layout(trialShown);
      if (measure(trial) <= budget) {
        low = mid;
        shown = trialShown;
        out = trial;
      } else {
        high = mid;
      }
    }
  }
  if (shown.size === nodes.length) return null;
  return { text: [...tree.header, ...out, ...tree.trailer].join("\n"), shown: shown.size, total: nodes.length };
}
