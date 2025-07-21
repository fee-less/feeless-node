import { WebSocketServer, WebSocket } from 'ws';
import { Block, getDiff, Transaction, EventPayload } from 'feeless-utils';
import Blockchain from './blockchain.js';
import fs from "fs";
import { onBlock, onMint, onTX } from './webhooks.js';

class P2PNetwork {
  public bc: Blockchain;
  private wss: WebSocketServer;
  private wsc: WebSocket | null;
  public onBlockReceived?: (block: Block) => void;
  private peerUrl: string;
  private reconnectTimeout: NodeJS.Timeout | null = null;
  private maxReconnectAttempts = 10;
  private reconnectAttempts = 0;

  constructor(peer: string, port: number, bc: Blockchain) {
    this.bc = bc;
    this.peerUrl = peer;
    this.wss = new WebSocketServer({ port });
    this.wsc = peer ? this.createPeerSocket() : null;
    this.wss.addListener("connection", ws => {
      ws.on("message", data => {
        try {
          const payload: EventPayload = JSON.parse(data.toString());
          console.log("Payload:", data.toString());
          this.onPeerPayload(payload);
        } catch (e: any) {
          console.log("[INVALID PAYLOAD]", e);
        }
      })
    });
  }

  private createPeerSocket(): WebSocket {
    const ws = new WebSocket(this.peerUrl);
    ws.addEventListener("message", data => {
      try {
        const payload: EventPayload = JSON.parse(data.data.toString());
        this.onPeerPayload(payload);
      } catch (e: any) {
        console.log("[INTERNAL SERVER ERROR]", e);
      }
    });
    ws.addEventListener("open", () => {
      console.log("Connected to peer: " + this.peerUrl);
      if (this.reconnectTimeout) {
        clearTimeout(this.reconnectTimeout);
        this.reconnectTimeout = null;
      }
      this.reconnectAttempts = 0; // Reset on success
    });
    ws.addEventListener("close", () => {
      console.log("Disconnected from peer: " + this.peerUrl);
      this.scheduleReconnect();
    });
    ws.addEventListener("error", (err) => {
      console.log("Peer connection error:", err);
      this.scheduleReconnect();
      ws.close(); // Ensure close event fires
    });
    return ws;
  }

  private scheduleReconnect() {
    if (this.reconnectTimeout) return; // Already scheduled
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error(`Failed to reconnect to peer after ${this.maxReconnectAttempts} attempts. Giving up.`);
      return;
    }
    this.reconnectTimeout = setTimeout(() => {
      this.reconnectAttempts++;
      console.log(`Attempting to reconnect to peer: ${this.peerUrl} (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`);
      this.wsc = this.createPeerSocket();
    }, 5000);
  }

  async onPeerPayload(payload: EventPayload) {
    if (payload.event === "tx") {
      if (this.incomingTX(payload.data as Transaction)) this.toPeers(payload);
    } else if (payload.event === "block") {
      if (payload.data.hash === this.bc.blocks[this.bc.blocks.length - 1].hash) return;
      if (this.onBlockReceived) this.onBlockReceived(payload.data as Block);
      if (await this.incomingBlock(payload.data as Block)) this.toPeers(payload);
    }
  }

  toPeers(data: EventPayload) {
    // console.log("Sending data to peers: " + JSON.stringify(data, null, 2));
    this.wsc?.send(JSON.stringify(data));
    this.wss.clients.forEach(c => c.send(JSON.stringify(data)));
  }

  incomingTX(tx: Transaction) {
    if (tx.timestamp < Date.now() - 60000) return false;
    if (this.bc.mempool.filter((pendingTx: Transaction) => tx.sender === pendingTx.sender).length > 0) return false;
    const res = this.bc.pushTX(tx);
    if (res) {
      onTX(tx);
    }
    return res;
  }

  async incomingBlock(block: Block) {
    if (this.bc.blocks[this.bc.blocks.length - 1].hash === block.hash) return false; // Already added
    if (getDiff(this.bc.blocks) < BigInt("0x" + block.hash)) {
      console.log("Block has invalid diff!");
      return false;
    }
    const res = await this.bc.addBlock(block);
    if (res) {
      if (!fs.existsSync("blockchain")) {
        fs.mkdirSync("blockchain");
      }
      fs.writeFileSync("blockchain/" +(this.bc.blocks.length - 1), JSON.stringify(this.bc.blocks[this.bc.blocks.length - 1]));
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