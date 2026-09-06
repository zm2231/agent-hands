// help action.

export function helpAction(): Record<string, unknown> {
  return {
    input: "JSON object with an action field. Batch: top-level array.",
    actions: {
      help: {},
      start: {},
      tabs: { query: "string?", offset: "int?" },
      open: { ref_id: "string?", url: "string?", lineno: "int?", response_length: "short|medium|long?" },
      find: { ref_id: "string", pattern: "string", lineno: "int?", response_length: "short|medium|long?" },
      click: { ref_id: "string", id: "int?", selector: "string?", x: "number?", y: "number?" },
      type: { ref_id: "string", id: "int?", text: "string" },
      screenshot: { ref_id: "string", id: "int?", selector: "string?" },
      html: { ref_id: "string", id: "int?", selector: "string?" },
      navigate: { ref_id: "string", url: "string" },
      evaluate: { ref_id: "string", expression: "string" },
      network: { ref_id: "string" },
      load_all: { ref_id: "string", selector: "string", interval_ms: "int?" },
      raw: { ref_id: "string", method: "string", params: "object?" },
      read_result: { handle: "uuid", offset: "int?" },
      discard_result: { handle: "uuid" },
      stop: { ref_id: "string?" },
    },
    continuation: "Use next_lineno/next_offset for pagination. response_length: short (60 lines), medium (140), long (300).",
  };
}
