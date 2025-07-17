import { WebSocketServer, WebSocket } from 'ws';
import { Block, getDiff, Transaction, EventPayload } from 'feeless-utils';
import Blockchain from './blockchain.js';
import fs from "fs";

class P2PNetwork {
  public bc: Blockchain;
  private wss: WebSocketServer;
  private wsc: WebSocket | null;

  constructor(peer: string, port: number, bc: Blockchain) {
    this.bc = bc;
    this.wss = new WebSocketServer({ port });
    this.wsc = peer ? new WebSocket(peer) : null;
    this.wss.addListener("connection", ws => {
      ws.on("message", data => {
        try {
          const payload: EventPayload = JSON.parse(data.toString());
          this.onPeerPayload(payload);
        } catch (e: any) {
          console.log("[INTERNAL SERVER ERROR]", e);
        }
      })
    });
    this.wsc?.addListener("message", data => {
      try {
        const payload: EventPayload = JSON.parse(data.toString());
        this.onPeerPayload(payload);
      } catch (e: any) {
        console.log("[INTERNAL SERVER ERROR]", e);
      }
    });
    this.wsc?.addListener("open", () => {
      console.log("Connected to peer: " + peer);
    });
    this.wsc?.addListener("close", () => {
      console.log("Disconnected from peer: " + peer);
    });
  }

  async onPeerPayload(payload: EventPayload) {
    if (payload.event === "tx") {
      if (this.incomingTX(payload.data as Transaction)) this.toPeers(payload);
    } else if (payload.event === "block") {
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
    return this.bc.pushTX(tx);
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
    }
    return res
  }
}

export default P2PNetwork;