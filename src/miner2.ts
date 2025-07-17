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

// Config file path
const CONFIG_PATH = "miner.json";

// Default config
const defaultConfig = {
  wsUrl: "ws://localhost:6061",
  httpUrl: "http://localhost:8000",
  private: "PRIVATE_WALLET_KEY",
  token: "",
};

// Load or create config
function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(defaultConfig, null, 2));
    console.log(`Config file created at ${CONFIG_PATH}`);
    return defaultConfig;
  } else {
    try {
      return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    } catch (err) {
      console.error("Error parsing config file, using default config.");
      return defaultConfig;
    }
  }
}

const config = loadConfig();

// Main async function
const main = async () => {
  const fc = new FeelessClient(config.wsUrl, config.httpUrl, config.private);
  await fc.init();

  let mempool: Transaction[] = await fc.getMempool();
  let bh = await fc.getBlockHeight();
  let prevHash = (await fc.getBlock(bh - 1)).hash;
  let reward = calculateReward(bh);
  let diff = await fc.getDiff();
  let nonce = 0;

  fc.onutx = (tx) => {
    mempool.push(tx);
  };

  fc.onblock = async (block) => {
    diff = await fc.getDiff();
    bh++;
    reward = calculateReward(bh);
    prevHash = block.hash;
  };

  console.log("Starting mining loop...");

  while (true) {
    const now = Date.now();

    // Create coinbase + dev fee transactions
    const rewardTxs: Transaction[] = [
      {
        sender: "network",
        receiver: DEV_WALLET,
        amount: FLSStoFPoints(reward * DEV_FEE),
        signature: "",
        nonce: Math.floor(Math.random() * 1e6),
        timestamp: now,
      },
      {
        sender: "network",
        receiver: fc.getPublic(),
        amount: config.token
          ? (await fc.getTokenInfo(config.token)).miningReward
          : FLSStoFPoints(reward * (1 - DEV_FEE)),
        signature: "",
        nonce: Math.floor(Math.random() * 1e6),
        timestamp: now,
        token: config.token || undefined,
      },
    ];

    const block: Block = {
      timestamp: now,
      transactions: [...mempool, ...rewardTxs],
      prev_hash: prevHash,
      nonce,
      signature: "",
      proposer: fc.getPublic(),
      hash: "",
    };

    const hash = await hashArgon(
      JSON.stringify({ ...block, hash: "", signature: "" })
    );

    if (hash <= diff) {
      block.signature = fc.signMessage(
        JSON.stringify({ ...block, hash: "", signature: "" })
      );
      block.hash = hash.toString(16);
      console.log("🎉 Found block!", block);

      const success = await fc.submitBlock(block);
      console.log(success ? "✅ Success!" : "❌ Failure!");
      mempool = []; // Clear mempool after successful block
      bh++;
      reward = calculateReward(bh);
      prevHash = block.hash;
      diff = await fc.getDiff(); // Refresh diff
      nonce = 0;
    } else {
      nonce++;
      if (nonce % 5000 === 0) {
        console.log(`Mining... nonce=${nonce}, mempool=${mempool.length}`);
      }
    }
  }
};

main();
