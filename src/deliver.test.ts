import { describe, expect, test } from "bun:test";
import { generateKeyPair, signEd25519, verifyEd25519 } from "@intx/crypto";
import { hexEncode } from "@intx/types";

import {
  createRunTriggerDeliverer,
  isRunTriggerUnroutable,
  RUN_MAIL_NOT_ROUTABLE,
  RunTriggerUnroutableError,
} from "./deliver.js";
import type { HookRouter } from "./deliver.js";
import type { SystemSender } from "./system-sender.js";

const ADDRESS = "run_0123456789abcdef@localhost";

async function durableSystemSender() {
  const keyPair = await generateKeyPair();
  let resolveCount = 0;
  const signings: { input: Uint8Array; signature: Uint8Array }[] = [];
  const sender: SystemSender = {
    resolve: async ({ domain, localPart }) => {
      resolveCount += 1;
      return {
        address: `${localPart}@${domain}`,
        publicKey: hexEncode(keyPair.publicKey),
        sign: async (input) => {
          const signature = await signEd25519(keyPair.privateKey, input);
          signings.push({ input, signature });
          return signature;
        },
      };
    },
  };
  return {
    sender,
    keyPair,
    signings,
    resolveCount: () => resolveCount,
  };
}

function recordingRouter() {
  const calls: Parameters<HookRouter["routeMail"]>[] = [];
  const router: HookRouter = {
    routeMail: (...args) => {
      calls.push(args);
      return true;
    },
  };
  return { calls, router };
}

function deliverer(router: HookRouter, systemSender: SystemSender) {
  return createRunTriggerDeliverer({
    router,
    materialize: async () => ({ outcome: "materialized", stepGrants: [] }),
    tenantDomain: async () => "localhost",
    senderLocalPart: "cron",
    systemSender,
  });
}

describe("createRunTriggerDeliverer", () => {
  test("routes the trigger mail as the system sender, not the run", async () => {
    const sender = await durableSystemSender();
    const recorded = recordingRouter();
    await deliverer(recorded.router, sender.sender).to(
      ADDRESS,
      "tick",
      "tnt_1",
      "cron",
    );

    const [call] = recorded.calls;
    expect(call?.[2]).toBe("cron@localhost");
    const raw = Buffer.from(call?.[1] ?? "", "base64").toString("utf8");
    // The recipient rejects a valid signature worn under a different From.
    expect(raw).toContain("From: cron@localhost");
  });

  test("co-delivers the key the mail's signature verifies against", async () => {
    const sender = await durableSystemSender();
    const recorded = recordingRouter();
    await deliverer(recorded.router, sender.sender).to(
      ADDRESS,
      "tick",
      "tnt_1",
      undefined,
    );

    const [call] = recorded.calls;
    expect(call?.[0]).toBe(ADDRESS);
    expect(call?.[4]?.senderIdentities).toEqual([
      {
        address: "cron@localhost",
        publicKey: hexEncode(sender.keyPair.publicKey),
      },
    ]);
    const [signing] = sender.signings;
    if (signing === undefined) throw new Error("the mail was not signed");
    expect(
      await verifyEd25519(
        signing.input,
        signing.signature,
        sender.keyPair.publicKey,
      ),
    ).toBe(true);
  });

  test("a second delivery reuses the same durable identity", async () => {
    const sender = await durableSystemSender();
    const recorded = recordingRouter();
    const deliver = deliverer(recorded.router, sender.sender);
    await deliver.to(ADDRESS, "one", "tnt_1", undefined);
    await deliver.to(ADDRESS, "two", "tnt_1", undefined);

    expect(sender.resolveCount()).toBe(2);
    const keys = recorded.calls.map(
      (c) => c[4]?.senderIdentities?.[0]?.publicKey,
    );
    expect(keys[0]).toBe(hexEncode(sender.keyPair.publicKey));
    expect(keys[1]).toBe(keys[0]);
    expect(recorded.calls.every((c) => c[2] === "cron@localhost")).toBe(true);
  });

  test("rejects a destination that is not a run address", async () => {
    const sender = await durableSystemSender();
    const recorded = recordingRouter();
    await expect(
      deliverer(recorded.router, sender.sender).to(
        "someone@localhost",
        "tick",
        "tnt_1",
        undefined,
      ),
    ).rejects.toThrow("not a live run address");
  });

  test("hands the run grants to the router in the one routeMail call", async () => {
    const sender = await durableSystemSender();
    const recorded = recordingRouter();
    const stepGrants = [{ stepId: "s1" }] as never;
    const deliver = createRunTriggerDeliverer({
      router: recorded.router,
      materialize: async () => ({ outcome: "materialized", stepGrants }),
      tenantDomain: async () => "localhost",
      senderLocalPart: "cron",
      systemSender: sender.sender,
    });
    await deliver.to(ADDRESS, "tick", "tnt_1", undefined);

    expect(recorded.calls).toHaveLength(1);
    expect(recorded.calls[0]?.[4]).toEqual({
      runId: "run_0123456789abcdef",
      stepGrants,
      senderIdentities: [
        {
          address: "cron@localhost",
          publicKey: hexEncode(sender.keyPair.publicKey),
        },
      ],
    });
  });

  test("a dead run address fails with its run identity, not a bare string", async () => {
    const sender = await durableSystemSender();
    const recorded = recordingRouter();
    recorded.router.routeMail = () => false;
    const error = await deliverer(recorded.router, sender.sender)
      .to(ADDRESS, "tick", "tnt_1", undefined)
      .then(
        () => {
          throw new Error("the dead run delivered");
        },
        (e: unknown) => e,
      );

    expect(error).toBeInstanceOf(RunTriggerUnroutableError);
    expect(isRunTriggerUnroutable(error)).toBe(true);
    expect((error as { code: string }).code).toBe(RUN_MAIL_NOT_ROUTABLE);
    expect((error as { address: string }).address).toBe(ADDRESS);
    expect((error as { runId: string }).runId).toBe("run_0123456789abcdef");
    expect(String((error as Error).message)).toContain("run mail not routable");
  });

  test("rejected grants deliver nothing", async () => {
    const sender = await durableSystemSender();
    const recorded = recordingRouter();
    const deliver = createRunTriggerDeliverer({
      router: recorded.router,
      materialize: async () => ({
        outcome: "rejected",
        status: 403,
        code: "denied",
        message: "run grants denied",
      }),
      tenantDomain: async () => "localhost",
      senderLocalPart: "cron",
      systemSender: sender.sender,
    });

    await expect(
      deliver.to(ADDRESS, "tick", "tnt_1", undefined),
    ).rejects.toThrow("run grants denied");
    expect(recorded.calls).toEqual([]);
  });
});
