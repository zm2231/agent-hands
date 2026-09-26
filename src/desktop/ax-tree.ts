const FIELDS = ["Description", "Help", "Value", "ID", "Secondary Actions", "Details", "URL"];
const FIELD_RE = new RegExp(`(, | )(${FIELDS.join("|")}): `, "g");
const ROLE_PREFIX_RE = /^[a-z]+(?: [a-z]+)*(?: \([^)]*\))?$/;
const FLAGS = new Set(["disabled", "settable", "selectable", "selected", "expanded", "float"]);
const ROLES = [
  "button", "toggle button", "radio button", "check box", "pop up button", "menu button", "sort button",
  "close button", "minimize button", "zoom button", "full screen button", "switch", "slider", "value indicator",
  "text", "text field", "search text field", "secure text field", "text entry area", "combo box", "row", "cell",
  "column", "table", "outline", "list", "container", "group", "split group", "splitter", "scroll area",
  "scroll bar", "tab", "tab group", "toolbar", "menu bar", "menu bar item", "menu", "menu item",
  "standard window", "dialog", "sheet", "image", "link", "heading", "page", "gallery", "web area",
  "progress indicator", "level indicator", "incrementor", "disclosure triangle", "color well", "unknown",
].sort((a, b) => b.length - a.length);
const INVISIBLE_RE = /[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g;
const MAX_LINE = 160;
const MAX_CANDIDATES = 10;
export const FIND_LIMIT = 20;

export interface AxNode {
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

export function parseAxTree(text: string): AxNode[] {
  const nodes: AxNode[] = [];
  const stack: AxNode[] = [];
  let last: AxNode | null = null;
  for (const raw of text.split("\n")) {
    const m = /^(\t*)(\d+) (.*)$/.exec(raw);
    if (!m) {
      if (last && raw && !raw.startsWith("</")) last.line += `\n${raw}`;
      continue;
    }
    const depth = m[1].length;
    while (stack.length && stack[stack.length - 1].depth >= depth) stack.pop();
    last = { index: m[2], depth, line: m[3], body: "", head: "", fields: {}, parent: stack[stack.length - 1] ?? null };
    nodes.push(last);
    stack.push(last);
  }
  for (const node of nodes) splitFields(node);
  return nodes;
}

function splitFields(node: AxNode): void {
  const text = node.line.replace(INVISIBLE_RE, "");
  const marks: RegExpExecArray[] = [];
  for (const mark of text.matchAll(FIELD_RE)) {
    const commaDelimited = mark[1] === ", ";
    if (marks.length ? commaDelimited : commaDelimited || ROLE_PREFIX_RE.test(text.slice(0, mark.index))) marks.push(mark);
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

export function resolveTarget(text: string, target: Target): Resolution {
  const nodes = parseAxTree(text);
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
  const nodes = parseAxTree(text);
  const matches = nodes.filter((n) =>
    [n.head, n.fields.Description, n.fields.Value, n.fields.ID, n.fields.Help]
      .some((s) => s && norm(s).includes(want))
  );
  const header = `find "${query}": ${matches.length} of ${nodes.length} elements`;
  if (!matches.length) return header;
  const shown = matches.slice(0, limit).map((n) => describe(n));
  const more = matches.length > shown.length ? `\n…${matches.length - shown.length} more; narrow the query` : "";
  return `${header}\n${shown.join("\n")}${more}`;
}
