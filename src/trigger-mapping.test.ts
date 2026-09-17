import { describe, expect, test } from "bun:test";
import { renderInputTemplate } from "./trigger-mapping";

describe("renderInputTemplate", () => {
  test("substitutes a nested dotted path", () => {
    expect(
      renderInputTemplate("Note: {{note.title}}", {
        note: { title: "Q3 planning" },
      }),
    ).toBe("Note: Q3 planning");
  });

  test("a missing field degrades to an empty string rather than throwing", () => {
    expect(renderInputTemplate("{{missing.path}}", { note: {} })).toBe("");
  });

  test("stringifies non-string leaf values", () => {
    expect(renderInputTemplate("{{n}} {{b}}", { n: 5, b: true })).toBe(
      "5 true",
    );
  });

  test("a path through a non-object value resolves to empty rather than throwing", () => {
    expect(renderInputTemplate("{{a.b}}", { a: "not an object" })).toBe("");
  });
});
