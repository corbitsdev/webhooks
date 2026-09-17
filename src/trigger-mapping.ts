// Renders a trigger's stored `inputTemplate` against an already-parsed,
// already-typed-as-`unknown` webhook payload: `{{path.to.field}}`
// placeholders are replaced with the string form of the value at that
// dotted path, and any other placeholder resolves to an empty string
// rather than throwing — a webhook payload's shape is never a contract
// this package can enforce on the sender, so a missing field degrades
// the rendered message rather than rejecting the delivery outright.
const PLACEHOLDER = /\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g;

function readPath(payload: unknown, dottedPath: string): unknown {
  return dottedPath.split(".").reduce<unknown>((value, segment) => {
    if (value === null || typeof value !== "object") return undefined;
    return (value as Record<string, unknown>)[segment];
  }, payload);
}

function stringify(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return JSON.stringify(value);
}

/**
 * Applies `template`'s `{{path.to.field}}` placeholders against
 * `payload`, producing the message content sent to the launched run.
 */
export function renderInputTemplate(
  template: string,
  payload: unknown,
): string {
  return template.replace(PLACEHOLDER, (_match, dottedPath: string) =>
    stringify(readPath(payload, dottedPath)),
  );
}
