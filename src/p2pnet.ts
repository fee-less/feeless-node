import { WebSocketServer, WebSocket } from "ws";
import { Block, getDiff, Transaction, EventPayload } from "feeless-utils";
import Blockchain from "./blockchain.js";
import fs from "fs";
import { onBlock, onMint, onTX } from "./webhooks.js";
import readline from "readline";
import CryptoJS from "crypto-js";

interface SyncState {
  isActive: boolean;
  startHeight: number;
  targetHeight: number;
}

class P2PNetwork {
  public bc: Blockchain;
  private wss: WebSocketServer;
  private wscs: Map<string, WebSocket>;
  private peerReconnectTimeouts: Map<string, NodeJS.Timeout> = new Map();
  private peerReconnectAttempts: Map<string, number> = new Map();
  private silencedPeers: Set<string> = new Set();
  public onBlockReceived?: (block: Block) => void;
  private peerUrls: string[];
  private syncState: SyncState = {
    isActive: false,
    startHeight: 0,
    targetHeight: 0,
  };
  private lastSeenBlock = "";
  private lastSeenPush = "";
  private readonly MAX_RECONNECT_ATTEMPTS = 3;
  private readonly HEARTBEAT_INTERVAL = 10000;
  private readonly WATCHDOG_INTERVAL = 20000;
  private readonly RECONNECT_DELAY = 10000;
  private rl?: readline.Interface;
  private isShuttingDown = false;
  private stopIncoming = false;

  constructor(peer: string, port: number, bc: Blockchain) {
    this.bc = bc;
    this.peerUrls = peer ? peer.split(",").filter((url) => url.trim()) : [];
    this.wss = new WebSocketServer({ port });
    this.wscs = new Map();

    this.initializePeerConnections();
    this.initializeWebSocketServer();
    this.setupProcessHandlers();
    this.setupKeyboardListener();
    setInterval(this.watchDog.bind(this), this.WATCHDOG_INTERVAL);

    console.log(`\x1b[36m[P2P]\x1b[0m Network initialized on port ${port}`);
    if (this.peerUrls.length > 0) {
      console.log(
        `\x1b[36m[P2P]\x1b[0m Configured peers: ${this.peerUrls.length}`
      );
    }
    console.log(
      `\x1b[36m[P2P]\x1b[0m Press 'p' to print network status, 'b' to print blockchain status, 'q' to quit gracefully`
    );
  }

  private setupProcessHandlers(): void {
    // Handle graceful shutdown on process termination
    process.on("SIGINT", async () => {
      console.log(
        "\n\x1b[33m[P2P]\x1b[0m Received SIGINT, shutting down gracefully..."
      );
      await this.shutdown();
      process.exit(0);
    });

    process.on("SIGTERM", async () => {
      console.log(
        "\n\x1b[33m[P2P]\x1b[0m Received SIGTERM, shutting down gracefully..."
      );
      await this.shutdown();
      process.exit(0);
    });

    // Handle uncaught exceptions
    process.on("uncaughtException", async (error) => {
      console.error("\x1b[31m[P2P]\x1b[0m Uncaught exception:", error);
      await this.shutdown();
      process.exit(1);
    });

    process.on("unhandledRejection", async (reason, promise) => {
      console.error(
        "\x1b[31m[P2P]\x1b[0m Unhandled rejection at:",
        promise,
        "reason:",
        reason
      );
      await this.shutdown();
      process.exit(1);
    });
  }

  private setupKeyboardListener(): void {
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    // Enable raw mode to capture single key presses
    if (process.stdin.setRawMode) {
      process.stdin.setRawMode(true);
    }

    process.stdin.on("keypress", (str, key) => {
      if (key && key.name === "p") {
        this.printNetworkStatus();
      } else if (key && key.control && key.name === "c") {
        this.shutdown().then(() => {
          process.exit(0);
        });
      } else if (key && key.name === "b") {
        this.bc.printStatus();
      } else if (key && key.name === "q") {
        console.log(
          "\n\x1b[33m[P2P]\x1b[0m Graceful shutdown initiated by user..."
        );
        this.shutdown().then(() => {
          process.exit(0);
        });
      } else if (key && key.name === "s") {
        this.stopIncoming = !this.stopIncoming;
        process.stdout.write(
          "\rAccepting from peers: " + !this.stopIncoming + "\n"
        );
      }
    });
  }

  private initializePeerConnections(): void {
    this.peerUrls.forEach((peerUrl) => this.createPeerSocket(peerUrl.trim()));
  }

  private initializeWebSocketServer(): void {
    this.wss.addListener("connection", (ws) => {
      ws.on("message", (data) => {
        try {
          const payload: EventPayload = JSON.parse(data.toString());
          this.onPeerPayload(payload);
        } catch (e: any) {
          console.error(
            `\x1b[31m[P2P]\x1b[0m Invalid payload received: ${e.message}`
          );
        }
      });

      ws.on("error", (err) => {
        console.error(
          `\x1b[31m[P2P]\x1b[0m WebSocket client error: ${err.message}`
        );
      });
    });

    this.wss.on("error", (err) => {
      console.error(
        `\x1b[31m[P2P]\x1b[0m WebSocket server error: ${err.message}`
      );
    });
  }

  private createPeerSocket(peerUrl: string): WebSocket | null {
    try {
      if (!this.silencedPeers.has(peerUrl)) {
        console.log(`\x1b[36m[P2P]\x1b[0m Connecting to peer: ${peerUrl}`);
      }
      const ws = new WebSocket(peerUrl);
      this.wscs.set(peerUrl, ws);

      ws.addEventListener("message", (data) => {
        try {
          const payload: EventPayload = JSON.parse(data.data.toString());
          this.onPeerPayload(payload);
        } catch (e: any) {
          if (!this.silencedPeers.has(peerUrl)) {
            console.error(
              `\x1b[31m[P2P]\x1b[0m Peer message error from ${peerUrl}: ${e.message}`
            );
          }
        }
      });

      ws.addEventListener("open", () => {
        // Reset reconnect attempts on successful connection
        this.peerReconnectAttempts.set(peerUrl, 0);

        // Un-silence the peer if it was silenced
        if (this.silencedPeers.has(peerUrl)) {
          this.silencedPeers.delete(peerUrl);
          console.log(
            `\x1b[32m[P2P]\x1b[0m Peer ${peerUrl} reconnected and un-silenced`
          );
        } else {
          console.log(`\x1b[32m[P2P]\x1b[0m Connected to peer: ${peerUrl}`);
        }

        this.startHeartbeat(ws, peerUrl);
        this.clearReconnectTimeout(peerUrl);
      });

      ws.addEventListener("close", (event) => {
        if (!this.silencedPeers.has(peerUrl)) {
          console.log(
            `\x1b[33m[P2P]\x1b[0m Disconnected from peer: ${peerUrl} (code: ${event.code})`
          );
        }
        this.wscs.delete(peerUrl);
        this.scheduleReconnect(peerUrl);
      });

      ws.addEventListener("error", (event) => {
        if (!this.silencedPeers.has(peerUrl)) {
          console.error(
            `\x1b[31m[P2P]\x1b[0m Peer connection error for ${peerUrl}:`,
            event.error || event.message
          );
        }
      });

      return ws;
    } catch (error: any) {
      if (!this.silencedPeers.has(peerUrl)) {
        console.error(
          `\x1b[31m[P2P]\x1b[0m Failed to create peer socket for ${peerUrl}: ${error.message}`
        );
      }
      return null;
    }
  }

  private startHeartbeat(ws: WebSocket, peerUrl: string): void {
    let isAlive = true;
    let missedPings = 0;
    const MAX_MISSED_PINGS = 3;

    ws.on("pong", () => {
      isAlive = true;
      missedPings = 0;
    });

    const interval = setInterval(() => {
      if (!isAlive) {
        missedPings++;
        if (missedPings >= MAX_MISSED_PINGS) {
          if (!this.silencedPeers.has(peerUrl)) {
            console.warn(
              `\x1b[33m[P2P]\x1b[0m Peer ${peerUrl} not responding after ${MAX_MISSED_PINGS} pings, terminating connection`
            );
          }
          clearInterval(interval);
          ws.terminate();
          return;
        }
      }

      isAlive = false;
      try {
        if (ws.readyState === WebSocket.OPEN) {
          ws.ping();
        }
      } catch (err: any) {
        if (!this.silencedPeers.has(peerUrl)) {
          console.error(
            `\x1b[31m[P2P]\x1b[0m Failed to ping ${peerUrl}: ${err.message}`
          );
        }
        clearInterval(interval);
        ws.terminate();
      }
    }, this.HEARTBEAT_INTERVAL);

    const cleanup = () => clearInterval(interval);
    ws.on("close", cleanup);
    ws.on("error", cleanup);
  }

  private clearReconnectTimeout(peerUrl: string): void {
    const timeout = this.peerReconnectTimeouts.get(peerUrl);
    if (timeout) {
      clearTimeout(timeout);
      this.peerReconnectTimeouts.delete(peerUrl);
    }
  }

  private scheduleReconnect(peerUrl: string): void {
    this.clearReconnectTimeout(peerUrl);

    // Increment reconnect attempts
    const currentAttempts = this.peerReconnectAttempts.get(peerUrl) || 0;
    const newAttempts = currentAttempts + 1;
    this.peerReconnectAttempts.set(peerUrl, newAttempts);

    // Check if we should silence this peer
    if (
      newAttempts >= this.MAX_RECONNECT_ATTEMPTS &&
      !this.silencedPeers.has(peerUrl)
    ) {
      this.silencedPeers.add(peerUrl);
      console.log(
        `\x1b[33m[P2P]\x1b[0m Peer ${peerUrl} silenced after ${this.MAX_RECONNECT_ATTEMPTS} failed reconnection attempts`
      );
    }

    if (!this.silencedPeers.has(peerUrl)) {
      console.log(
        `\x1b[36m[P2P]\x1b[0m Scheduling reconnection to ${peerUrl} in ${this.RECONNECT_DELAY}ms (attempt ${newAttempts})`
      );
    }

    const timeout = setTimeout(() => {
      if (!this.silencedPeers.has(peerUrl)) {
        console.log(
          `\x1b[36m[P2P]\x1b[0m Attempting to reconnect to peer: ${peerUrl}`
        );
      }
      this.createPeerSocket(peerUrl);
      this.peerReconnectTimeouts.delete(peerUrl);
    }, this.RECONNECT_DELAY);

    this.peerReconnectTimeouts.set(peerUrl, timeout);
  }

  private async watchDog(): Promise<void> {
    if (!process.env.PEER_HTTP || this.syncState.isActive) {
      return;
    }

    try {
      const remoteHeight = await this.fetchRemoteHeight();
      if (remoteHeight === null || remoteHeight <= this.bc.height) {
        if (remoteHeight !== null && remoteHeight < this.bc.height) {
          const push = this.bc.getSlice(
            Math.max(this.bc.height - 15, 1),
            this.bc.height
          );
          this.wscs.forEach((c) =>
            c.send(
              JSON.stringify({
                event: "push",
                data: push,
              })
            )
          );
          this.lastSeenPush = CryptoJS.SHA256(JSON.stringify(push)).toString();
          console.log("\n\x1b[33m[SYNC]\x1b[0m Pushing peer to longest chain");
        }
        return;
      }

      await this.sync();
    } catch (error: any) {
      console.error(`\x1b[31m[SYNC]\x1b[0m Watchdog failed: ${error.message}`);
    }
  }

  private async sync() {
    const remote = await this.fetchRemoteHeight();
    if (!remote || remote <= this.bc.height || this.syncState.isActive) return;
    this.syncState.isActive = true;
    this.syncState.targetHeight = remote;
    try {
      console.log("[SYNC] Syncing to longer chain...");
      let fork = 0;
      for (let i = this.bc.height - 1; i >= 0; i--) {
        if (
          (await this.fetchRemoteBlock(i))!.hash === this.bc.getBlock(i).hash
        ) {
          fork = i + 1;
          this.bc.height = fork;
          this.bc.lastBlock = this.bc.getBlock(i).hash;
          break;
        }
      }
      this.syncState.startHeight = fork;
      console.log("[SYNC] Orphaning " + (this.bc.height - fork + 1) + "block" + ((this.bc.height - fork + 1) === 1 ? "" : "s"));

      this.bc.mempool = [];

      for (let i = fork; i < remote; i++) {
        const block = await this.fetchRemoteBlock(i);
        if (!block) throw new Error();
        block.transactions.forEach((tx) => this.bc.pushTX(tx));
        if (!(await this.bc.addBlock(block, true))) throw new Error();
        process.stdout.write(
          `\r[SYNC] Restoring longest chain ${i + (remote - fork)}/${
            remote - fork
          }`
        );
      }

      (await this.fetchRemoteMempool()).forEach((tx) => this.bc.pushTX(tx));

      console.log("[SYNC] Chain up to date with longest chain known.`");
      this.syncState.isActive = false;
    } catch (e) {
      console.log("[SYNC] Error syncing longer chain`");
      this.syncState.isActive = false;
    }
  }

  private async fetchRemoteHeight(): Promise<number | null> {
    try {
      const response = await fetch(`${process.env.PEER_HTTP}/height`);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      const data = await response.json();
      return data.height;
    } catch (error: any) {
      console.error(
        `\x1b[31m[SYNC]\x1b[0m Failed to fetch remote height: ${error.message}`
      );
      return null;
    }
  }

  private async fetchRemoteBlock(height: number): Promise<Block | null> {
    try {
      const response = await fetch(`${process.env.PEER_HTTP}/block/${height}`);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      return await response.json();
    } catch (error: any) {
      console.error(
        `\x1b[31m[SYNC]\x1b[0m Failed to fetch block ${height}: ${error.message}`
      );
      return null;
    }
  }

  private async fetchRemoteMempool(): Promise<Transaction[]> {
    try {
      const response = await fetch(`${process.env.PEER_HTTP}/mempool`);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      return await response.json();
    } catch (error: any) {
      console.error(
        `\x1b[31m[SYNC]\x1b[0m Failed to fetch remote mempool: ${error.message}`
      );
      return [];
    }
  }

  private async persistBlock(block: Block, height: number): Promise<void> {
    try {
      if (!fs.existsSync("blockchain")) {
        fs.mkdirSync("blockchain", { recursive: true });
      }

      await fs.promises.writeFile(
        `blockchain/${height}`,
        JSON.stringify(block, null, 2)
      );
    } catch (error: any) {
      console.error(
        `\x1b[31m[SYNC]\x1b[0m Failed to persist block ${height}: ${error.message}`
      );
      throw error;
    }
  }

  async onPeerPayload(payload: EventPayload): Promise<void> {
    if (this.stopIncoming) return;
    try {
      switch (payload.event) {
        case "tx":
          if (this.incomingTX(payload.data as Transaction)) {
            this.toPeers(payload);
          }
          break;

        case "block":
          const block = payload.data as Block;
          if (block.hash === this.bc.lastBlock) {
            return; // Already processed
          }

          if (this.onBlockReceived) {
            this.onBlockReceived(block);
          }

          if (await this.incomingBlock(block)) {
            this.toPeers(payload);
          }
          break;

        case "push":
          const subChain = payload.data as Block[];
          if (
            CryptoJS.SHA256(JSON.stringify(subChain)).toString() ===
            this.lastSeenPush
          )
            return;
          this.lastSeenPush = CryptoJS.SHA256(
            JSON.stringify(subChain)
          ).toString();

          if (subChain.length > 15) {
            console.warn(
              `\x1b[33m[P2P]\x1b[0m Received pushed chain is too long (${subChain.length} blocks). Ignoring.`
            );
            return;
          }
          for (
            let i = this.bc.height - 1;
            i >= Math.max(this.bc.height - subChain.length - 1, 0);
            i--
          ) {
            if (this.bc.getBlock(i).hash === subChain[0].prev_hash) {
              console.log(
                `\x1b[36m[P2P]\x1b[0m Orphaning local chain starting from block ${
                  i + 1
                }...`
              );
              const sh = this.bc.height;
              const slb = this.bc.lastBlock;
              this.bc.height = i + 1;
              console.log(i)
              this.bc.lastBlock = this.bc.getBlock(i).hash;

              let failed = false;
              for (const b of subChain) {
                b.transactions.map((tx) => this.bc.pushTX(tx));
                if (!(await this.bc.addBlock(b, true))) {
                  this.bc.height = sh;
                  this.bc.lastBlock = slb;
                  console.warn(
                    `\x1b[31m[P2P]\x1b[0m Failed to apply pushed block ${b.hash.substring(
                      0,
                      16
                    )}...`
                  );
                  failed = true;
                  break;
                }
              }
              if (failed) break;
              let _i = i + 1;
              for (const b of subChain) {
                fs.writeFileSync("blockchain/" + _i, JSON.stringify(b));
                _i++;
              }

              this.toPeers(payload);
              console.log(
                `\x1b[32m[P2P]\x1b[0m Successfully replaced local chain with pushed chain from block ${
                  i + 1
                } to ${i + subChain.length}`
              );
              break;
            }
          }

          break;

        default:
          console.warn(
            `\x1b[33m[P2P]\x1b[0m Unknown event type received: ${payload.event}`
          );
      }
    } catch (error: any) {
      console.error(
        `\x1b[31m[P2P]\x1b[0m Error processing peer payload: ${error.message}`
      );
    }
  }

  toPeers(data: EventPayload): void {
    const message = JSON.stringify(data);
    let sentCount = 0;

    // Send to outgoing peer connections
    this.wscs.forEach((ws, peerUrl) => {
      try {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(message);
          sentCount++;
        }
      } catch (error: any) {
        if (!this.silencedPeers.has(peerUrl)) {
          console.error(
            `\x1b[31m[P2P]\x1b[0m Failed to send to peer ${peerUrl}: ${error.message}`
          );
        }
      }
    });

    // Send to incoming connections
    this.wss.clients.forEach((ws) => {
      try {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(message);
          sentCount++;
        }
      } catch (error: any) {
        console.error(
          `\x1b[31m[P2P]\x1b[0m Failed to send to client: ${error.message}`
        );
      }
    });

    if (sentCount === 0 && data.event === "block") {
      console.warn(
        `\x1b[33m[P2P]\x1b[0m No peers available to broadcast ${data.event}`
      );
    }
  }

  incomingTX(tx: Transaction): boolean {
    try {
      // Timestamp validation
      const now = Date.now();
      const txAge = now - tx.timestamp;
      if (txAge > 60000 || txAge < -5000) {
        // 1 min past, 5 sec future tolerance
        return false;
      }

      // Check for duplicate pending transactions from same sender
      const hasPendingTx = this.bc.mempool.some(
        (pendingTx: Transaction) =>
          tx.sender === pendingTx.sender && pendingTx.signature === tx.signature
      );

      if (hasPendingTx) {
        return false;
      }

      const success = this.bc.pushTX(tx);
      if (success) {
        process.stdout.write(
          `\r\x1b[32m[TX]\x1b[0m Transaction accepted from ${tx.sender.substring(
            0,
            8
          )}...`
        );
        onTX(tx);
      }

      return success;
    } catch (error: any) {
      console.error(
        `\x1b[31m[TX]\x1b[0m Error processing incoming transaction: ${error.message}`
      );
      return false;
    }
  }

  async incomingBlock(block: Block): Promise<boolean> {
    try {
      // Prevent duplicate processing
      if (
        this.bc.lastBlock === block.hash ||
        this.lastSeenBlock === block.hash
      ) {
        return false;
      }

      this.lastSeenBlock = block.hash;

      const success = await this.bc.addBlock(block);
      if (success) {
        await this.persistBlock(block, this.bc.height - 1);

        // Trigger webhooks
        onBlock(block);
        for (const tx of block.transactions) {
          if (tx.mint && tx.token) {
            onMint(tx.mint, tx.token);
          }
        }
      } else {
        console.warn(
          `\x1b[33m[BLOCK]\x1b[0m Block rejected: ${block.hash.substring(
            0,
            16
          )}...`
        );
      }

      return success;
    } catch (error: any) {
      console.error(
        `\x1b[31m[BLOCK]\x1b[0m Error processing incoming block: ${error.message}`
      );
      return false;
    }
  }

  // Graceful shutdown
  async shutdown(): Promise<void> {
    if (this.isShuttingDown) {
      return;
    }

    this.isShuttingDown = true;
    console.log(`\x1b[36m[P2P]\x1b[0m Initiating network shutdown...`);

    // Clean up keyboard listener
    if (this.rl) {
      this.rl.close();
    }
    if (process.stdin.setRawMode) {
      process.stdin.setRawMode(false);
    }

    // Clear all timeouts
    this.peerReconnectTimeouts.forEach((timeout) => clearTimeout(timeout));
    this.peerReconnectTimeouts.clear();

    // Close all peer connections
    this.wscs.forEach((ws, peerUrl) => {
      console.log(`\x1b[36m[P2P]\x1b[0m Closing connection to ${peerUrl}`);
      ws.close(1000, "Shutdown");
    });
    this.wscs.clear();

    // Close WebSocket server
    return new Promise((resolve) => {
      this.wss.close(() => {
        console.log(
          `\x1b[32m[P2P]\x1b[0m Network shutdown completed successfully`
        );
        resolve();
      });
    });
  }

  // Network status
  getNetworkStatus() {
    const connectedPeers = Array.from(this.wscs.keys()).filter(
      (peerUrl) => this.wscs.get(peerUrl)?.readyState === WebSocket.OPEN
    );

    return {
      connectedPeers,
      incomingConnections: this.wss.clients.size,
      syncActive: this.syncState.isActive,
      blockchainHeight: this.bc.height,
      mempoolSize: this.bc.mempool.length,
      totalConnections: connectedPeers.length + this.wss.clients.size,
      silencedPeers: Array.from(this.silencedPeers),
    };
  }

  // Network diagnostics
  printNetworkStatus(): void {
    const status = this.getNetworkStatus();
    const timestamp = new Date()
      .toISOString()
      .replace("T", " ")
      .substring(0, 19);

    console.log(`\n\x1b[36m[P2P NETWORK STATUS]\x1b[0m ${timestamp}`);
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(
      `  \x1b[32mConnected Peers:\x1b[0m ${status.connectedPeers.length}`
    );

    if (status.connectedPeers.length > 0) {
      status.connectedPeers.forEach((peer, index) => {
        console.log(`    ${index + 1}. ${peer}`);
      });
    }

    console.log(
      `  \x1b[32mIncoming Connections:\x1b[0m ${status.incomingConnections}`
    );
    console.log(
      `  \x1b[32mTotal Connections:\x1b[0m ${status.totalConnections}`
    );
    console.log(
      `  \x1b[32mBlockchain Height:\x1b[0m ${status.blockchainHeight}`
    );
    console.log(`  \x1b[32mMempool Size:\x1b[0m ${status.mempoolSize}`);
    console.log(
      `  \x1b[32mSync Active:\x1b[0m ${
        status.syncActive ? "\x1b[33mYes\x1b[0m" : "\x1b[32mNo\x1b[0m"
      }`
    );

    if (status.silencedPeers.length > 0) {
      console.log(
        `  \x1b[33mSilenced Peers:\x1b[0m ${status.silencedPeers.length}`
      );
      status.silencedPeers.forEach((peer, index) => {
        console.log(`    ${index + 1}. ${peer}`);
      });
    }

    if (this.syncState.isActive) {
      const progress =
        this.syncState.targetHeight > 0
          ? Math.round(
              ((this.bc.height - this.syncState.startHeight) /
                (this.syncState.targetHeight - this.syncState.startHeight)) *
                100
            )
          : 0;
      console.log(
        `  \x1b[33mSync Progress:\x1b[0m ${progress}% (${this.bc.height}/${this.syncState.targetHeight})`
      );
    }

    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
  }
}

export default P2PNetwork;
