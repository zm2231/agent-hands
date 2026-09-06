// Snapshot: structured, bounded page view from the accessibility tree.

import type { CDPClient } from "./cdp/types.js";

const SNAPSHOT_LIMITS: Record<string, number> = {
  short: 60,
  medium: 140,
  long: 300,
};

const OUTPUT_BUDGET_BYTES = 38_000;
const TEXT_PIECE_LEN = 700;
const FIELD_CAPS = {
  title: 1000,
  url: 8000,
  pattern: 2000,
  elementName: 2000,
  elementValue: 4000,
  role: 128,
};

const INTERACTIVE_ROLES = new Set([
  "button", "checkbox", "combobox", "link", "listbox", "menuitem",
  "option", "menuitemcheckbox", "menuitemradio", "radio", "searchbox",
  "slider", "spinbutton", "switch", "tab", "textbox", "treeitem",
]);

const SKIP_ROLES = new Set(["none", "generic", "InlineTextBox"]);

export interface ContentLine {
  line: number;
  text: string;
  element_id?: number;
}

export interface SnapshotElement {
  id: number;
  role: string;
  name?: string;
  value?: string;
}

export interface SnapshotResult {
  ref_id: string;
  title: string;
  url: string;
  lineno: number;
  content: ContentLine[];
  elements: SnapshotElement[];
  pattern?: string;
  truncated?: boolean;
  next_lineno?: number;
}

function cap(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) : s;
}

export async function takeSnapshot(
  cdp: CDPClient,
  sessionId: string,
  refId: string,
  elementRefs: Map<number, number>,
  options: {
    pattern?: string;
    lineno?: number;
    responseLength?: string;
  } = {}
): Promise<SnapshotResult> {
  const lineno = Math.max(options.lineno ?? 1, 1);
  const limit = SNAPSHOT_LIMITS[options.responseLength ?? "medium"] ?? 140;

  // Clear element refs.
  elementRefs.clear();
  let nextElementId = 1;

  // Get page title and url.
  let title = "";
  let url = "";
  try {
    const evalResult = await cdp.send("Runtime.evaluate", {
      expression: "({title: document.title, url: location.href})",
      returnByValue: true,
    }, sessionId);
    const value = (evalResult.result as any)?.value;
    if (value) {
      title = cap(String(value.title ?? ""), FIELD_CAPS.title);
      url = cap(String(value.url ?? ""), FIELD_CAPS.url);
    }
  } catch {
    // Non-fatal.
  }

  // Get accessibility tree.
  const axResult = await cdp.send("Accessibility.getFullAXTree", {}, sessionId);
  const nodes = (axResult.nodes as any[]) ?? [];

  // Build lines from the tree.
  const allLines: Array<{ text: string; elementId?: number }> = [];

  for (const node of nodes) {
    const role = String(node.role?.value ?? "");
    const name = String(node.name?.value ?? "");
    const value = String(node.value?.value ?? "");
    const backendDOMNodeId = node.backendDOMNodeId as number | undefined;

    if (SKIP_ROLES.has(role)) continue;
    if (!name && !value && role !== "heading" && role !== "image") continue;

    if (role === "StaticText") {
      // Coalesce into previous text.
      const text = cap(name || value, TEXT_PIECE_LEN);
      if (text) {
        if (allLines.length > 0 && !allLines[allLines.length - 1].elementId) {
          const prev = allLines[allLines.length - 1];
          if (prev.text.length + text.length <= TEXT_PIECE_LEN) {
            prev.text += " " + text;
            continue;
          }
        }
        allLines.push({ text });
      }
      continue;
    }

    if (role === "heading") {
      allLines.push({ text: `## ${cap(name, FIELD_CAPS.elementName)}` });
      continue;
    }

    if (role === "image") {
      allLines.push({ text: `[image: ${cap(name || "unnamed", FIELD_CAPS.elementName)}]` });
      continue;
    }

    if (INTERACTIVE_ROLES.has(role) && backendDOMNodeId != null) {
      const id = nextElementId++;
      // Element ref stored temporarily; pruned after windowing to only include visible elements.
      elementRefs.set(id, backendDOMNodeId);
      const parts = [`[${id}]`, cap(role, FIELD_CAPS.role)];
      if (name) parts.push(cap(name, FIELD_CAPS.elementName));
      if (value) parts.push(`= ${cap(value, FIELD_CAPS.elementValue)}`);
      allLines.push({ text: parts.join(" "), elementId: id });
      continue;
    }

    // Other roles with content.
    if (name || value) {
      const text = name ? cap(name, FIELD_CAPS.elementName) : cap(value, FIELD_CAPS.elementValue);
      // Split long text.
      for (let i = 0; i < text.length; i += TEXT_PIECE_LEN) {
        allLines.push({ text: text.slice(i, i + TEXT_PIECE_LEN) });
      }
    }
  }

  // Filter by pattern.
  let filtered = allLines;
  if (options.pattern) {
    const lower = options.pattern.toLowerCase();
    filtered = allLines.filter((l) => l.text.toLowerCase().includes(lower));
  }

  // Apply line window.
  const startIdx = lineno - 1;
  const windowed = filtered.slice(startIdx, startIdx + limit);
  const hasMore = startIdx + limit < filtered.length;

  // Build content lines.
  const content: ContentLine[] = [];
  const usedElementIds = new Set<number>();

  for (let i = 0; i < windowed.length; i++) {
    const item = windowed[i];
    const cl: ContentLine = {
      line: startIdx + i + 1,
      text: item.text,
    };
    if (item.elementId != null) {
      cl.element_id = item.elementId;
      usedElementIds.add(item.elementId);
    }
    content.push(cl);
  }

  // Build elements array (only those referenced by included lines).
  const elements: SnapshotElement[] = [];
  for (const [id, backendNodeId] of elementRefs) {
    if (!usedElementIds.has(id)) continue;
    // Find the node info.
    const node = nodes.find((n: any) => n.backendDOMNodeId === backendNodeId);
    const el: SnapshotElement = {
      id,
      role: cap(String(node?.role?.value ?? ""), FIELD_CAPS.role),
    };
    const name = node?.name?.value ? cap(String(node.name.value), FIELD_CAPS.elementName) : undefined;
    const value = node?.value?.value ? cap(String(node.value.value), FIELD_CAPS.elementValue) : undefined;
    if (name) el.name = name;
    if (value) el.value = value;
    elements.push(el);
  }

  // Byte-truncate metadata fields by their JSON-serialized size (accounts for escaping).
  function jsonByteCap(s: string, maxJsonBytes: number): string {
    if (Buffer.byteLength(JSON.stringify(s), "utf8") <= maxJsonBytes) return s;
    let lo = 0;
    let hi = s.length;
    while (lo < hi) {
      const mid = Math.floor((lo + hi + 1) / 2);
      if (Buffer.byteLength(JSON.stringify(s.slice(0, mid)), "utf8") <= maxJsonBytes) lo = mid;
      else hi = mid - 1;
    }
    return s.slice(0, lo);
  }

  // Reserve ~200 bytes for the envelope keys, then divide the rest among metadata.
  const ENVELOPE_RESERVE = 200;
  const META_BUDGET = OUTPUT_BUDGET_BYTES - ENVELOPE_RESERVE;
  title = jsonByteCap(title, Math.min(2000, Math.floor(META_BUDGET * 0.1)));
  url = jsonByteCap(url, Math.min(8000, Math.floor(META_BUDGET * 0.4)));
  const cappedPattern = options.pattern
    ? jsonByteCap(cap(options.pattern, FIELD_CAPS.pattern), Math.min(4000, Math.floor(META_BUDGET * 0.2)))
    : undefined;

  const result: SnapshotResult = {
    ref_id: refId,
    title,
    url,
    lineno,
    content,
    elements,
  };
  if (cappedPattern) result.pattern = cappedPattern;

  let serialized = JSON.stringify(result);
  while (Buffer.byteLength(serialized, "utf8") > OUTPUT_BUDGET_BYTES && result.content.length > 0) {
    const removed = result.content.pop()!;
    if (removed.element_id != null) {
      const idx = result.elements.findIndex((e) => e.id === removed.element_id);
      if (idx !== -1) result.elements.splice(idx, 1);
    }
    result.truncated = true;
    result.next_lineno = removed.line;
    serialized = JSON.stringify(result);
  }

  if (hasMore && !result.truncated && !result.next_lineno) {
    result.next_lineno = startIdx + windowed.length + 1;
  }

  // Rebuild the used set from the FINAL content (after budget truncation).
  const finalUsedIds = new Set<number>();
  for (const cl of result.content) {
    if (cl.element_id != null) finalUsedIds.add(cl.element_id);
  }

  // Prune element refs to only those included in the final response.
  for (const [id] of elementRefs) {
    if (!finalUsedIds.has(id)) {
      elementRefs.delete(id);
    }
  }

  return result;
}
