import { Block, calculateReward, DEV_FEE, DEV_WALLET, FeelessClient, FLSStoFPoints, hashArgon, Transaction } from "feeless-utils";

const fc = new FeelessClient("ws://localhost:6061", "http://localhost:8000", "1aa37a7e1a3a3c10302c6643f48a37c4d9e19e2432850443dd3b33f12dfecc89a4");
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
      amount: FLSStoFPoints(reward * (1 - DEV_FEE)),
      // amount: 1000,
      signature: '',
      nonce: Math.floor(Math.random() * 1e6),
      timestamp: Date.now(),
      // token: "PEPE"
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