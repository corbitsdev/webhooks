import { createEd25519Crypto, generateKeyPair } from "@intx/crypto";

export type MailDeliverer = {
  to: (address: string, content: string, tenantId: string) => Promise<void>;
};

type MailSession = {
  sendUserMessage(params: {
    agentAddress: string;
    from: string;
    messageId: string;
    date: Date;
    content: string;
    sessionId: string;
    tenantId: string;
    cryptoProvider: ReturnType<typeof createEd25519Crypto>;
  }): Promise<unknown>;
};

/**
 * Turn a payload into Interchange mail. A live deployment's
 * `onTrigger({ on: { type: "mail", to } })` is what consumes it.
 */
export async function createMailDeliverer(opts: {
  sessionService: MailSession;
  from?: string;
}): Promise<MailDeliverer> {
  const cryptoProvider = createEd25519Crypto(await generateKeyPair());
  const from = opts.from ?? "hooks@localhost";

  return {
    async to(address, content, tenantId) {
      const id = crypto.randomUUID();
      await opts.sessionService.sendUserMessage({
        agentAddress: address,
        from,
        messageId: `<${id}@localhost>`,
        date: new Date(),
        content,
        sessionId: id,
        tenantId,
        cryptoProvider,
      });
    },
  };
}
