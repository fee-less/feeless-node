import { WebSocketServer, WebSocket } from 'ws';
import { Block, getDiff, Transaction, EventPayload } from 'feeless-utils';
import Blockchain from './blockchain.js';
import fs from "fs";
import { onBlock, onMint, onTX } from './webhooks.js';

class P2PNetwork {
  public bc: Blockchain;
  private wss: WebSocketServer;
  private wscs: Map<string, WebSocket>;
  private peerReconnectTimeouts: Map<string, NodeJS.Timeout> = new Map();
  public onBlockReceived?: (block: Block) => void;
  private peerUrls: string[];

  constructor(peer: string, port: number, bc: Blockchain) {
    this.bc = bc;
    this.peerUrls = peer.split(",");
    this.wss = new WebSocketServer({ port });
    this.wscs = new Map();
    if (peer) {
      this.peerUrls.forEach(peerUrl => this.createPeerSocket(peerUrl));
    }
    this.wss.addListener("connection", ws => {
      ws.on("message", data => {
        try {
          const payload: EventPayload = JSON.parse(data.toString());
          this.onPeerPayload(payload);
        } catch (e: any) {
          console.log("[INVALID PAYLOAD]", e);
        }
      })
    });
  }

  private createPeerSocket(peerUrl: string): WebSocket {
    const ws = new WebSocket(peerUrl);
    this.wscs.set(peerUrl, ws);
    ws.addEventListener("message", data => {
      try {
        const payload: EventPayload = JSON.parse(data.data.toString());
        this.onPeerPayload(payload);
      } catch (e: any) {
        console.log("[INTERNAL SERVER ERROR]", e);
      }
    });
    ws.addEventListener("open", () => {
      console.log("Connected to peer: " + peerUrl);
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
      ws.close(); // Ensure close event fires
    });
    return ws;
  }

  private async scheduleReconnect(peerUrl: string) {
    const existingTimeout = this.peerReconnectTimeouts.get(peerUrl);
    if (existingTimeout) {
      clearTimeout(existingTimeout);
    }
    const timeout = setTimeout(async () => {
      // Check for new blocks before reconnecting
      try {
        if (process.env.PEER_HTTP) {
          const remoteHeight = await fetch(process.env.PEER_HTTP + "/height").then(res => res.json()).then(j => j.height);
          const localHeight = this.bc.blocks.length;
          if (localHeight < remoteHeight) {
            for (let i = localHeight; i < remoteHeight; i++) {
              const block = await fetch(process.env.PEER_HTTP + "/block/" + i).then(res => res.json());
              this.bc.mempool.push(...block.transactions);
              if(!await this.bc.addBlock(block, true)) {
                console.log(`Synced block ${i + 1}/${remoteHeight} is invalid!`);
              } else {
                if (!fs.existsSync("blockchain")) {
                  fs.mkdirSync("blockchain");
                }
                fs.writeFileSync("blockchain/" + (this.bc.blocks.length - 1), JSON.stringify(this.bc.blocks[this.bc.blocks.length - 1]));
              }
              this.toPeers({ event: "block", data: block })
              if (!fs.existsSync("blockchain")) fs.mkdirSync("blockchain");
              fs.writeFileSync("blockchain/" + i, JSON.stringify(block));
              console.log(`Synced block ${i + 1}/${remoteHeight}`);
            }
          }
        }
      } catch (e) {
        console.log("Error syncing blocks before reconnect:");
      }
      console.log(`Attempting to reconnect to peer: ${peerUrl}`);
      this.createPeerSocket(peerUrl);
      this.peerReconnectTimeouts.delete(peerUrl);
    }, 10000); // 10 seconds
    this.peerReconnectTimeouts.set(peerUrl, timeout);
  }

  async onPeerPayload(payload: EventPayload) {
    try {
      if (payload.event === "tx") {
        if (this.incomingTX(payload.data as Transaction)) this.toPeers(payload);
      } else if (payload.event === "block") {
        if (payload.data.hash === this.bc.blocks[this.bc.blocks.length - 1].hash) return;
        if (this.onBlockReceived) this.onBlockReceived(payload.data as Block);
        if (await this.incomingBlock(payload.data as Block)) this.toPeers(payload);
      }
    } catch (e) {
      console.error(e);
      console.log(payload);
    }
  }

  toPeers(data: EventPayload) {
    // console.log("Sending data to peers: " + JSON.stringify(data, null, 2));
    this.wscs.forEach(wsc => wsc.send(JSON.stringify(data)));
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