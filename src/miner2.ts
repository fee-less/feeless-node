import cluster from "cluster";
import os from "os";
import {
  Block,
  calculateReward,
  DEV_FEE,
  DEV_WALLET,
  FeelessClient,
  FLSStoFPoints,
  hashArgon,
  Transaction,
} from "feeless-utils";
import fs from "fs";

const CONFIG_PATH = "miner.json";
const CPU_COUNT = os.cpus().length;

const defaultConfig = {
  wsUrl: "ws://localhost:6061",
  httpUrl: "http://localhost:8000",
  private: "PRIVATE_WALLET_KEY",
  token: "",
  workers: CPU_COUNT,
};

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(defaultConfig, null, 2));
    console.log(`Config file created at ${CONFIG_PATH}`);
    return defaultConfig;
  } else {
    const raw = fs.readFileSync(CONFIG_PATH, "utf8");
    try {
      return { ...defaultConfig, ...JSON.parse(raw) };
    } catch {
      console.error("Error parsing config file. Using default.");
      return defaultConfig;
    }
  }
}

const config = loadConfig();

if (cluster.isPrimary) {
  console.log(
    `Primary PID ${process.pid}, spawning ${config.workers} workers.`
  );

  for (let i = 0; i < config.workers; i++) cluster.fork();

  let paused = false;
  const hashrate: { [id: string]: number } = {};

  // Collect hash rate updates
  for (const id in cluster.workers) {
    const worker = cluster.workers[id];
    if (!worker) continue;

    worker.on("message", async (rawMsg) => {
      const msg = rawMsg as { type: string; block?: Block; hashes?: number };

      if (msg.type === "block_found" && !paused && msg.block) {
        paused = true;
        console.log(
          `\nBlock found by worker ${worker?.process.pid}. Halting workers.`
        );

        for (const id in cluster.workers) {
          cluster.workers[id]?.send({ type: "halt" });
        }

        const fc = new FeelessClient(
          config.wsUrl,
          config.httpUrl,
          config.private
        );
        await fc.init();

        const result = await fc.submitBlock(msg.block);
        console.log(
          `Block submission result from ${worker?.process.pid}: ${
            result ? "✅ Success" : "❌ Failure"
          }`
        );

        setTimeout(() => {
          paused = false;
          for (const id in cluster.workers) {
            cluster.workers[id]?.send({ type: "resume" });
          }
        }, 2000);
      }

      if (msg.type === "hashrate" && msg.hashes !== undefined) {
        hashrate[worker?.id ?? ""] = msg.hashes;
      }
    });
  }

  // Print global hash rate every second
  setInterval(() => {
    const total = Object.values(hashrate).reduce((a, b) => a + b, 0);
    console.log(
      `Hashrate: ${total.toLocaleString()} H/s (${
        Object.keys(hashrate).length
      } workers)`
    );
    for (const id in hashrate) hashrate[id] = 0; // Reset counters
  }, 1000);

  cluster.on("exit", (worker) => {
    console.log(`Worker ${worker.process.pid} died. Respawning...`);
    cluster.fork();
  });
} else {
  (async () => {
    const fc = new FeelessClient(config.wsUrl, config.httpUrl, config.private);
    await fc.init();

    let mempool: Transaction[] = await fc.getMempool();
    let bh = await fc.getBlockHeight();
    let prevHash = (await fc.getBlock(bh - 1)).hash;
    let reward = calculateReward(bh);
    let nonce = Math.floor(Math.random() * 1e6);
    let diff = await fc.getDiff();
    let halted = false;
    let hashes = 0;

    fc.onutx = (tx) => mempool.push(tx);
    fc.onblock = async (block) => {
      diff = await fc.getDiff();
      bh = await fc.getBlockHeight();
      reward = calculateReward(bh);
      prevHash = block.hash;
    };

    process.on("message", async (rawMsg) => {
      const msg = rawMsg as { type: string };

      if (msg.type === "halt") {
        halted = true;
      } else if (msg.type === "resume") {
        bh = await fc.getBlockHeight();
        prevHash = (await fc.getBlock(bh - 1)).hash;
        reward = calculateReward(bh);
        diff = await fc.getDiff();
        mempool = await fc.getMempool();
        nonce = Math.floor(Math.random() * 1e6);
        halted = false;
        miningLoop();
      }
    });

    // Send hashrate to master every second
    setInterval(() => {
      if (process.send) {
        process.send({ type: "hashrate", hashes });
      }
      hashes = 0;
    }, 1000);

    const miningLoop = async () => {
      if (halted) return;

      const block: Block = {
        timestamp: Date.now(),
        transactions: [
          ...mempool,
          {
            sender: "network",
            receiver: DEV_WALLET,
            amount: FLSStoFPoints(reward * DEV_FEE),
            signature: "",
            nonce: Math.floor(Math.random() * 1e6),
            timestamp: Date.now(),
          },
          {
            sender: "network",
            receiver: fc.getPublic(),
            amount: !config.token
              ? FLSStoFPoints(reward * (1 - DEV_FEE))
              : (await fc.getTokenInfo(config.token)).miningReward,
            signature: "",
            nonce: Math.floor(Math.random() * 1e6),
            timestamp: Date.now(),
            token: config.token || undefined,
          },
        ],
        prev_hash: prevHash,
        nonce,
        signature: "",
        proposer: fc.getPublic(),
        hash: "",
      };

      nonce++;
      hashes++; // Count hash attempt

      const hash = await hashArgon(
        JSON.stringify({ ...block, hash: "", signature: "" })
      );

      if (halted) return;

      if (hash > diff) {
        return setImmediate(miningLoop);
      }

      block.signature = fc.signMessage(
        JSON.stringify({ ...block, hash: "", signature: "" })
      );
      block.hash = hash.toString(16);

      if (process.send) {
        console.log("Found @" + bh);
        process.send({ type: "block_found", block });
      }
    };

    miningLoop();
  })();
}
