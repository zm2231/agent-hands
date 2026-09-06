// Schema-based argument validation (strict, reject unknown keys).

export function validateArgs(
  args: Record<string, unknown>,
  schema: Record<string, unknown>
): string | null {
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    return "Arguments must be a JSON object.";
  }

  const properties = (schema.properties ?? {}) as Record<string, unknown>;
  const required = (schema.required ?? []) as string[];
  const additionalProperties = schema.additionalProperties;

  // Reject unknown keys.
  if (additionalProperties === false) {
    const allowed = new Set(Object.keys(properties));
    const unknown = Object.keys(args).filter((k) => !allowed.has(k));
    if (unknown.length > 0) {
      return `Unknown argument(s): ${unknown.join(", ")}`;
    }
  }

  // Check required keys.
  for (const key of required) {
    if (!(key in args) || args[key] === undefined) {
      return `Missing required argument: ${key}`;
    }
  }

  // Type check each provided property against its schema.
  for (const [key, value] of Object.entries(args)) {
    const propSchema = properties[key] as Record<string, unknown> | undefined;
    if (!propSchema) continue;

    const schemaType = propSchema.type as string | undefined;
    if (!schemaType) continue;

    if (schemaType === "string" && typeof value !== "string") {
      return `Argument "${key}" must be a string.`;
    }
    if (schemaType === "number" && typeof value !== "number") {
      return `Argument "${key}" must be a number.`;
    }
    if (schemaType === "integer") {
      if (typeof value !== "number" || !Number.isInteger(value)) {
        return `Argument "${key}" must be an integer.`;
      }
    }
    if (schemaType === "boolean" && typeof value !== "boolean") {
      return `Argument "${key}" must be a boolean.`;
    }

    // Enum check.
    const enumValues = propSchema.enum as unknown[] | undefined;
    if (enumValues && !enumValues.includes(value)) {
      return `Argument "${key}" must be one of: ${enumValues.join(", ")}`;
    }
  }

  return null;
}
