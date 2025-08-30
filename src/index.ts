#!/usr/bin/env node

import {
  Block,
  calculateMintFee,
  calculateReward,
  FLSStoFPoints,
  getDiff,
  STARTING_DIFF,
  TAIL,
  Transaction,
} from "feeless-utils";
import Blockchain from "./blockchain.js";
import P2PNetwork from "./p2pnet.js";
import express from "express";
import { config } from "dotenv";
import cors from "cors";
import fs from "fs";
import { SplitTerminalUI } from "./ui.js";

const ui = new SplitTerminalUI();

ui.logLeft(`\x1b[36m[NODE]\x1b[0m Starting Feeless node...`);
ui.logLeft(`\x1b[36m[NODE]\x1b[0m Reading configuration...`);
if (!fs.existsSync(".env")) {
  const defaultConfig = `PEER=ws://fee-less.com:6061,ws://fee-less.com:6062
PEER_HTTP=http://fee-less.com:8000
PORT=6061
HTTP_PORT=8000`;
  fs.writeFileSync(".env", defaultConfig);
  ui.logLeft(`\x1b[32m[NODE]\x1b[0m Created default .env configuration file`);
}

ui.logLeft(`\x1b[36m[NODE]\x1b[0m Initializing HTTP API server...`);

config();

const app = express();
app.use(cors());

// --- Load local chain from disk ---
function loadLocalBlocks() {
  const blocks: Block[] = [];
  if (fs.existsSync("blockchain")) {
    const blockFiles = fs
      .readdirSync("blockchain")
      .sort((a, b) => parseInt(a) - parseInt(b));

    ui.logRight(
      `\x1b[36m[NODE]\x1b[0m Found ${blockFiles.length} local blocks to load`
    );

    for (const block of blockFiles) {
      try {
        blocks.push(
          JSON.parse(fs.readFileSync("blockchain/" + block, "utf-8"))
        );
      } catch (error: any) {
        ui.logRight(
          `\x1b[31m[NODE]\x1b[0m Failed to load block ${block}: ${error.message}`
        );
        throw error;
      }
    }
  }

  if (blocks.length === 0 && !process.env.PEER) {
    ui.logRight(
      `\x1b[33m[NODE]\x1b[0m No local blocks found and no peers configured - creating genesis block`
    );

    const genesisBlock: Block = {
      timestamp: Date.now(),
      transactions: [
        {
          sender: "network",
          receiver:
            "02b4a4887c88e80d32fd9fd6317bbaac2a28c4070feb6d93f82bbefc52f5b85f13",
          amount: FLSStoFPoints(5000000),
          signature: "network",
          nonce: 0,
          timestamp: Date.now(),
        },
      ],
      prev_hash: "genesis",
      nonce: 0,
      signature: "1",
      proposer:
        "02b4a4887c88e80d32fd9fd6317bbaac2a28c4070feb6d93f82bbefc52f5b85f13",
      hash: "1",
      diff: STARTING_DIFF.toString(16),
    };

    blocks.push(genesisBlock);

    if (!fs.existsSync("blockchain")) {
      fs.mkdirSync("blockchain");
    }
    fs.writeFileSync("blockchain/0", JSON.stringify(genesisBlock));
    ui.logLeft(`\x1b[32m[NODE]\x1b[0m Genesis block created and saved`);
  }

  return blocks;
}

ui.logLeft(`\x1b[36m[NODE]\x1b[0m Loading local blockchain...`);
let blocks = loadLocalBlocks();
let bc = new Blockchain(blocks, "blockchain", ui);
await bc.waitForSync();
ui.logLeft(
  `\x1b[32m[NODE]\x1b[0m Local blockchain validated - Height: ${bc.height}`
);

// Step 2 & 3: Sync missing blocks from peer
if (process.env.PEER_HTTP) {
  ui.logLeft(
    `\x1b[36m[NODE]\x1b[0m Checking for blockchain updates from peer: ${process.env.PEER_HTTP}`
  );
  let syncing = true;

  while (syncing) {
    try {
      const remoteResponse = await fetch(process.env.PEER_HTTP + "/height");
      if (!remoteResponse.ok) {
        throw new Error(
          `HTTP ${remoteResponse.status}: ${remoteResponse.statusText}`
        );
      }

      const remoteData = await remoteResponse.json();
      const remoteHeight = remoteData.height;
      const localHeight = bc.height;

      ui.logLeft(
        `\x1b[36m[NODE]\x1b[0m Remote height: ${remoteHeight}, Local height: ${localHeight}`
      );

      if (localHeight >= remoteHeight) {
        ui.logLeft(`\x1b[32m[NODE]\x1b[0m Local blockchain is up to date`);
        syncing = false;
        break;
      }

      ui.logLeft(
        `\x1b[33m[NODE]\x1b[0m Synchronization required - ${
          remoteHeight - localHeight
        } blocks behind`
      );
      const BATCH_SIZE = 500;

      for (let i = localHeight; i < remoteHeight; i += BATCH_SIZE) {
        const start = i;
        const end = Math.min(i + BATCH_SIZE, remoteHeight);

        ui.logRight(
          `\x1b[36m[NODE]\x1b[0m Fetching blocks ${start} to ${end - 1}...`
        );

        const blocksResponse = await fetch(
          `${process.env.PEER_HTTP}/blocks?start=${start}&end=${end}`
        );

        if (!blocksResponse.ok) {
          throw new Error(
            `Failed to fetch blocks ${start}-${end}: HTTP ${blocksResponse.status}`
          );
        }

        const blocks = await blocksResponse.json();

        if (!Array.isArray(blocks)) {
          console.error(
            `\x1b[31m[NODE]\x1b[0m Invalid response while syncing blocks ${start}-${end}`
          );
          process.exit(1);
        }

        for (let j = 0; j < blocks.length; j++) {
          const block = blocks[j] as Block;
          const blockHeight = start + j;

          if (blockHeight === 0) {
            // Genesis block sync
            if (!fs.existsSync("blockchain")) fs.mkdirSync("blockchain");
            fs.writeFileSync(
              `blockchain/${blockHeight}`,
              JSON.stringify(block)
            );
            bc.lastBlock = block.hash;
            bc.height++;
            ui.logRight(`\x1b[32m[NODE]\x1b[0m Genesis block synchronized`);
            continue;
          }

          bc.mempool.push(...block.transactions);
          const ok = await bc.addBlock(block, true);

          if (!ok) {
            ui.logRight(
              `\x1b[31m[NODE]\x1b[0m CRITICAL: Downloaded block at height ${blockHeight} is invalid`
            );
            ui.logRight(
              `\x1b[31m[NODE]\x1b[0m Sync failed - stopping synchronization`
            );
            process.exit(1);
          }

          if (!fs.existsSync("blockchain")) fs.mkdirSync("blockchain");
          fs.writeFileSync(`blockchain/${blockHeight}`, JSON.stringify(block));

          const progress = Math.round(((blockHeight + 1) / remoteHeight) * 100);
          process.stdout.write(
            `\r\x1b[36m[NODE]\x1b[0m Synced block ${
              blockHeight + 1
            }/${remoteHeight} (${progress}%)`
          );
        }
      }

      syncing = false;
    } catch (error: any) {
      ui.logRight(`\x1b[31m[NODE]\x1b[0m Sync error: ${error.message}`);
      ui.logLeft(`\x1b[33m[NODE]\x1b[0m Continuing without sync...`);
      syncing = false;
    }
  }

  // Sync mempool
  try {
    ui.logRight(`\x1b[36m[NODE]\x1b[0m Synchronizing mempool...`);
    const mempoolResponse = await fetch(process.env.PEER_HTTP + "/mempool");
    if (mempoolResponse.ok) {
      const remoteTxs = await mempoolResponse.json();
      let syncedTxs = 0;
      remoteTxs.forEach((tx: Transaction) => {
        if (bc.pushTX(tx)) syncedTxs++;
      });
      ui.logRight(
        `\x1b[32m[NODE]\x1b[0m Mempool synchronized - ${syncedTxs}/${remoteTxs.length} transactions added`
      );
    }
  } catch (error: any) {
    ui.logRight(
      `\x1b[33m[NODE]\x1b[0m Failed to sync mempool: ${error.message}`
    );
  }

  ui.logLeft(`\x1b[32m[NODE]\x1b[0m Blockchain synchronization completed`);
}

// Start P2P and API
ui.logLeft(`\x1b[36m[NODE]\x1b[0m Starting P2P network...`);
const p2p = new P2PNetwork(
  process.env.PEER ?? "",
  parseInt(process.env.PORT ?? "6061"),
  bc,
  ui
);

// API Routes with professional error handling
const handleApiError = (error: any, endpoint: string, res: any) => {
  console.error(`\x1b[31m[API]\x1b[0m ${endpoint} failed: ${error.message}`);
  res.status(500).json({ error: error.message });
};

app.get("/block/:height", (req, res) => {
  try {
    const height = parseInt(req.params.height);
    if (isNaN(height) || height < 0) {
      return res.status(400).json({ error: "Invalid block height" });
    }
    res.json(bc.getBlock(height));
  } catch (error: any) {
    handleApiError(error, `GET /block/${req.params.height}`, res);
  }
});

app.get("/blocks", (req, res) => {
  try {
    const start = parseInt(req.query.start as string);
    const end = parseInt(req.query.end as string);

    if (isNaN(start) || isNaN(end)) {
      return res.status(400).json({ error: "Invalid start or end parameter" });
    }

    if (start > end) {
      return res
        .status(400)
        .json({ error: "Start height cannot be greater than end height" });
    }

    if (end - start > 500) {
      return res
        .status(400)
        .json({ error: "Batch size cannot exceed 500 blocks" });
    }

    res.json(bc.getSlice(start, end));
  } catch (error: any) {
    handleApiError(
      error,
      `GET /blocks?start=${req.query.start}&end=${req.query.end}`,
      res
    );
  }
});

app.get("/height", (_, res) => {
  try {
    res.json({ height: bc.height });
  } catch (error: any) {
    handleApiError(error, "GET /height", res);
  }
});

app.get("/mempool", (_, res) => {
  try {
    res.json(bc.mempool);
  } catch (error: any) {
    handleApiError(error, "GET /mempool", res);
  }
});

app.get("/diff", (_, res) => {
  try {
    res.json({
      diff: getDiff(bc.getTail()).toString(16),
    });
  } catch (error: any) {
    handleApiError(error, "GET /diff", res);
  }
});

app.get("/mint-fee", (_, res) => {
  try {
    res.json({ fee: calculateMintFee(bc.height, bc.mintedTokens.size) });
  } catch (error: any) {
    handleApiError(error, "GET /mint-fee", res);
  }
});

app.get("/reward", (_, res) => {
  try {
    res.json({ reward: calculateReward(bc.height) });
  } catch (error: any) {
    handleApiError(error, "GET /reward", res);
  }
});

app.get("/balance/:addr", (req, res) => {
  try {
    const parts = req.params.addr.split(".");
    const address = parts[0];
    const token = parts[1];

    if (!address) {
      return res.status(400).json({ error: "Invalid address format" });
    }

    res.json(bc.calculateBalance(address, false, token));
  } catch (error: any) {
    handleApiError(error, `GET /balance/${req.params.addr}`, res);
  }
});

app.get("/locked/:addr", (req, res) => {
  try {
    const parts = req.params.addr.split(".");
    const address = parts[0];
    const token = parts[1];

    if (!address) {
      return res.status(400).json({ error: "Invalid address format" });
    }

    res.json(bc.calculateLocked(address, token));
  } catch (error: any) {
    handleApiError(error, `GET /locked/${req.params.addr}`, res);
  }
});

app.get("/balance-mempool/:addr", (req, res) => {
  try {
    const parts = req.params.addr.split(".");
    const address = parts[0];
    const token = parts[1];

    if (!address) {
      return res.status(400).json({ error: "Invalid address format" });
    }

    res.json(bc.calculateBalance(address, true, token));
  } catch (error: any) {
    handleApiError(error, `GET /balance-mempool/${req.params.addr}`, res);
  }
});

app.get("/tokens/:addr", (req, res) => {
  try {
    const address = req.params.addr;
    if (!address) {
      return res.status(400).json({ error: "Invalid address" });
    }

    const tokens: string[] = [];
    for (const token of bc.mintedTokens) {
      if (bc.calculateBalance(address, true, token[0]) !== 0) {
        tokens.push(token[0]);
      }
    }
    res.json(tokens);
  } catch (error: any) {
    handleApiError(error, `GET /tokens/${req.params.addr}`, res);
  }
});

app.get("/token-info/:token", (req, res) => {
  try {
    const tokenInfo = bc.mintedTokens.get(req.params.token);
    if (!tokenInfo) {
      return res.status(404).json({ error: "Token not found" });
    }
    res.json(tokenInfo);
  } catch (error: any) {
    handleApiError(error, `GET /token-info/${req.params.token}`, res);
  }
});

app.get("/token-count", (_, res) => {
  try {
    res.json({ count: bc.mintedTokens.size });
  } catch (error: any) {
    handleApiError(error, "GET /token-count", res);
  }
});

app.get("/token/:i", (req, res) => {
  try {
    const index = parseInt(req.params.i);
    if (isNaN(index) || index < 0 || index >= bc.mintedTokens.size) {
      return res.status(400).json({ error: "Invalid token index" });
    }

    // Convert Map to array and get the token at the specified index
    const tokens = Array.from(bc.mintedTokens.entries());
    const [tokenName, tokenInfo] = tokens[index];
    res.json({ token: tokenName, ...tokenInfo });
  } catch (error: any) {
    handleApiError(error, `GET /token/${req.params.i}`, res);
  }
});

app.get("/history/:addr", (req, res) => {
  try {
    const addr = req.params.addr;
    if (!addr) {
      return res.status(400).json({ error: "Invalid address" });
    }

    const history: {
      type: "send" | "receive" | "mint";
      amount: number;
      token?: string;
      timestamp: number;
      status: "confirmed" | "pending";
      address: string;
      blockHeight?: number;
    }[] = [];

    // Get confirmed transactions from blocks
    for (let i = 0; i < bc.height; i++) {
      const block = bc.getBlock(i);
      for (const tx of block.transactions) {
        if (tx.sender === addr || tx.receiver === addr) {
          // Skip network transactions unless they're rewards to this address
          if (tx.sender === "network" && tx.receiver !== addr) continue;

          const type =
            tx.sender === addr ? "send" : tx.mint ? "mint" : "receive";
          const otherAddress = tx.sender === addr ? tx.receiver : tx.sender;

          history.push({
            type,
            amount: tx.amount,
            token: tx.token,
            timestamp: tx.timestamp,
            status: "confirmed",
            address: otherAddress,
            blockHeight: i,
          });
        }
      }
    }

    // Get pending transactions from mempool
    for (const tx of bc.mempool) {
      if (tx.sender === addr || tx.receiver === addr) {
        const type = tx.sender === addr ? "send" : "receive";
        const otherAddress = tx.sender === addr ? tx.receiver : tx.sender;

        history.push({
          type,
          amount: tx.amount,
          token: tx.token,
          timestamp: tx.timestamp,
          status: "pending",
          address: otherAddress,
        });
      }
    }

    // Sort by timestamp, most recent first
    history.sort((a, b) => b.timestamp - a.timestamp);
    res.json(history);
  } catch (error: any) {
    handleApiError(error, `GET /history/${req.params.addr}`, res);
  }
});

app.get("/search-blocks/:hash", (req, res) => {
  try {
    const hash = req.params.hash;
    if (!hash) {
      return res.status(400).json({ error: "Invalid block hash" });
    }

    // Search through blocks to find matching hash
    for (let i = 0; i < bc.height; i++) {
      const block = bc.getBlock(i);
      if (block.hash === hash) {
        return res.json({ block, height: i });
      }
    }
    res.status(404).json({ error: "Block not found" });
  } catch (error: any) {
    handleApiError(error, `GET /search-blocks/${req.params.hash}`, res);
  }
});

app.get("/search-tx/:query", (req, res) => {
  try {
    const query = req.params.query;
    if (!query) {
      return res.status(400).json({ error: "Invalid search query" });
    }

    const results: { tx: Transaction; blockHeight?: number }[] = [];

    // Search in blocks
    for (let i = 0; i < bc.height; i++) {
      const block = bc.getBlock(i);
      for (const tx of block.transactions) {
        if (
          tx.signature === query ||
          tx.sender === query ||
          tx.receiver === query
        ) {
          results.push({ tx, blockHeight: i });
        }
      }
    }

    // Search in mempool
    for (const tx of bc.mempool) {
      if (
        tx.signature === query ||
        tx.sender === query ||
        tx.receiver === query
      ) {
        results.push({ tx });
      }
    }

    res.json({ results });
  } catch (error: any) {
    handleApiError(error, `GET /search-tx/${req.params.query}`, res);
  }
});

const httpPort = parseInt(process.env.HTTP_PORT ?? "8000");
app.listen(httpPort, () => {
  ui.logLeft(
    `\x1b[36m[NODE]\x1b[0m Node initialization completed successfully`
  );
});
