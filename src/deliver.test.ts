import { describe, expect, test } from "bun:test";
import { generateKeyPair, signEd25519, verifyEd25519 } from "@intx/crypto";
import { hexEncode } from "@intx/types";

import { createRunTriggerDeliverer, isRunTriggerUnroutable } from "./deliver.js";
import { RUN_GRANTS_NOT_ROUTABLE, RUN_MAIL_NOT_ROUTABLE } from "./deliver.js";
import type { HookMailRouter } from "./deliver.js";
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
  const grants: {
    address: string;
    senderIdentities: Parameters<HookMailRouter["sendRunGrants"]>[3];
  }[] = [];
  const mail: { authenticatedSender: string; rawMessage: string }[] = [];
  return {
    grants,
    mail,
    router: {
      routeMail: (
        _address: string,
        rawMessage: string,
        authenticatedSender: string,
      ) => {
        mail.push({ authenticatedSender, rawMessage });
        return true;
      },
      sendRunGrants: (
        address: string,
        _runId: string,
        _stepGrants: Parameters<HookMailRouter["sendRunGrants"]>[2],
        senderIdentities: Parameters<HookMailRouter["sendRunGrants"]>[3],
      ) => {
        grants.push({ address, senderIdentities });
        return true;
      },
    },
  };
}

function deliverer(
  router: ReturnType<typeof recordingRouter>["router"],
  systemSender: SystemSender,
) {
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

    const [frame] = recorded.mail;
    expect(frame?.authenticatedSender).toBe("cron@localhost");
    const raw = Buffer.from(frame?.rawMessage ?? "", "base64").toString("utf8");
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

    const [barrier] = recorded.grants;
    expect(barrier?.address).toBe(ADDRESS);
    expect(barrier?.senderIdentities).toEqual([
      { address: "cron@localhost", publicKey: hexEncode(sender.keyPair.publicKey) },
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
    const keys = recorded.grants.map(
      (g) => g.senderIdentities?.[0]?.publicKey,
    );
    expect(keys[0]).toBe(hexEncode(sender.keyPair.publicKey));
    expect(keys[1]).toBe(keys[0]);
    expect(recorded.mail.every((m) => m.authenticatedSender === "cron@localhost")).toBe(
      true,
    );
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

  test("a dead run address fails with its run identity, not a bare string", async () => {
    const sender = await durableSystemSender();
    const recorded = recordingRouter();
    recorded.router.sendRunGrants = () => false;
    const error = await deliverer(recorded.router, sender.sender)
      .to(ADDRESS, "tick", "tnt_1", undefined)
      .then(
        () => {
          throw new Error("the dead run delivered");
        },
        (e: unknown) => e,
      );

    expect(isRunTriggerUnroutable(error)).toBe(true);
    expect((error as { code: string }).code).toBe(RUN_GRANTS_NOT_ROUTABLE);
    expect((error as { address: string }).address).toBe(ADDRESS);
    expect((error as { runId: string }).runId).toBe("run_0123456789abcdef");
    expect(String((error as Error).message)).toContain("run grants not routable");
    // The grants barrier never went out, so no mail follows it.
    expect(recorded.mail).toEqual([]);
  });

  test("unroutable mail after delivered grants names the run too", async () => {
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

    expect(isRunTriggerUnroutable(error)).toBe(true);
    expect((error as { code: string }).code).toBe(RUN_MAIL_NOT_ROUTABLE);
    expect((error as { address: string }).address).toBe(ADDRESS);
    expect((error as { runId: string }).runId).toBe("run_0123456789abcdef");
    // The grants barrier went out before the mail leg failed.
    expect(recorded.grants).toHaveLength(1);
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

    await expect(deliver.to(ADDRESS, "tick", "tnt_1", undefined)).rejects.toThrow(
      "run grants denied",
    );
    expect(recorded.grants).toEqual([]);
    expect(recorded.mail).toEqual([]);
  });
});
