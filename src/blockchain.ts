import pkg from "elliptic";
import fs from "fs";
const { ec: EC } = pkg;
import cryptoJS from "crypto-js";
import {
  Block,
  Transaction,
  BLOCK_TIME,
  DEV_WALLET,
  calculateReward,
  DEV_FEE,
  calculateMintFee,
  MintedTokens,
  hashArgon,
  getDiff,
  TAIL,
} from "feeless-utils";
import { SplitTerminalUI } from "./ui.js";
const { SHA256 } = cryptoJS;

const ec = new EC("secp256k1");

class Blockchain {
  public mempool: Transaction[] = [];
  public mintedTokens: MintedTokens = new Map(); // Track minted tokens and their mining rules
  public onSynced: () => void = () => {};
  public height: number = 0;
  public lastBlock: string = "";
  public folder: string;
  private usedSignatures: string[] = [];
  private lastNonces: Map<string, number> = new Map(); // Track last nonce for each address
  private balances: Map<string, number> = new Map(); // Track balances for each address
  private lockedBalances: {
    amount: number;
    unlock: number;
    addr: string;
    token?: string;
  }[] = []; // Track balances for each address
  private readonly MAX_USED_SIGNATURES = 10000; // Keep last 10k signatures
  private _syncPromise: Promise<void> | null = null;
  private _syncResolve: (() => void) | null = null;
  private ui: SplitTerminalUI;

  constructor(
    blocks: Block[],
    folder: string = "blockchain",
    ui?: SplitTerminalUI
  ) {
    this.folder = folder;
    this.ui = ui || new SplitTerminalUI();
    this.ui.logRight(
      `\x1b[36m[BLOCKCHAIN]\x1b[0m Initializing blockchain with \x1b[33m${blocks.length}\x1b[0m blocks...`
    );

    this._syncPromise = new Promise((resolve) => {
      this._syncResolve = resolve;
    });
    (async () => {
      // Initialize mintedTokens and lastNonces from existing blocks
      let genesis = true;
      for (const block of blocks) {
        if (genesis) {
          for (const tx of block.transactions) {
            // Update balances map
            const sender = this.calculateBalance(tx.sender, false, tx.token);
            const receiver = this.calculateBalance(
              tx.receiver,
              false,
              tx.token
            );

            this.balances.set(
              tx.sender + (tx.token ? "." + tx.token : ""),
              sender - tx.amount
            );
            if (sender - tx.amount === 0)
              this.balances.delete(
                tx.sender + (tx.token ? "." + tx.token : "")
              );

            if (tx.unlock && tx.unlock > block.timestamp) {
              this.lockedBalances.push({
                amount: tx.amount,
                unlock: tx.unlock,
                addr: tx.receiver,
              });
              continue;
            }

            this.balances.set(
              tx.receiver + (tx.token ? "." + tx.token : ""),
              receiver + tx.amount
            );
          }
          this.height++;
          this.lastBlock = block.hash;
          genesis = false;
          continue;
        }
        this.mempool.push(...block.transactions);
        if (!(await this.addBlock(block, true, true))) {
          console.error(
            `\x1b[31m[BLOCKCHAIN]\x1b[0m CRITICAL: Invalid block detected during initialization - potential tampering`
          );
          console.error(
            `\x1b[35m[BLOCKCHAIN]\x1b[0m Block details: ${JSON.stringify(
              block,
              null,
              2
            )}`
          );
          console.error(
            `\x1b[33m[BLOCKCHAIN]\x1b[0m Consider switching to a different sync node`
          );
          return;
        }
      }
      console.error(
        `\x1b[32m[BLOCKCHAIN]\x1b[0m Blockchain initialization completed - Height: \x1b[36m${this.height}\x1b[0m`
      );
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
    // Then
    bal +=
      this.balances.get(addr + (token ? "." + token.toUpperCase() : "")) ?? 0;
    return bal;
  }

  calculateLocked(addr: string, token?: string) {
    let bal = 0;
    this.lockedBalances.forEach((lb) => {
      if (lb.addr === addr && lb.token === token) bal + lb.amount;
    });
    return bal;
  }

  pushTX(tx: Transaction) {
    if (tx.sender === "network" || tx.sender === "mint") return false;
    if (this.checkTX(tx)) {
      // Handle mint transaction and airdrop
      if (tx.mint && tx.receiver === DEV_WALLET) {
        // Check if token was already minted
        if (this.mintedTokens.has(tx.mint.token)) {
          this.ui.logRight(
            `\x1b[31m[BLOCKCHAIN]\x1b[0m Token \x1b[35m${tx.mint.token}\x1b[0m already minted - rejecting duplicate`
          );
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
          this.ui.logRight(
            `\x1b[32m[BLOCKCHAIN]\x1b[0m Airdrop transaction created for \x1b[35m${tx.mint.token}\x1b[0m: \x1b[33m${tx.mint.airdrop}\x1b[0m tokens`
          );
        }
      }
      this.mempool.push(tx);
      return true;
    }
    return false;
  }

  checkTX(
    tx: Transaction,
    includeMempoolBalance = false,
    isBlockValidation = false
  ) {
    if (!Number.isInteger(tx.amount) || tx.amount <= 0) {
      this.ui.logRight(
        `\x1b[31m[BLOCKCHAIN]\x1b[0m Transaction rejected - Invalid amount: \x1b[33m${tx.amount}\x1b[0m`
      );
      return false;
    }

    if (tx.unlock && !Number.isInteger(tx.unlock)) {
      this.ui.logRight(
        `\x1b[31m[BLOCKCHAIN]\x1b[0m Transaction rejected - Invalid unlock parameter`
      );
      return false;
    }

    if (tx.unlock && tx.timestamp >= tx.unlock) {
      this.ui.logRight(
        `\x1b[31m[BLOCKCHAIN]\x1b[0m Transaction rejected - Invalid unlock time`
      );
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
              calculateMintFee(this.height, this.mintedTokens.size) &&
            pendingTx.mint.token === tx.token
          ) {
            if (tx.unlock) {
              this.ui.logRight(
                `\x1b[31m[BLOCKCHAIN]\x1b[0m Mint transaction rejected - Cannot be locked`
              );
              return false;
            }
            // Found pending mint, validate airdrop amount
            if (tx.amount !== pendingTx.mint.airdrop) {
              this.ui.logRight(
                `\x1b[31m[BLOCKCHAIN]\x1b[0m Mint transaction rejected - Invalid airdrop amount`
              );
              return false;
            }
            if (this.mintedTokens.has(tx.token)) {
              this.ui.logRight(
                `\x1b[31m[BLOCKCHAIN]\x1b[0m Mint transaction rejected - Airdrop not claimed at token mint`
              );
              return false;
            }
            return true;
          }
        }
        this.ui.logRight(
          `\x1b[31m[BLOCKCHAIN]\x1b[0m Transaction rejected - Token \x1b[35m${tx.token}\x1b[0m does not exist`
        );
        return false;
      }

      // Token exists, validate airdrop amount
      if (tx.amount !== tokenInfo.airdrop) {
        this.ui.logRight(
          `\x1b[31m[BLOCKCHAIN]\x1b[0m Transaction rejected - Invalid airdrop amount for \x1b[35m${tx.token}\x1b[0m`
        );
        return false;
      }

      return true;
    }

    // Handle minting transaction
    if (tx.mint) {
      const expectedFee = calculateMintFee(this.height, this.mintedTokens.size);
      if (
        tx.receiver !== DEV_WALLET ||
        tx.amount !== expectedFee ||
        tx.unlock
      ) {
        this.ui.logRight(
          `\x1b[31m[BLOCKCHAIN]\x1b[0m Mint transaction rejected - Invalid parameters (fee: \x1b[33m${expectedFee}\x1b[0m, receiver: \x1b[35m${DEV_WALLET}\x1b[0m)`
        );
        return false;
      }

      if (tx.timestamp > 1754043286413) {
        if (this.lastNonces.has(tx.nonce + "")) {
          this.ui.logRight(
            `\x1b[31m[BLOCKCHAIN]\x1b[0m Transaction rejected - Invalid nonce`
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
          this.ui.logRight(
            `\x1b[31m[BLOCKCHAIN]\x1b[0m Transaction rejected - Invalid signature`
          );
          return false;
        }
        if (this.usedSignatures.includes(tx.signature)) {
          this.ui.logRight(
            `\x1b[31m[BLOCKCHAIN]\x1b[0m Transaction rejected - Signature already used`
          );
          return false;
        }
      }

      // Check if user has enough balance to pay the minting fee
      if (this.calculateBalance(tx.sender, false) < expectedFee) {
        this.ui.logRight(
          `\x1b[31m[BLOCKCHAIN]\x1b[0m Mint transaction rejected - Insufficient balance for fee`
        );
        return false;
      }

      const token = tx.mint.token;
      if (token.toLowerCase() === "flss") {
        this.ui.logRight(
          `\x1b[31m[BLOCKCHAIN]\x1b[0m Token rejected - Cannot impersonate FLSS token`
        );
        return false;
      }
      if (token.toLowerCase() === "" || token.length >= 20) {
        this.ui.logRight(
          `\x1b[31m[BLOCKCHAIN]\x1b[0m Token rejected - Invalid length (must be 1-19 characters)`
        );
        return false;
      }
      if (!/^[A-Z]+$/.test(token)) {
        this.ui.logRight(
          `\x1b[31m[BLOCKCHAIN]\x1b[0m Token rejected - Invalid format (uppercase letters only)`
        );
        return false;
      }

      // Check if token already exists
      if (isBlockValidation) {
        if (this.mintedTokens.has(token)) {
          this.ui.logRight(
            `\x1b[31m[BLOCKCHAIN]\x1b[0m Token \x1b[35m${token}\x1b[0m rejected - Already minted`
          );
          return false;
        }
      } else {
        // Check both mintedTokens and current mempool
        if (this.mintedTokens.has(token)) {
          this.ui.logRight(
            `\x1b[31m[BLOCKCHAIN]\x1b[0m Token \x1b[35m${token}\x1b[0m rejected - Already minted`
          );
          return false;
        }
        // Check if token is being minted in current mempool
        for (const pendingTx of this.mempool) {
          if (pendingTx.mint && pendingTx.mint.token === token) {
            this.ui.logRight(
              `\x1b[31m[BLOCKCHAIN]\x1b[0m Token \x1b[35m${token}\x1b[0m rejected - Already being minted in mempool`
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
        this.ui.logRight(
          `\x1b[31m[BLOCKCHAIN]\x1b[0m Mint transaction rejected - Invalid mining reward`
        );
        return false;
      }

      // Validate airdrop amount
      if (!Number.isInteger(tx.mint.airdrop) || tx.mint.airdrop < 0) {
        this.ui.logRight(
          `\x1b[31m[BLOCKCHAIN]\x1b[0m Mint transaction rejected - Invalid airdrop amount`
        );
        return false;
      }

      return true;
    }

    // Normal transaction validation
    if (tx.sender !== "network" && tx.sender !== "mint") {
      // Add nonce validation
      const lastNonce = this.lastNonces.get(tx.sender) || 0;
      if (tx.nonce <= lastNonce) {
        this.ui.logRight(
          `\x1b[31m[BLOCKCHAIN]\x1b[0m Transaction rejected - Nonce must be greater than \x1b[33m${lastNonce}\x1b[0m`
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
        this.ui.logRight(
          `\x1b[31m[BLOCKCHAIN]\x1b[0m Transaction rejected - Invalid signature`
        );
        return false;
      }
      if (
        this.calculateBalance(tx.sender, includeMempoolBalance, tx.token) <
        tx.amount
      ) {
        this.ui.logRight(
          `\x1b[31m[BLOCKCHAIN]\x1b[0m Transaction rejected - Insufficient balance`
        );
        return false;
      }
      if (this.usedSignatures.includes(tx.signature)) {
        this.ui.logRight(
          `\x1b[31m[BLOCKCHAIN]\x1b[0m Transaction rejected - Signature already used`
        );
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
          this.height,
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
          this.ui.logRight(
            `\x1b[31m[BLOCKCHAIN]\x1b[0m Block validation failed - Dev fee transaction cannot be locked`
          );
          return { isValid: false, hasDevFee, hasReward };
        }

        if (hasDevFee) {
          this.ui.logRight(
            `\x1b[31m[BLOCKCHAIN]\x1b[0m Block validation failed - Multiple dev fee transactions`
          );
          return { isValid: false, hasDevFee, hasReward };
        }

        hasDevFee = true;
        continue;
      }

      // Validate reward transaction
      if (tx.sender === "network" && tx.receiver !== DEV_WALLET) {
        if (tx.unlock) {
          this.ui.logRight(
            `\x1b[31m[BLOCKCHAIN]\x1b[0m Block validation failed - Reward transaction cannot be locked`
          );
          return { isValid: false, hasDevFee, hasReward };
        }

        if (tokenRewardTx) {
          this.ui.logRight(
            `\x1b[31m[BLOCKCHAIN]\x1b[0m Block validation failed - Multiple reward transactions`
          );
          return { isValid: false, hasDevFee, hasReward };
        }

        if (tx.token) {
          // Token reward validation - check both existing and pending mints
          const tokenInfo =
            this.mintedTokens.get(tx.token) || pendingMints.get(tx.token);
          if (!tokenInfo) {
            this.ui.logRight(
              `\x1b[31m[BLOCKCHAIN]\x1b[0m Block validation failed - Reward for non-existent token \x1b[35m${tx.token}\x1b[0m`
            );
            return { isValid: false, hasDevFee, hasReward };
          }
          if (tokenInfo.miningReward === 0) {
            this.ui.logRight(
              `\x1b[31m[BLOCKCHAIN]\x1b[0m Block validation failed - Token \x1b[35m${tx.token}\x1b[0m is not minable`
            );
            return { isValid: false, hasDevFee, hasReward };
          }
          if (tokenInfo.miningReward !== tx.amount) {
            this.ui.logRight(
              `\x1b[31m[BLOCKCHAIN]\x1b[0m Block validation failed - Invalid reward amount for \x1b[35m${tx.token}\x1b[0m`
            );
            return { isValid: false, hasDevFee, hasReward };
          }
        } else {
          // FLSS reward validation
          const expectedReward = Math.round(
            calculateReward(this.height) * (1 - DEV_FEE)
          );
          if (tx.amount !== expectedReward) {
            this.ui.logRight(
              `\x1b[31m[BLOCKCHAIN]\x1b[0m Block validation failed - Invalid FLSS reward: \x1b[33m${tx.amount}\x1b[0m (expected: \x1b[32m${expectedReward}\x1b[0m)`
            );
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
          this.ui.logRight(
            `\x1b[31m[BLOCKCHAIN]\x1b[0m Block validation failed - Mint transaction cannot be locked`
          );
          return { isValid: false, hasDevFee, hasReward };
        }
        // Check both existing and pending mints
        const tokenInfo =
          this.mintedTokens.get(tx.token) || pendingMints.get(tx.token);
        if (!tokenInfo) {
          this.ui.logRight(
            `\x1b[31m[BLOCKCHAIN]\x1b[0m Block validation failed - Airdrop for non-existent token \x1b[35m${tx.token}\x1b[0m`
          );
          return { isValid: false, hasDevFee, hasReward };
        }
        if (tx.amount !== tokenInfo.airdrop) {
          this.ui.logRight(
            `\x1b[31m[BLOCKCHAIN]\x1b[0m Block validation failed - Invalid airdrop amount for \x1b[35m${tx.token}\x1b[0m`
          );
          return { isValid: false, hasDevFee, hasReward };
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
            this.ui.logRight(
              `\x1b[31m[BLOCKCHAIN]\x1b[0m Block validation failed - Duplicate airdrop in block for \x1b[35m${tx.token}\x1b[0m`
            );
            return { isValid: false, hasDevFee, hasReward };
          }
        }
        continue;
      }
    }

    return { isValid: true, hasDevFee, hasReward };
  }

  async checkBlock(block: Block, isBackchecking = false, skipHashing = false) {
    if (BigInt(getDiff(this.getTail())) < BigInt("0x" + block.hash)) {
      this.ui.logRight(
        `\x1b[31m[BLOCKCHAIN]\x1b[0m Block rejected - Invalid difficulty: \x1b[33m${block.hash}\x1b[0m`
      );
      return false;
    }
    if (getDiff(this.getTail()) !== BigInt("0x" + block.diff)) {
      this.ui.logRight(
        `\x1b[31m[BLOCKCHAIN]\x1b[0m Block rejected - Invalid difficulty parameter (got: \x1b[33m${
          block.diff
        }\x1b[0m, instead of: \x1b[32m${getDiff(this.getTail()).toString(
          16
        )}\x1b[0m)`
      );
      return false;
    }
    // Prevent multiple transactions from the same sender (excluding dev fee and reward txs)
    const seenSenders = new Set<string>();
    for (const tx of block.transactions) {
      // Ignore dev fee and reward transactions
      if (tx.sender === "network") continue;
      if (tx.sender === "mint") continue;
      if (seenSenders.has(tx.sender)) {
        this.ui.logRight(
          `\x1b[31m[BLOCKCHAIN]\x1b[0m Block rejected - Multiple transactions from sender: \x1b[35m${tx.sender.substring(
            0,
            8
          )}...\x1b[0m`
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
      this.ui.logRight(
        `\x1b[31m[BLOCKCHAIN]\x1b[0m Block rejected - Timestamp in future`
      );
      return false;
    }
    if (!isBackchecking && block.timestamp < Date.now() - BLOCK_TIME) {
      this.ui.logRight(
        `\x1b[31m[BLOCKCHAIN]\x1b[0m Block rejected - Timestamp too old`
      );
      return false;
    }

    if (!isBackchecking && block.transactions.length - 2 < 0.75 * length) {
      // Minimum 75 % of txs from mempool
      this.ui.logRight(
        `\x1b[31m[BLOCKCHAIN]\x1b[0m Block rejected - Insufficient transactions: \x1b[33m${
          block.transactions.length
        }\x1b[0m (expected: \x1b[32m${Math.ceil(0.75 * length)}\x1b[0m)`
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
      const calculatedHash = (
        await hashArgon(JSON.stringify({ ...block, hash: "", signature: "" }))
      ).toString(16);
      this.ui.logRight(
        `\x1b[31m[BLOCKCHAIN]\x1b[0m Block rejected - Hash mismatch (calculated: \x1b[33m${calculatedHash.substring(
          0,
          16
        )}...\x1b[0m, provided: \x1b[35m${block.hash.substring(
          0,
          16
        )}...\x1b[0m)`
      );
      return false;
    }

    // Check if the previous hash in the current block matches the hash of the previous block
    if (this.height > 0 && block.prev_hash !== this.lastBlock) {
      this.ui.logRight(
        `\x1b[31m[BLOCKCHAIN]\x1b[0m Block rejected - Invalid previous hash`
      );
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
      this.ui.logRight(
        `\x1b[31m[BLOCKCHAIN]\x1b[0m Block rejected - Invalid proposer signature`
      );
      return false;
    }

    // Validate block rewards and dev fee
    const { isValid, hasDevFee, hasReward } = this.validateBlockRewards(block);
    if (!isValid) {
      return false;
    }
    if (!hasDevFee) {
      this.ui.logRight(
        `\x1b[31m[BLOCKCHAIN]\x1b[0m Block rejected - Missing dev fee transaction`
      );
      return false;
    }
    if (!hasReward) {
      this.ui.logRight(
        `\x1b[31m[BLOCKCHAIN]\x1b[0m Block rejected - Missing reward transaction`
      );
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
              calculateMintFee(this.height, this.mintedTokens.size)
          ) {
            if (this.mintedTokens.has(pendingTx.mint.token)) {
              this.ui.logRight(
                `[BLOCKCHAIN] Block rejected - Token ${pendingTx.mint.token} already minted`
              );
              return false;
            }
          }
        }
      }

      // Pass isBlockValidation=true when checking transactions in a block
      if (!this.checkTX(tx, false, true)) {
        this.ui.logRight(
          `\x1b[31m[BLOCKCHAIN]\x1b[0m Block rejected - Invalid transaction from \x1b[35m${tx.sender.substring(
            0,
            8
          )}...\x1b[0m`
        );
        return false;
      }
    }

    return true;
  }

  async addBlock(block: Block, isBackchecking = false, skipHashing = false) {
    for (const lb of this.lockedBalances) {
      if (lb.unlock <= block.timestamp) {
        const receiver = this.calculateBalance(lb.addr, false, lb.token);
        this.balances.set(
          lb.addr + (lb.token ? "." + lb.token : ""),
          receiver + lb.amount
        );
        this.lockedBalances = this.lockedBalances.filter((lb_) => lb_ !== lb);
      }
    }

    if (await this.checkBlock(block, isBackchecking, skipHashing)) {
      // Update mintedTokens for any mint transactions in this block
      for (const tx of block.transactions) {
        if (tx.mint && tx.receiver === DEV_WALLET) {
          this.mintedTokens.set(tx.mint.token, {
            miningReward: tx.mint.miningReward || 0,
            airdrop: tx.mint.airdrop,
          });
          this.ui.logRight(
            `\x1b[32m[BLOCKCHAIN]\x1b[0m Token \x1b[35m${tx.mint.token}\x1b[0m minted successfully`
          );
        }
        // Update balances map
        const senderKey = tx.sender + (tx.token ? "." + tx.token : "");
        const receiverKey = tx.receiver + (tx.token ? "." + tx.token : "");

        const senderBal = this.balances.get(senderKey) ?? 0;
        const receiverBal = this.balances.get(receiverKey) ?? 0;

        this.balances.set(senderKey, senderBal - tx.amount);
        if (senderBal - tx.amount === 0) {
          this.balances.delete(senderKey);
        }

        if (tx.unlock && tx.unlock > block.timestamp) {
          this.lockedBalances.push({
            amount: tx.amount,
            unlock: tx.unlock,
            addr: tx.receiver,
            token: tx.token,
          });
          continue;
        }

        this.balances.set(receiverKey, receiverBal + tx.amount);
      }

      this.height++;
      this.lastBlock = block.hash;

      // Add new signatures and cleanup old ones
      this.usedSignatures.push(...block.transactions.map((tx) => tx.signature));
      if (this.usedSignatures.length > this.MAX_USED_SIGNATURES) {
        // Keep only the most recent signatures
        this.usedSignatures = this.usedSignatures.slice(
          -this.MAX_USED_SIGNATURES
        );
      }

      // Remove transactions from mempool
      let removedCount = 0;
      for (const pendingTx of this.mempool) {
        for (const tx of block.transactions) {
          if (
            tx.receiver === pendingTx.receiver &&
            tx.sender === pendingTx.sender &&
            tx.token === pendingTx.token &&
            tx.signature === pendingTx.signature
          ) {
            this.mempool = this.mempool.filter((mtx) => mtx !== pendingTx);
            removedCount++;
          }
        }
      }

      if (!isBackchecking) {
        this.ui.logRight(
          `\x1b[32m[BLOCKCHAIN]\x1b[0m Block \x1b[36m${
            this.height - 1
          }\x1b[0m added successfully - Transactions: \x1b[33m${
            block.transactions.length
          }\x1b[0m, Mempool cleared: \x1b[35m${removedCount}\x1b[0m`,
          true
        );
      }

      return true;
    }

    if (!isBackchecking) {
      this.ui.logRight(
        `\x1b[31m[BLOCKCHAIN]\x1b[0m Block \x1b[33m${block.hash.substring(
          0,
          16
        )}...\x1b[0m rejected and discarded`
      );
    }
    return false;
  }

  getTail() {
    return this.getSlice(Math.max(this.height - TAIL, 0), this.height);
  }

  getSlice(start: number, end: number) {
    const blocks: Block[] = [];
    for (let i = start; i < end; i++) {
      blocks.push(this.getBlock(i));
    }
    return blocks;
  }

  getBlock(h: number): Block {
    try {
      return JSON.parse(
        fs.readFileSync(this.folder + "/" + h, "utf-8")
      ) as Block;
    } catch (error: any) {
      this.ui.logRight(
        `\x1b[31m[BLOCKCHAIN]\x1b[0m Failed to read block \x1b[36m${h}\x1b[0m: ${error.message}`
      );
      throw error;
    }
  }

  // Blockchain status and diagnostics
  getStatus() {
    return {
      height: this.height,
      lastBlock: this.lastBlock.substring(0, 16) + "...",
      mempoolSize: this.mempool.length,
      mintedTokens: this.mintedTokens.size,
      totalBalances: this.balances.size,
      lockedBalances: this.lockedBalances.length,
      usedSignatures: this.usedSignatures.length,
    };
  }

  printStatus(): void {
    const status = this.getStatus();
    const timestamp = new Date()
      .toISOString()
      .replace("T", " ")
      .substring(0, 19);

    this.ui.logLeft(`\x1b[36m[BLOCKCHAIN STATUS]\x1b[0m`);
    this.ui.logLeft(`  Height: \x1b[32m${status.height}\x1b[0m`);
    this.ui.logLeft(`  Last Block: \x1b[33m${status.lastBlock}\x1b[0m`);
    this.ui.logLeft(`  Mempool Size: \x1b[35m${status.mempoolSize}\x1b[0m`);
    this.ui.logLeft(`  Minted Tokens: \x1b[36m${status.mintedTokens}\x1b[0m`);
    this.ui.logLeft(
      `  Active Balances: \x1b[32m${status.totalBalances}\x1b[0m`
    );
    this.ui.logLeft(
      `  Locked Balances: \x1b[33m${status.lockedBalances}\x1b[0m`
    );
    this.ui.logLeft(
      `  Signature Cache: \x1b[35m${status.usedSignatures}\x1b[0m/\x1b[36m${this.MAX_USED_SIGNATURES}\x1b[0m`
    );
  }
}

export default Blockchain;
