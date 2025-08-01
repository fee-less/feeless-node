#!/usr/bin/env node

console.log("Starting node...")

import { calculateMintFee, calculateReward, FLSStoFPoints, getDiff, Transaction } from "feeless-utils";
import Blockchain from "./blockchain.js";
import P2PNetwork from "./p2pnet.js";
import express from "express";
import { config } from "dotenv";
import cors from "cors";
import fs from "fs";
console.log("Reading config...");
if (!fs.existsSync(".env")) fs.writeFileSync(".env",
  `PEER=ws://fee-less.com:6061,ws://fee-less.com:6062
PEER_HTTP=http://fee-less.com:8000
PORT=6061
HTTP_PORT=8000`
);
console.log("Initializing HTTP API...");

config();

const app = express();
app.use(cors());

// --- Load local chain from disk ---
function loadLocalBlocks() {
  const blocks = [
    {
      timestamp: Date.now(),
      transactions: [
        {
          sender: "network",
          receiver: "03bea510ff0689107a3a7b3ff3968e0554672142bbf6fc6db75d01e7aa6620e4f8",
          amount: FLSStoFPoints(5000000),
          signature: "network",
          nonce: 0,
          timestamp: Date.now(),
        },
      ],
      prev_hash: "genesis",
      nonce: 0,
      signature: "3045022100e057f5f136f3f0e5b837660287db7b696b433c8a56665319a829293526d39814022023d6e513727b6b1de23fa28b9a8dee7efb4d91876cd83f1b3993c83a880f7e1a",
      proposer: "03bea510ff0689107a3a7b3ff3968e0554672142bbf6fc6db75d01e7aa6620e4f8",
      hash: "11f0ef7e028354a51d802f85b7da8b46e6bab6d5683af65e0831d0fdaeb7e3",
    },
  ];
  if (fs.existsSync("blockchain")) {
    for (const block of fs.readdirSync("blockchain").sort((a, b) => parseInt(a) - parseInt(b))) {
      blocks.push(JSON.parse(fs.readFileSync("blockchain/" + block, "utf-8")));
    }
  }
  return blocks;
}

console.log("Loading local blocks...")
let blocks = loadLocalBlocks();
let bc = new Blockchain(blocks);
await bc.waitForSync();
console.log("Validated local blocks. ")
// Step 2 & 3: Sync missing blocks from peer
if (process.env.PEER_HTTP) {
  let syncing = true;

  while (syncing) {
    const remoteHeight = (
      await fetch(process.env.PEER_HTTP + "/height").then((res) => res.json())
    ).height;
    const localHeight = bc.blocks.length;
    if (localHeight >= remoteHeight) {
      syncing = false;
      break;
    }
    const BATCH_SIZE = 500;

    for (let i = localHeight; i < remoteHeight; i += BATCH_SIZE) {
      const start = i;
      const end = Math.min(i + BATCH_SIZE, remoteHeight);
      const blocks = await fetch(
        `${process.env.PEER_HTTP}/blocks?start=${start}&end=${end}`
      ).then((res) => res.json());

      if (!Array.isArray(blocks)) {
        console.error(`Invalid response while syncing blocks ${start}-${end}.`);
        process.exit(1);
      }

      for (let j = 0; j < blocks.length; j++) {
        const block = blocks[j];
        bc.mempool.push(...block.transactions);
        const ok = await bc.addBlock(block, true);
        if (!ok) {
          console.error(
            `Downloaded block at height ${start + j} is invalid. Stopping sync.`
          );
          process.exit(1);
        }
        if (!fs.existsSync("blockchain")) fs.mkdirSync("blockchain");
        fs.writeFileSync(`blockchain/${start + j}`, JSON.stringify(block));
        process.stdout.write(`\rSynced block ${start + j + 1}/${remoteHeight}`);
      }
    }
  }
  console.log("\nSync complete.");
};

// Start P2P and API as usual
const p2p = new P2PNetwork(process.env.PEER ?? "", parseInt(process.env.PORT ?? "6061"), bc);

app.get("/block/:height", (req, res) => {
  try {
    res.json(bc.blocks[parseInt(req.params.height)]);
  } catch (e: any) {
    res.json({ error: e.message });
    console.log("[ERROR]", e);
  }
});

app.get("/blocks", (req, res) => {
  try {
    const start = parseInt(req.query.start as string);
    const end = parseInt(req.query.end as string);
    if (start > end) {
      res.status(400);
      return;
    }
    if (end - start > 500) {
      res.status(400);
      return;
    }
    res.json(bc.blocks.slice(start,end));
  } catch (e: any) {
    res.json({ error: e.message });
    console.log("[ERROR]", e);
  }
});

app.get("/height", (_, res) => {
  try {
    res.json({ height: bc.blocks.length });
  } catch (e: any) {
    res.json({ error: e.message });
    console.log("[ERROR]", e);
  }
});

app.get("/mempool", (_, res) => {
  res.json(bc.mempool);
});

app.get("/diff", (_, res) => {
  try {
    res.json({ diff: getDiff(bc.blocks).toString(16) });
  } catch (e: any) {
    res.json({ error: e.message });
    console.log("[ERROR]", e);
  }
});

app.get("/mint-fee", (_, res) => {
  try {
    res.json({ fee: calculateMintFee(bc.blocks.length, bc.mintedTokens.size) });
  } catch (e: any) {
    res.json({ error: e.message });
    console.log("[ERROR]", e);
  }
});

app.get("/reward", (_, res) => {
  try {
    res.json({ reward: calculateReward(bc.blocks.length) });
  } catch (e: any) {
    res.json({ error: e.message });
    console.log("[ERROR]", e);
  }
});

app.get("/balance/:addr", (req, res) => {
  try {
    res.json(bc.calculateBalance(req.params.addr.split(".")[0], false, req.params.addr.split(".")[1]));
  } catch (e: any) {
    res.json({ error: e.message });
    console.log("[ERROR]", e);
  }
});

app.get("/locked/:addr", (req, res) => {
  try {
    res.json(
      bc.calculateLocked(
        req.params.addr.split(".")[0],
        req.params.addr.split(".")[1]
      )
    );
  } catch (e: any) {
    res.json({ error: e.message });
    console.log("[ERROR]", e);
  }
});

app.get("/balance-mempool/:addr", (req, res) => {
  try {
    res.json(bc.calculateBalance(req.params.addr.split(".")[0], true, req.params.addr.split(".")[1]));
  } catch (e: any) {
    res.json({ error: e.message });
    console.log("[ERROR]", e);
  }
});

app.get("/tokens/:addr", (req, res) => {
  try {
    const balanceTokens: Record<string, number> = {};
    for (const block of bc.blocks) {
      for (const tx of block.transactions) {
        if (tx.receiver === req.params.addr && tx.token) {
          if (!balanceTokens[tx.token]) balanceTokens[tx.token] = 0;
          balanceTokens[tx.token] += tx.amount;
        }
        if (tx.sender === req.params.addr && tx.token) balanceTokens[tx.token] -= tx.amount;
      }
    }
    for (const tx of bc.mempool) {
      if (tx.receiver === req.params.addr && tx.token) {
        if (!balanceTokens[tx.token]) balanceTokens[tx.token] = 0;
        balanceTokens[tx.token] += tx.amount;
    }
      if (tx.sender === req.params.addr && tx.token) balanceTokens[tx.token] -= tx.amount;
    }
    const tokens = [];
    for (const token in balanceTokens) {
      if (balanceTokens[token] > 0) tokens.push(token);
    }
    res.json(tokens)
  } catch (e: any) {
    res.json({ error: e.message });
    console.log("[ERROR]", e);
  }
});

app.get("/token-info/:token", (req, res) => {
  try {
    res.json(bc.mintedTokens.get(req.params.token));
  } catch (e: any) {
    res.json({ error: e.message });
    console.log("[ERROR]", e);
  }
});

app.get("/token-count", (_, res) => {
  try {
    res.json({ count: bc.mintedTokens.size });
  } catch (e: any) {
    res.json({ error: e.message });
    console.log("[ERROR]", e);
  }
});

app.get("/token/:i", (req, res) => {
  try {
    const index = parseInt(req.params.i);
    if (isNaN(index) || index < 0 || index >= bc.mintedTokens.size) {
      res.json({ error: "Invalid token index" });
      return;
    }
    // Convert Map to array and get the token at the specified index
    const tokens = Array.from(bc.mintedTokens.entries());
    const [tokenName, tokenInfo] = tokens[index];
    res.json({ token: tokenName, ...tokenInfo });
  } catch (e: any) {
    res.json({ error: e.message });
    console.log("[ERROR]", e);
  }
});

app.get("/history/:addr", (req, res) => {
  try {
    const addr = req.params.addr;
    const history: {
      type: 'send' | 'receive' | 'mint';
      amount: number;
      token?: string;
      timestamp: number;
      status: 'confirmed' | 'pending';
      address: string;
      blockHeight?: number;
    }[] = [];

    // Get confirmed transactions from blocks
    for (let i = 0; i < bc.blocks.length; i++) {
      const block = bc.blocks[i];
      for (const tx of block.transactions) {
        if (tx.sender === addr || tx.receiver === addr) {
          // Skip network transactions unless they're rewards to this address
          if (tx.sender === 'network' && tx.receiver !== addr) continue;

          const type = tx.sender === addr ? 'send' :
            tx.mint ? 'mint' : 'receive';

          const otherAddress = tx.sender === addr ? tx.receiver : tx.sender;

          history.push({
            type,
            amount: tx.amount,
            token: tx.token,
            timestamp: tx.timestamp,
            status: 'confirmed',
            address: otherAddress,
            blockHeight: i
          });
        }
      }
    }

    // Get pending transactions from mempool
    for (const tx of bc.mempool) {
      if (tx.sender === addr || tx.receiver === addr) {
        const type = tx.sender === addr ? 'send' : 'receive';
        const otherAddress = tx.sender === addr ? tx.receiver : tx.sender;

        history.push({
          type,
          amount: tx.amount,
          token: tx.token,
          timestamp: tx.timestamp,
          status: 'pending',
          address: otherAddress
        });
      }
    }

    // Sort by timestamp, most recent first
    history.sort((a, b) => b.timestamp - a.timestamp);

    res.json(history);
  } catch (e: any) {
    res.json({ error: e.message });
    console.log("[ERROR]", e);
  }
});

app.get("/search-blocks/:hash", (req, res) => {
  try {
    const hash = req.params.hash;
    // Search through blocks to find matching hash
    for (let i = 0; i < bc.blocks.length; i++) {
      if (bc.blocks[i].hash === hash) {
        res.json({ block: bc.blocks[i], height: i });
        return;
      }
    }
    res.json({ error: "Block not found" });
  } catch (e: any) {
    res.json({ error: e.message });
    console.log("[ERROR]", e);
  }
});

app.get("/search-tx/:query", (req, res) => {
  try {
    const query = req.params.query;
    const results: { tx: Transaction, blockHeight?: number }[] = [];

    // Search in blocks
    for (let i = 0; i < bc.blocks.length; i++) {
      const block = bc.blocks[i];
      for (const tx of block.transactions) {
        if (tx.signature === query || tx.sender === query || tx.receiver === query) {
          results.push({ tx, blockHeight: i });
        }
      }
    }

    // Search in mempool
    for (const tx of bc.mempool) {
      if (tx.signature === query || tx.sender === query || tx.receiver === query) {
        results.push({ tx });
      }
    }

    res.json({ results });
  } catch (e: any) {
    res.json({ error: e.message });
    console.log("[ERROR]", e);
  }
});

console.log("Ready.");
app.listen(parseInt(process.env.HTTP_PORT ?? "8000"));
