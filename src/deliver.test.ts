import { describe, expect, test } from "bun:test";
import { generateKeyPair, signEd25519, verifyEd25519 } from "@intx/crypto";
import { hexEncode } from "@intx/types";

import { createRunTriggerDeliverer } from "./deliver";
import type { SystemSender } from "./system-sender";

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
    senderIdentities: unknown;
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
        _stepGrants: unknown,
        senderIdentities: unknown,
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
      (g) => (g.senderIdentities as { publicKey: string }[])[0]?.publicKey,
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
});
