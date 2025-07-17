import { Block, MintedTokenEntry, TokenMint, Transaction } from "feeless-utils";
import fs from "fs";

function getWebhooks(event: string): string[] {
  if (fs.existsSync("webhooks.json")) {
    const all = JSON.parse(fs.readFileSync("webhooks.json", "utf-8"));
    if (!all[event]) return [];
    return all[event];
  }
  return [];
}

export function onBlock(block: Block) {
  const webhooks = getWebhooks("block");
  for (const webhook of webhooks) {
    try {
      fetch(webhook, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(block),
      }).catch((err) => {
        console.error(`Failed to send block to ${webhook}: ${err.message}`);
      });
    } catch (err) {
      console.error(`Unexpected error in onBlock: ${(err as Error).message}`);
    }
  }
}

export function onTX(tx: Transaction) {
  const webhooks = getWebhooks("block");
  for (const webhook of webhooks) {
    try {
      fetch(webhook, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(tx),
      }).catch((err) => {
        console.error(
          `Failed to send transaction to ${webhook}: ${err.message}`
        );
      });
    } catch (err) {
      console.error(`Unexpected error in onTX: ${(err as Error).message}`);
    }
  }
}

export function onMint(mint: TokenMint, token: string) {
  const webhooks = getWebhooks("block");
  for (const webhook of webhooks) {
    try {
      fetch(webhook, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          token,
          mint,
        }),
      }).catch((err) => {
        console.error(`Failed to send mint to ${webhook}: ${err.message}`);
      });
    } catch (err) {
      console.error(`Unexpected error in onMint: ${(err as Error).message}`);
    }
  }
}
