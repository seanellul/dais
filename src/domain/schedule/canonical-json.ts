/**
 * Canonical JSON: the same value always gives the same text, whatever the
 * order in which object keys were added. Assignment ids are hashed from this
 * text, so a key-order difference between the server and a phone can never
 * change an id.
 *
 * Rules, matching JSON.stringify where they overlap:
 * - object keys are sorted by code unit;
 * - `undefined`, functions and symbols are dropped from objects and become
 *   `null` inside arrays;
 * - non-finite numbers become `null`;
 * - objects with a `toJSON` method (such as Date) are serialised through it.
 */
export function canonicalJson(value: unknown): string {
  return serialise(value) ?? "null";
}

function serialise(value: unknown): string | undefined {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "number":
      return Number.isFinite(value) ? JSON.stringify(value) : "null";
    case "boolean":
      return value ? "true" : "false";
    case "bigint":
      return JSON.stringify(value.toString());
    case "undefined":
    case "function":
    case "symbol":
      return undefined;
    default:
      break;
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => serialise(item) ?? "null").join(",")}]`;
  }
  const object = value as Record<string, unknown>;
  if (typeof object.toJSON === "function") {
    return serialise((object.toJSON as () => unknown)());
  }
  const entries: string[] = [];
  for (const key of Object.keys(object).sort()) {
    const text = serialise(object[key]);
    if (text !== undefined) entries.push(`${JSON.stringify(key)}:${text}`);
  }
  return `{${entries.join(",")}}`;
}
