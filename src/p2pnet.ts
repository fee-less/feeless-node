import { WebSocketServer, WebSocket } from "ws";
import { Block, getDiff, Transaction, EventPayload } from "feeless-utils";
import Blockchain from "./blockchain.js";
import fs from "fs";
import { onBlock, onMint, onTX } from "./webhooks.js";

class P2PNetwork {
  public bc: Blockchain;
  private wss: WebSocketServer;
  private wscs: Map<string, WebSocket>;
  private peerReconnectTimeouts: Map<string, NodeJS.Timeout> = new Map();
  public onBlockReceived?: (block: Block) => void;
  private peerUrls: string[];
  private isReSyncing = false;

  constructor(peer: string, port: number, bc: Blockchain) {
    this.bc = bc;
    this.peerUrls = peer.split(",");
    this.wss = new WebSocketServer({ port });
    this.wscs = new Map();
    if (peer) {
      this.peerUrls.forEach((peerUrl) => this.createPeerSocket(peerUrl));
    }
    this.wss.addListener("connection", (ws) => {
      ws.on("message", (data) => {
        try {
          const payload: EventPayload = JSON.parse(data.toString());
          this.onPeerPayload(payload);
        } catch (e: any) {
          console.log("[INVALID PAYLOAD]", e);
        }
      });
    });
    setInterval(() => this.watchDog(), 30000); // Watch dog every 30s
  }

  private createPeerSocket(peerUrl: string): WebSocket {
    const ws = new WebSocket(peerUrl);
    this.wscs.set(peerUrl, ws);
    ws.addEventListener("message", (data) => {
      try {
        const payload: EventPayload = JSON.parse(data.data.toString());
        this.onPeerPayload(payload);
      } catch (e: any) {
        console.log("[INTERNAL SERVER ERROR]", e);
      }
    });
    ws.addEventListener("open", () => {
      console.log("Connected to peer: " + peerUrl);
      this.startHeartbeat(ws, peerUrl); // start per-connection heartbeat
      const timeout = this.peerReconnectTimeouts.get(peerUrl);
      if (timeout) {
        clearTimeout(timeout);
        this.peerReconnectTimeouts.delete(peerUrl);
      }
    });
    ws.addEventListener("close", () => {
      console.log("Disconnected from peer: " + peerUrl);
      this.scheduleReconnect(peerUrl);
    });
    ws.addEventListener("error", () => {
      console.log("Peer connection error.");
      console.log("Disconnected from peer: " + peerUrl);
      ws.close(); // Ensure close event fires
    });
    return ws;
  }

  private startHeartbeat(ws: WebSocket, peerUrl: string) {
    let isAlive = true;

    ws.on("pong", () => {
      isAlive = true;
    });

    const interval = setInterval(() => {
      if (!isAlive) {
        console.log(`[HEARTBEAT] Peer ${peerUrl} not responding, closing...`);
        clearInterval(interval);
        ws.terminate(); // forces "close" -> triggers reconnect
        return;
      }

      isAlive = false;
      try {
        ws.ping();
      } catch (err) {
        console.log(`[HEARTBEAT] Failed to ping ${peerUrl}`, err);
        ws.terminate();
      }
    }, 10000); // every 10s

    ws.on("close", () => clearInterval(interval));
    ws.on("error", () => clearInterval(interval));
  }

  private async scheduleReconnect(peerUrl: string) {
    const existingTimeout = this.peerReconnectTimeouts.get(peerUrl);
    if (existingTimeout) {
      clearTimeout(existingTimeout);
    }
    const timeout = setTimeout(async () => {
      console.log(`Attempting to reconnect to peer: ${peerUrl}`);
      this.createPeerSocket(peerUrl);
      this.peerReconnectTimeouts.delete(peerUrl);
    }, 10000); // 10 seconds
    this.peerReconnectTimeouts.set(peerUrl, timeout);
  }

  private async watchDog() {
    if (!process.env.PEER_HTTP || this.isReSyncing) return;
    try {
      if (
        (await fetch(process.env.PEER_HTTP + "/height")
          .then((res) => res.json())
          .then((d) => d.height)) === this.bc.height
      )
        return;
      const forkPoint = await this.findForkPoint();
      console.warn(
        `[FORK] Fork detected. Replacing chain from height ${forkPoint}`
      );
      this.isReSyncing = true;
      await this.replacePartialChainFromPeer(forkPoint);
      this.isReSyncing = false;
    } catch (e: any) {
      console.error("[WATCHDOG] FAILED", e);
    }
  }

  private async replacePartialChainFromPeer(
    startHeight: number
  ): Promise<void> {
    try {
      const remoteHeight: number = await fetch(
        `${process.env.PEER_HTTP}/height`
      )
        .then((res) => res.json())
        .then((d) => d.height);

      console.log(
        `[SYNC] Starting from height ${startHeight}, remote height = ${remoteHeight}`
      );

      for (let i = startHeight; i < remoteHeight; i++) {
        const block = await fetch(`${process.env.PEER_HTTP}/block/${i}`)
          .then((res) => res.json())
          .catch(() => null);

        if (!block) {
          console.warn(`[SYNC] Failed to fetch block ${i}. Aborting.`);
          return;
        }

        this.bc.mempool.push(...block.transactions);
        const ok = await this.bc.addBlock(block, true);
        if (!ok) {
          console.log("[SYNC] INVALID BLOCK RE-SYNCED!");
          return;
        }

        this.bc.height = i + 1; // update only when block is valid
        fs.writeFileSync(`blockchain/${i}`, JSON.stringify(block));
      }

      // Ensure local mempool matches peer
      this.bc.mempool = await fetch(`${process.env.PEER_HTTP}/mempool`).then(
        (res) => res.json()
      );

      // Final consistency check
      if (this.bc.height !== remoteHeight) {
        console.warn(
          `[SYNC] Local height ${this.bc.height} != remote height ${remoteHeight}, retrying...`
        );
        return this.replacePartialChainFromPeer(this.bc.height); // recursive retry
      }

      console.log(
        `[SYNC] Successfully replaced local chain up to height ${remoteHeight}`
      );
    } catch (e) {
      console.error("[SYNC ERROR]", e);
    }
  }

  private async findForkPoint(): Promise<number> {
    const remoteHeight = await fetch(`${process.env.PEER_HTTP}/height`)
      .then((res) => res.json())
      .then((d) => d.height);

    const minHeight = Math.min(this.bc.height, remoteHeight);

    for (let i = minHeight - 1; i >= 0; i--) {
      const remoteBlock = await fetch(`${process.env.PEER_HTTP}/block/${i}`)
        .then((res) => res.json())
        .catch(() => null);
      if (!remoteBlock) break;

      const localBlock = this.bc.getBlock(i);
      if (remoteBlock.hash === localBlock.hash) {
        return i + 1; // First divergent block
      }
    }

    return 0; // No common ancestor found
  }

  async onPeerPayload(payload: EventPayload) {
    try {
      if (payload.event === "tx") {
        if (this.incomingTX(payload.data as Transaction)) this.toPeers(payload);
      } else if (payload.event === "block") {
        if (payload.data.hash === this.bc.lastBlock) return;
        if (this.onBlockReceived) this.onBlockReceived(payload.data as Block);
        if (await this.incomingBlock(payload.data as Block))
          this.toPeers(payload);
      }
    } catch (e) {
      console.error(e);
    }
  }

  toPeers(data: EventPayload) {
    // console.log("Sending data to peers: " + JSON.stringify(data, null, 2));
    this.wscs.forEach((wsc) => wsc.send(JSON.stringify(data)));
    this.wss.clients.forEach((c) => c.send(JSON.stringify(data)));
  }

  incomingTX(tx: Transaction) {
    if (tx.timestamp < Date.now() - 60000) return false;
    if (
      this.bc.mempool.filter(
        (pendingTx: Transaction) => tx.sender === pendingTx.sender
      ).length > 0
    )
      return false;
    const res = this.bc.pushTX(tx);
    if (res) {
      onTX(tx);
    }
    return res;
  }

  async incomingBlock(block: Block) {
    if (this.bc.lastBlock === block.hash) return false; // Already added
    const res = await this.bc.addBlock(block);
    if (res) {
      if (!fs.existsSync("blockchain")) {
        fs.mkdirSync("blockchain");
      }
      fs.writeFileSync(
        "blockchain/" + (this.bc.height - 1),
        JSON.stringify(block)
      );
      onBlock(block);
      for (const tx of block.transactions) {
        if (tx.mint && tx.token) {
          onMint(tx.mint, tx.token);
        }
      }
    }
    return res;
  }
}

export default P2PNetwork;
