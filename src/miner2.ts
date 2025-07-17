import { Block, calculateReward, DEV_FEE, DEV_WALLET, FeelessClient, FLSStoFPoints, hashArgon, Transaction } from "feeless-utils";
import fs from "fs";

// Define config file path
const CONFIG_PATH = "miner.json";

// Default config values
const defaultConfig = {
  wsUrl: "ws://localhost:6061",
  httpUrl: "http://localhost:8000",
  private: "PRIVATE_WALLET_KEY",
  token: "",
};

// Function to load or create config file
function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    // Create config file if missing
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(defaultConfig, null, 2));
    console.log(`Config file created at ${CONFIG_PATH}`);
    return defaultConfig;
  } else {
    // Read and parse config file
    const raw = fs.readFileSync(CONFIG_PATH, "utf8");
    try {
      return JSON.parse(raw);
    } catch (err) {
      console.error("Error parsing config file, using default config.");
      return defaultConfig;
    }
  }
}

const config = loadConfig();

// Now create your FeelessClient with the loaded config
const fc = new FeelessClient(config.wsUrl, config.httpUrl, config.private);
await fc.init();

let mempool: Transaction[] = await fc.getMempool();
let bh = await fc.getBlockHeight();
let prevHash = (await fc.getBlock(bh - 1)).hash;
let reward = calculateReward(bh);
let nonce = 0;
let diff = await fc.getDiff();

fc.onutx = tx => {
  mempool.push(tx);
};

fc.onblock = async block => {
  diff = await fc.getDiff();
  bh++;
  reward = calculateReward(bh);
  prevHash = block.hash;
}

const miningLoop = async () => {
  const block: Block = {
    timestamp: Date.now(),
    transactions: [...mempool, {
      sender: 'network',
      receiver: DEV_WALLET,
      amount: FLSStoFPoints(reward * DEV_FEE),
      signature: '',
      nonce: Math.floor(Math.random() * 1e6),
      timestamp: Date.now(),
    }, {
      sender: 'network',
      receiver: fc.getPublic(),
      amount: !config.token ? FLSStoFPoints(reward * (1 - DEV_FEE)) : (await fc.getTokenInfo(config.token)).miningReward,
      signature: '',
      nonce: Math.floor(Math.random() * 1e6),
      timestamp: Date.now(),
      token: config.token ? config.token : undefined
    }],
    prev_hash: prevHash,
    nonce,
    signature: "",
    proposer: fc.getPublic(),
    hash: ""
  }

  nonce++;
  const hash = await hashArgon(JSON.stringify({ ...block, hash: '', signature: '' }));
  if (hash > diff) {
    if (nonce % 100 === 0) console.log(`Mining... (nonce: ${nonce}) (${mempool.length} transactions in mempool)`);
    if (nonce % 100 === 0) return setTimeout(miningLoop, 0); 
    return miningLoop();
  }

  block.signature = fc.signMessage(JSON.stringify({ ...block, hash: '', signature: '' }));
  block.hash = hash.toString(16);
  console.log("Found block!", block);

  console.log(await fc.submitBlock(block) ? "Success!" : "Failiure!");
  mempool = [];
  miningLoop();
}

miningLoop();