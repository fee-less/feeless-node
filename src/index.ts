import { calculateMintFee, calculateReward, FLSStoFPoints, getDiff, hashArgon, Transaction } from "feeless-utils";
import Blockchain from "./blockchain.js";
import P2PNetwork from "./p2pnet.js";
import express from "express";
import { config } from "dotenv";
import cors from "cors";
import fs from "fs";
if (!fs.existsSync(".env")) fs.writeFileSync(".env",
  `PEER=ws://fee-less.com:6061
PEER_HTTP=http://fee-less.com:8000
PORT=6061
HTTP_PORT=8000`
);

config();

const app = express();
app.use(cors());

(async () => {
  let blocks = [
    {
      timestamp: Date.now(),
      transactions: [
        {
          sender: "network",
          receiver:
            "03bea510ff0689107a3a7b3ff3968e0554672142bbf6fc6db75d01e7aa6620e4f8",
          amount: FLSStoFPoints(5000000),
          signature: "network",
          nonce: 0,
          timestamp: Date.now(),
        },
      ],
      prev_hash: "genesis",
      nonce: 0,
      signature:
        "3045022100e057f5f136f3f0e5b837660287db7b696b433c8a56665319a829293526d39814022023d6e513727b6b1de23fa28b9a8dee7efb4d91876cd83f1b3993c83a880f7e1a",
      proposer:
        "03bea510ff0689107a3a7b3ff3968e0554672142bbf6fc6db75d01e7aa6620e4f8",
      hash: "11f0ef7e028354a51d802f85b7da8b46e6bab6d5683af65e0831d0fdaeb7e3",
    },
  ];

  if (fs.existsSync("blockchain")) {
    for (const block of fs.readdirSync("blockchain").sort((a, b) => parseInt(a) - parseInt(b))) {
      blocks.push(JSON.parse(fs.readFileSync("blockchain/" + block, "utf-8")));
    }
  }

  if (process.env.PEER_HTTP !== "") {
    console.log("");
    const myHeight = blocks.length;
    const height = (await fetch(process.env.PEER_HTTP + "/height").then(res => res.json())).height;
    console.log("Syncing " + (height - myHeight) + " blocks...");

    const totalWidth = process.stdout.columns - 7 || 50;

    for (let i = myHeight; i < height; i++) {
      const block = await fetch(process.env.PEER_HTTP + "/block/" + i).then(res => res.json());
      blocks[i] = block;
      if (!fs.existsSync("blockchain")) fs.mkdirSync("blockchain");
      fs.writeFileSync("blockchain/" + i, JSON.stringify(block));

      // Progress bar calculation
      const progress = (i + 1) / height;
      const filledBarLength = Math.floor(progress * totalWidth);
      const emptyBarLength = totalWidth - filledBarLength;
      const bar = "█".repeat(filledBarLength) + "-".repeat(emptyBarLength);

      // Print bar with carriage return
      process.stdout.write(`\r[${bar}] ${Math.floor(progress * 100)}%`);
    }
    if ((await fetch(process.env.PEER_HTTP + "/height").then(res => res.json())).height != blocks.length) throw Error("Desynced. Please rerun feeless-node.");

    // Final newline after loading bar completes
    console.log("\nDone syncing blocks.");
  }  

  const bc = new Blockchain(blocks);
  bc.onSynced = async () => {
    if (!process.env.PEER_HTTP) return;
    console.log("Syncing mempool...")
    const mempoolTxs: Transaction[] = await fetch(
      process.env.PEER_HTTP + "/mempool"
    ).then((res) => res.json());

    for (const tx of mempoolTxs) {
      bc.pushTX(tx); // will validate + add to local mempool
    }
    console.log("Done syncing mempool.");
  }

  new P2PNetwork(process.env.PEER ?? "", parseInt(process.env.PORT ?? "6061"), bc);

  app.get("/block/:height", (req, res) => {
    try {
      res.json(bc.blocks[parseInt(req.params.height)]);
    } catch(e: any) {
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
    // Return all pending transactions
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
})();