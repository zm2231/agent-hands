import { describe, it, expect } from "vitest";
import { validateArgs } from "../src/kernel/validate.js";
import { sanitizeError } from "../src/kernel/sanitize.js";

describe("validateArgs", () => {
  const schema = {
    type: "object",
    properties: {
      name: { type: "string" },
      count: { type: "integer" },
      flag: { type: "boolean" },
      mode: { type: "string", enum: ["fast", "slow"] },
    },
    required: ["name"],
    additionalProperties: false,
  };

  it("accepts valid args", () => {
    expect(validateArgs({ name: "test" }, schema)).toBeNull();
    expect(validateArgs({ name: "test", count: 3, flag: true }, schema)).toBeNull();
  });

  it("rejects unknown keys", () => {
    const err = validateArgs({ name: "test", extra: true }, schema);
    expect(err).toContain("Unknown argument(s): extra");
  });

  it("rejects missing required keys", () => {
    const err = validateArgs({}, schema);
    expect(err).toContain("Missing required argument: name");
  });

  it("rejects wrong types", () => {
    expect(validateArgs({ name: 123 }, schema)).toContain("must be a string");
    expect(validateArgs({ name: "x", count: "3" }, schema)).toContain("must be an integer");
    expect(validateArgs({ name: "x", flag: "yes" }, schema)).toContain("must be a boolean");
  });

  it("rejects invalid enum values", () => {
    const err = validateArgs({ name: "x", mode: "turbo" }, schema);
    expect(err).toContain("must be one of: fast, slow");
  });
});

describe("sanitizeError", () => {
  it("replaces home paths", () => {
    expect(sanitizeError("Error at /Users/alice/project/file.ts")).toContain("~");
    expect(sanitizeError("Error at /Users/alice/project/file.ts")).not.toContain("alice");
  });

  it("replaces URLs", () => {
    expect(sanitizeError("Failed: https://api.example.com/secret")).toContain("[url]");
  });

  it("replaces long tokens", () => {
    const token = "A".repeat(40);
    expect(sanitizeError(`Token: ${token}`)).toContain("[redacted]");
  });

  it("truncates long messages", () => {
    const long = "x".repeat(600);
    const result = sanitizeError(long);
    expect(result.length).toBeLessThanOrEqual(501); // 500 + ellipsis
  });
});
