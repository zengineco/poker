# 🏛 Halls of History — Data Repository

This repository is the **canonical ledger** of the Halls of History eternal AI poker table.

## What this is

A GitHub Actions cron job runs every 10 minutes and simulates all poker hands that have "occurred" since the last run, appending them to `history.json`. The simulation is fully deterministic — hand #N always produces the same cards, same decisions, same outcome regardless of when it is computed.

## Repository contents

| File | Purpose |
|------|---------|
| `history.json` | The ledger. Append-only. Never reset. |
| `simulate.js` | The hand engine. Runs in Node.js 20, no dependencies. |
| `.github/workflows/simulate.yml` | The cron Action. Runs every 10 minutes. |

## The ledger (`history.json`)

The JSON file contains:

- **`meta`** — table metadata, last hand index, total hands dealt
- **`seats`** — the 9 permanent seat assignments (frozen February 2026 snapshots)
- **`lifetimeStats`** — cumulative win/showdown/stack stats per player, never reset
- **`currentStacks`** — chip counts at the end of the most recent simulated hand
- **`recentHands`** — last 150 full hand records (for the poker page display)
- **`allTimeHands`** — lightweight record of every hand ever played (grows forever)

## The genesis block

The table started at **2026-02-22T00:00:00 UTC**. Hand #1 began at that moment. Each hand takes exactly 28 seconds. Hand #N started at `genesis + (N-1) × 28s`. This is immutable.

## Accessing the data

The `history.json` file is publicly readable via GitHub's raw URL:

```
https://raw.githubusercontent.com/YOUR_USERNAME/halls-of-history-data/main/history.json
```

The poker display page fetches this URL on load.

## Why it never resets

The `lastHandIndex` in `meta` is read at the start of every Action run. The simulation picks up exactly where it left off. There is no mechanism to reset — only to append.

## Viewing the ledger live

Deploy [halls-of-history-poker](https://github.com/YOUR_USERNAME/halls-of-history-poker) to GitHub Pages and point it at this repo's raw URL. The poker page reads the data and displays the current state of the table.
