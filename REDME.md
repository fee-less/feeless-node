# 🌐 Feeless Node

### Welcome to **Feeless**  
This is the beginning of an **unforgettable** journey into the world of feeless transactions.

---

## Node Installation

The recommended way to install a **Feeless Node** is via **NPM**.  
Run the following command globally:

```bash
npm install -g feeless-node
```
(...you may need to run this command with sudo...)

This gives you access to two CLI tools:

- `feeless-node` — the main node runner  
- `feeless-miner` — the mining utility

---

##  Running the Node

1. Choose a working directory for your node (e.g. `~/feeless`)
2. Navigate to that directory in your terminal
3. Run the node using:

```bash
npx feeless-node
```

---

## Running the Miner

1. Create or navigate to a directory for your miner (e.g. `~/feeless-mining`)
2. Run the miner with:

```bash
npx feeless-miner
```

This will generate a `miner.json` file in the current directory.

You can configure your miner by editing `miner.json`. The key fields include:

```json
{
  "wsUrl": "ws://localhost:6061",
  "httpUrl": "http://localhost:8000",
  "private": "PRIVATE_WALLET_KEY",
  "token": ""
}
```