import { describe, expect, it } from "vitest";
import { EXPECTED_OFFICIAL_INPUT_SCHEMAS, validateOfficialToolInventory } from "../src/desktop/broker/official-schemas.js";

describe("official tool inventory", () => {
  it("accepts the signed schema shape and rejects schema drift", () => {
    const inventory = Object.fromEntries(Object.entries(EXPECTED_OFFICIAL_INPUT_SCHEMAS).map(([method, inputSchema]) => [method, { inputSchema: structuredClone(inputSchema) }]));
    expect(() => validateOfficialToolInventory(inventory)).not.toThrow();
    (inventory.click as any).inputSchema.properties.x.type = "integer";
    expect(() => validateOfficialToolInventory(inventory)).toThrow("Inventory schema mismatch for click");
  });
});
