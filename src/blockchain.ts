import pkg from 'elliptic';
const { ec: EC } = pkg;
import cryptoJS from 'crypto-js';
import { Block, Transaction, BLOCK_TIME, DEV_WALLET, FLSStoFPoints, calculateReward, DEV_FEE, calculateMintFee, MintedTokens, hashArgon, getDiff, STARTING_DIFF, TAIL } from "feeless-utils"
const { SHA256 } = cryptoJS;

const ec = new EC("secp256k1");

class Blockchain {
  public blocks: Block[] = [];
  public mempool: Transaction[] = [];
  public mintedTokens: MintedTokens = new Map(); // Track minted tokens and their mining rules
  public onSynced: () => void = () => {};
  private usedSignatures: string[] = [];
  private lastNonces: Map<string, number> = new Map(); // Track last nonce for each address
  private readonly MAX_USED_SIGNATURES = 100000; // Keep last 100k signatures
  private _syncPromise: Promise<void> | null = null;
  private _syncResolve: (() => void) | null = null;

  constructor(blocks: Block[]) {
    this._syncPromise = new Promise((resolve) => {
      this._syncResolve = resolve;
    });
    (async () => {
      // Initialize mintedTokens and lastNonces from existing blocks
      let genesis = true;
      for (const block of blocks) {
        if (genesis) {
          this.blocks.push(block);
          genesis = false;
          continue;
        }
        this.mempool.push(...block.transactions);
        if (!(await this.addBlock(block, true, true))) {
          console.log(
            "[WARNING] SOMEONE MIGHT BE TAMPERING WITH YOUR NODE. The node you are syncing from has sent you a bad block. consider changing it for a diffrent one.",
            block
          );
          return;
        }
      }
      this.onSynced();
      if (this._syncResolve) this._syncResolve();
    })();
  }

  async waitForSync() {
    if (this._syncPromise) {
      await this._syncPromise;
    }
  }

  calculateBalance(
    addr: string,
    includeMempool = false,
    token: undefined | string = undefined
  ) {
    let bal = 0;
    // First check mempool if includeMempool is true to prevent double spending
    if (includeMempool) {
      for (const tx of this.mempool) {
        if (this.usedSignatures.includes(tx.signature)) continue; // Skip if signature already used
        if (token || tx.token) {
          if (tx.receiver === addr && tx.token === token) bal += tx.amount;
          if (tx.sender === addr && tx.token === token) bal -= tx.amount;
          continue;
        }
        if (tx.receiver === addr && (!tx.unlock || tx.unlock < Date.now()))
          bal += tx.amount;
        if (tx.sender === addr) bal -= tx.amount;
      }
    }
    // Then check confirmed blocks
    for (const block of this.blocks) {
      for (const tx of block.transactions) {
        if (token || tx.token) {
          if (
            tx.receiver === addr &&
            tx.token === token &&
            (!tx.unlock || tx.unlock < Date.now())
          )
            bal += tx.amount;
          if (tx.sender === addr && tx.token === token) bal -= tx.amount;
          continue;
        }
        if (tx.receiver === addr && (!tx.unlock || tx.unlock < Date.now()))
          bal += tx.amount;
        if (tx.sender === addr) bal -= tx.amount;
      }
    }
    return bal;
  }

  calculateLocked(
    addr: string,
    token?: string
  ) {
    let bal = 0;
    // Then check confirmed blocks
    for (const block of this.blocks) {
      for (const tx of block.transactions) {
        if (token || tx.token) {
          if (
            tx.receiver === addr &&
            tx.token === token &&
            tx.unlock &&
            tx.unlock >= Date.now()
          ) bal += tx.amount;
          continue;
        }
        if (tx.receiver === addr && tx.unlock && tx.unlock >= Date.now()) bal += tx.amount;
      }
    }
    return bal;
  }

  pushTX(tx: Transaction) {
    if (tx.sender === "network" || tx.sender === "mint") return false;
    if (this.checkTX(tx)) {
      // Handle mint transaction and airdrop
      if (tx.mint && tx.receiver === DEV_WALLET) {
        // Check if token was already minted
        if (this.mintedTokens.has(tx.mint.token)) {
          console.log("Token " + tx.mint.token + " has already been minted!");
          return false;
        }

        // If there's an airdrop amount, create and push an airdrop transaction from mint to minter
        if (tx.mint.airdrop > 0) {
          const airdropTx: Transaction = {
            sender: "mint",
            receiver: tx.sender, // Airdrop goes to the minter
            amount: tx.mint.airdrop,
            signature: "mint",
            nonce: Math.round(Math.random() * 1e6),
            timestamp: Date.now(),
            token: tx.mint.token,
          };
          this.mempool.push(airdropTx);
        }
      }
      this.mempool.push(tx);
      return true;
    }
    return false;
  }

  checkTX(
    tx: Transaction,
    ignoreMempoolBalance = true,
    isBlockValidation = false
  ) {
    if (!Number.isInteger(tx.amount) || tx.amount <= 0) {
      console.log("Invalid transaction amount.");
      return false;
    }

    if (tx.unlock && !Number.isInteger(tx.unlock)) {
      console.log("Invalid unlock param.");
      return false;
    }

    if (tx.unlock && tx.timestamp >= tx.unlock) {
      console.log("Invalid unlock time.");
      return false;
    }

    // Handle mint transactions
    if (tx.sender === "mint" && tx.signature === "mint" && tx.token) {
      // Check both existing tokens and pending mints in mempool
      const tokenInfo = this.mintedTokens.get(tx.token);
      if (!tokenInfo) {
        // Check if token is being minted in mempool
        for (const pendingTx of this.mempool) {
          if (
            pendingTx.mint &&
            pendingTx.receiver === DEV_WALLET &&
            pendingTx.amount ===
              calculateMintFee(this.blocks.length, this.mintedTokens.size) &&
            pendingTx.mint.token === tx.token
          ) {
            if (tx.unlock) {
              console.log("Mint tx cannot be locked.");
              return false;
            }
            // Found pending mint, validate airdrop amount
            if (tx.amount !== pendingTx.mint.airdrop) {
              console.log("Invalid airdrop amount");
              return false;
            }
            // Check if airdrop was already claimed in previous blocks
            for (const block of this.blocks) {
              for (const btx of block.transactions) {
                if (
                  btx.sender === "mint" &&
                  btx.signature === "mint" &&
                  btx.token === tx.token &&
                  btx.amount === pendingTx.mint.airdrop
                ) {
                  console.log("Airdrop was already claimed");
                  return false;
                }
              }
            }
            return true;
          }
        }
        console.log("Transaction for non-existent token");
        return false;
      }

      // Token exists, validate airdrop amount
      if (tx.amount !== tokenInfo.airdrop) {
        console.log("Invalid airdrop amount");
        return false;
      }

      // Check if airdrop was already claimed in previous blocks
      for (const block of this.blocks) {
        for (const btx of block.transactions) {
          if (
            btx.sender === "mint" &&
            btx.signature === "mint" &&
            btx.token === tx.token &&
            btx.amount === tokenInfo.airdrop
          ) {
            console.log("Airdrop was already claimed");
            return false;
          }
        }
      }

      return true;
    }

    // Handle minting transaction
    if (tx.mint) {
      const expectedFee = calculateMintFee(
        this.blocks.length,
        this.mintedTokens.size
      );
      if (tx.receiver !== DEV_WALLET || tx.amount !== expectedFee || tx.unlock) {
        console.log(
          `Invalid minting transaction - must be sent to ${DEV_WALLET} with fee ${expectedFee}, got: ${tx.amount} ${tx.receiver}`
        );
        return false;
      }

      if (tx.timestamp > 1754043286413) {
        const lastNonce = this.lastNonces.get(tx.sender) || 0;
        if (tx.nonce <= lastNonce) {
          console.log(
            "Invalid transaction nonce - must be greater than last used nonce"
          );
          return false;
        }

        const key = ec.keyFromPublic(tx.sender, "hex");
        if (
          !key.verify(
            SHA256(JSON.stringify({ ...tx, signature: "" })).toString(),
            tx.signature
          )
        ) {
          console.log("Invalid transaction signature.");
          return false;
        }
        if (this.usedSignatures.includes(tx.signature)) {
          console.log("Transaction signature already used.");
          return false;
        }
      }

      // Check if user has enough balance to pay the minting fee
      if (this.calculateBalance(tx.sender, false) < expectedFee) {
        console.log("Insufficient balance to pay minting fee");
        return false;
      }

      const token = tx.mint.token;
      if (token.toLowerCase() === "flss") {
        console.log("Token is trying to impersonate FLSS token.");
        return false;
      }
      if (token.toLowerCase() === "" || token.length >= 20) {
        console.log("Token is empty, or too long");
        return false;
      }
      if (!/^[A-Z]+$/.test(token)) {
        console.log("Token name is invalid");
        return false;
      }

      // Check if token already exists
      if (isBlockValidation) {
        if (this.mintedTokens.has(token)) {
          console.log("Token " + token + " has already been minted!");
          return false;
        }
      } else {
        // Check both mintedTokens and current mempool
        if (this.mintedTokens.has(token)) {
          console.log("Token " + token + " has already been minted!");
          return false;
        }
        // Check if token is being minted in current mempool
        for (const pendingTx of this.mempool) {
          if (pendingTx.mint && pendingTx.mint.token === token) {
            console.log(
              "Token " + token + " is already being minted in mempool!"
            );
            return false;
          }
        }
      }

      // Validate mining reward if specified
      if (
        tx.mint.miningReward !== undefined &&
        (!Number.isInteger(tx.mint.miningReward) || tx.mint.miningReward <= 0)
      ) {
        console.log("Invalid mining reward amount");
        return false;
      }

      // Validate airdrop amount
      if (!Number.isInteger(tx.mint.airdrop) || tx.mint.airdrop < 0) {
        console.log("Invalid airdrop amount");
        return false;
      }

      return true;
    }

    // Normal transaction validation
    if (tx.sender !== "network" && tx.sender !== "mint") {
      // Add nonce validation
      const lastNonce = this.lastNonces.get(tx.sender) || 0;
      if (tx.nonce <= lastNonce) {
        console.log(
          "Invalid transaction nonce - must be greater than last used nonce"
        );
        return false;
      }

      const key = ec.keyFromPublic(tx.sender, "hex");
      if (
        !key.verify(
          SHA256(JSON.stringify({ ...tx, signature: "" })).toString(),
          tx.signature
        )
      ) {
        console.log("Invalid transaction signature.");
        return false;
      }
      if (
        this.calculateBalance(tx.sender, ignoreMempoolBalance, tx.token) <
        tx.amount
      ) {
        console.log("Insufficient balance.");
        return false;
      }
      if (this.usedSignatures.includes(tx.signature)) {
        console.log("Transaction signature already used.");
        return false;
      }
    }
    return true;
  }

  private validateBlockRewards(block: Block): {
    isValid: boolean;
    hasDevFee: boolean;
    hasReward: boolean;
  } {
    let hasDevFee = false;
    let hasReward = false;
    let tokenRewardTx = false;
    const pendingMints = new Map<
      string,
      { miningReward: number; airdrop: number }
    >();

    // First pass: collect all mint transactions in this block
    for (const tx of block.transactions) {
      if (tx.mint && tx.receiver === DEV_WALLET) {
        const expectedFee = calculateMintFee(
          this.blocks.length,
          this.mintedTokens.size
        );
        if (tx.amount === expectedFee) {
          pendingMints.set(tx.mint.token, {
            miningReward: tx.mint.miningReward || 0,
            airdrop: tx.mint.airdrop,
          });
        }
      }
    }

    // Second pass: validate all transactions
    for (const tx of block.transactions) {
      // Validate dev fee transaction
      if (tx.sender === "network" && tx.receiver === DEV_WALLET && !tx.token) {
        if (tx.unlock) {
          console.log("Dev fee tx cannot be locked.");
          return { isValid: false, hasDevFee, hasReward };
        }

        if (hasDevFee) {
          console.log("Block has multiple dev fee transactions");
          return { isValid: false, hasDevFee, hasReward };
        }

        hasDevFee = true;
        continue;
      }

      // Validate reward transaction
      if (tx.sender === "network" && tx.receiver !== DEV_WALLET) {
        if (tx.unlock) {
          console.log("Reward tx cannot be locked.");
          return { isValid: false, hasDevFee, hasReward };
        }

        if (tokenRewardTx) {
          console.log("Block has multiple reward transactions");
          return { isValid: false, hasDevFee, hasReward };
        }

        if (tx.token) {
          // Token reward validation - check both existing and pending mints
          const tokenInfo =
            this.mintedTokens.get(tx.token) || pendingMints.get(tx.token);
          if (!tokenInfo) {
            console.log("Reward TX token doesn't exist!");
            return { isValid: false, hasDevFee, hasReward };
          }
          if (tokenInfo.miningReward === 0) {
            console.log("Token is not minable!");
            return { isValid: false, hasDevFee, hasReward };
          }
          if (tokenInfo.miningReward !== tx.amount) {
            console.log("Reward TX amount doesn't match token mining reward!");
            return { isValid: false, hasDevFee, hasReward };
          }
        } else {
          // FLSS reward validation
          if (
            tx.amount !==
            Math.round(calculateReward(this.blocks.length) * (1 - DEV_FEE))
          ) {
            console.log(`Invalid FLSS reward amount: ${tx.amount}`);
            return { isValid: false, hasDevFee, hasReward };
          }
        }
        hasReward = true;
        tokenRewardTx = true;
        continue;
      }

      // Validate airdrop transaction
      if (tx.sender === "mint" && tx.token) {
        if (tx.unlock) {
          console.log("Mint tx cannot be locked.");
          return { isValid: false, hasDevFee, hasReward };
        }
        // Check both existing and pending mints
        const tokenInfo =
          this.mintedTokens.get(tx.token) || pendingMints.get(tx.token);
        if (!tokenInfo) {
          console.log("Airdrop for non-existent token");
          return { isValid: false, hasDevFee, hasReward };
        }
        if (tx.amount !== tokenInfo.airdrop) {
          console.log("Invalid airdrop amount");
          return { isValid: false, hasDevFee, hasReward };
        }
        // Check if airdrop was already claimed in previous blocks
        for (const b of this.blocks) {
          for (const btx of b.transactions) {
            if (
              btx.sender === "mint" &&
              btx.signature === "mint" &&
              btx.token === tx.token &&
              btx.amount === tokenInfo.airdrop
            ) {
              console.log("Airdrop was already claimed");
              return { isValid: false, hasDevFee, hasReward };
            }
          }
        }
        // Check if airdrop was already claimed in this block (before this tx)
        for (const btx of block.transactions) {
          if (btx === tx) break; // Stop when we reach current tx
          if (
            btx.sender === "mint" &&
            btx.signature === "mint" &&
            btx.token === tx.token &&
            btx.amount === tokenInfo.airdrop
          ) {
            console.log("Airdrop was already claimed in this block");
            return { isValid: false, hasDevFee, hasReward };
          }
        }
        continue;
      }
    }

    return { isValid: true, hasDevFee, hasReward };
  }

  async checkBlock(block: Block, isBackchecking = false, skipHashing = false) {
    if (BigInt(getDiff(this.blocks.slice(-TAIL))) < BigInt("0x" + block.hash)) {
      console.log("Block has invalid diff!");
      return false;
    }
    if (
      getDiff(
        this.blocks.slice(-TAIL)
      ) !== BigInt("0x" + block.diff)
    ) {
      console.log("Block has invalid diff parameter!");
      return false;
    }
    // Prevent multiple transactions from the same sender (excluding dev fee and reward txs)
    const seenSenders = new Set<string>();
    for (const tx of block.transactions) {
      // Ignore dev fee and reward transactions
      if (tx.sender === "network") continue;
      if (tx.sender === "mint") continue;
      if (seenSenders.has(tx.sender)) {
        console.log(
          `Block contains multiple transactions from sender: ${tx.sender}`
        );
        return false;
      }
      seenSenders.add(tx.sender);
    }

    let length = 0;
    for (const tx of this.mempool) {
      if (tx.timestamp <= block.timestamp) length++;
    }

    // Add future timestamp validation
    if (block.timestamp > Date.now() + 10000) {
      console.log("Block timestamp is in the future!");
      return false;
    }
    if (!isBackchecking && block.timestamp < Date.now() - BLOCK_TIME) {
      console.log("Too old block!");
      return false;
    }

    if (!isBackchecking && block.transactions.length - 2 < 0.75 * length) {
      // Minimum 75 % of txs from mempool
      console.log(
        `Block has not enough transactions, got ${
          block.transactions.length
        }, expected at least ${0.75 * this.mempool.length}`
      );
      return false;
    }

    // Check if the provided hash matches the calculated hash of the block
    if (
      !skipHashing &&
      (
        await hashArgon(JSON.stringify({ ...block, hash: "", signature: "" }))
      ).toString(16) !== block.hash
    ) {
      console.log(
        `Block hash is invalid. Calculated: ${(
          await hashArgon(JSON.stringify({ ...block, hash: "", signature: "" }))
        ).toString(16)}, Expected: ${block.hash}`
      );
      return false;
    }

    // Check if the previous hash in the current block matches the hash of the previous block
    if (
      this.blocks.length > 0 &&
      block.prev_hash !== this.blocks[this.blocks.length - 1].hash
    ) {
      console.log("Previous block hash is invalid.");
      return false;
    }

    // Check if the provided signature is valid
    if (
      !ec
        .keyFromPublic(block.proposer, "hex")
        .verify(
          SHA256(
            JSON.stringify({ ...block, hash: "", signature: "" })
          ).toString(),
          block.signature
        )
    ) {
      console.log("Invalid block signature!");
      return false;
    }

    // Validate block rewards and dev fee
    const { isValid, hasDevFee, hasReward } = this.validateBlockRewards(block);
    if (!isValid) {
      return false;
    }
    if (!hasDevFee) {
      console.log("Block missing dev fee transaction");
      return false;
    }
    if (!hasReward) {
      console.log("Block missing reward transaction");
      return false;
    }

    // Check the validity of each transaction in the block
    for (const tx of block.transactions) {
      for (const pendingTx of this.mempool) {
        if (
          pendingTx.signature === tx.signature &&
          pendingTx.amount === tx.amount &&
          pendingTx.nonce === tx.nonce &&
          pendingTx.receiver === tx.receiver &&
          pendingTx.sender === tx.sender &&
          pendingTx.token === tx.token
        ) {
          // If this is a mint transaction, verify it's not already minted
          if (
            pendingTx.mint &&
            pendingTx.receiver === DEV_WALLET &&
            pendingTx.amount ===
              calculateMintFee(this.blocks.length, this.mintedTokens.size)
          ) {
            if (this.mintedTokens.has(pendingTx.mint.token)) {
              console.log(
                "Token " + pendingTx.mint.token + " has already been minted!"
              );
              return false;
            }
          }
        }
      }

      // Pass isBlockValidation=true when checking transactions in a block
      if (!this.checkTX(tx, false, true)) {
        console.log(`Invalid TX:\n${JSON.stringify(tx, null, 2)}`);
        return false;
      }
    }

    return true;
  }

  async addBlock(block: Block, isBackchecking = false, skipHashing = false) {
    if (await this.checkBlock(block, isBackchecking, skipHashing)) {
      // Update mintedTokens for any mint transactions in this block
      for (const tx of block.transactions) {
        if (tx.mint && tx.receiver === DEV_WALLET) {
          this.mintedTokens.set(tx.mint.token, {
            miningReward: tx.mint.miningReward || 0,
            airdrop: tx.mint.airdrop,
          });
        }
      }

      this.blocks.push(block);

      // Add new signatures and cleanup old ones
      this.usedSignatures.push(...block.transactions.map((tx) => tx.signature));
      if (this.usedSignatures.length > this.MAX_USED_SIGNATURES) {
        // Keep only the most recent signatures
        this.usedSignatures = this.usedSignatures.slice(
          -this.MAX_USED_SIGNATURES
        );
      }

      // Remove transactions from mempool
      for (const pendingTx of this.mempool) {
        for (const tx of block.transactions) {
          if (
            tx.receiver === pendingTx.receiver &&
            tx.sender === pendingTx.sender &&
            tx.token === pendingTx.token &&
            tx.signature === pendingTx.signature
          ) {
            this.mempool = this.mempool.filter((mtx) => mtx !== pendingTx);
          }
        }
      }
      if (isBackchecking) return true;
      console.log(`Added new block!\n${JSON.stringify(block, null, 2)}`);
      console.log(
        `Still have ${this.mempool.length} transactions in mempool to mine...`
      );
      return true;
    }
    console.log("Rejecting Block...");
    return false;
  }

  tryPackageBlocks() {}
}

export default Blockchain;