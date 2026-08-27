import { describe, expect, test } from "bun:test";

import { parseWebhookMeta, pickDestination } from "./resolve";

describe("parseWebhookMeta", () => {
  test("reads nested webhook metadata", () => {
    expect(
      parseWebhookMeta({
        webhook: { verify: "slack", workflow: "jimmy" },
      }),
    ).toEqual({ verify: "slack", workflow: "jimmy" });
  });

  test("ignores credentials that are not hooks", () => {
    expect(parseWebhookMeta(undefined)).toBeUndefined();
    expect(parseWebhookMeta({ provider: "giphy" })).toBeUndefined();
    expect(parseWebhookMeta({ webhook: { verify: "grant" } })).toBeUndefined();
  });
});

describe("pickDestination", () => {
  const runs = [
    { address: "run_chat@localhost", definitionName: "chat", assetName: "chat" },
    { address: "run_jimmy@localhost", definitionName: "jimmy", assetName: "jimmy" },
  ];

  test("metadata.to wins", () => {
    expect(
      pickDestination(
        { to: "jimmy@localhost", credentialName: "slack" },
        runs,
      ),
    ).toEqual({ ok: true, to: "jimmy@localhost" });
  });

  test("metadata.workflow selects a live deployment", () => {
    expect(
      pickDestination({ workflow: "jimmy", credentialName: "slack" }, runs),
    ).toEqual({ ok: true, to: "run_jimmy@localhost" });
  });

  test("credential name matches a live deployment", () => {
    expect(
      pickDestination({ credentialName: "jimmy" }, runs),
    ).toEqual({ ok: true, to: "run_jimmy@localhost" });
  });

  test("unique live run when nothing else matches", () => {
    expect(
      pickDestination(
        { credentialName: "slack" },
        [runs[1]!],
      ),
    ).toEqual({ ok: true, to: "run_jimmy@localhost" });
  });

  test("ambiguous when several deployments and no selector", () => {
    const dest = pickDestination({ credentialName: "slack" }, runs);
    expect(dest.ok).toBe(false);
    if (!dest.ok) expect(dest.code).toBe("ambiguous");
  });

  test("none when nothing is live", () => {
    expect(pickDestination({ credentialName: "slack" }, [])).toEqual({
      ok: false,
      code: "none",
      candidates: [],
    });
  });
});
