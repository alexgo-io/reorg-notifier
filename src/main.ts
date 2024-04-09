import { got } from './got';
import { env } from './env';
import { flatten, range } from 'ramda';
import PQueue from 'p-queue';
import * as fs from 'node:fs';
import * as path from 'node:path';
import process from 'process';
import pRetry from 'p-retry';
import { alertToTelegram } from './alert';

const base_api = () => env().STACKS_API_URL;

/*
GET /extended/v2/blocks/:height_or_hash

RESPONSE:
{
  "canonical": true,
  "height": 145833,
  "hash": "0x07dca9427da19a4ed33ad1bddc97ac0b3477f833363b05fae824b38164cdaaf1",
  "index_block_hash": "0x1e8658f988611f3a02f554a2fdecb5296e8e68fff8c13f8f1fa5d6d304cb9988",
  "parent_block_hash": "0xd88f8ca5a4b046719e49b108fc1337486cf837abc40db375dc0820b75ec27dfd",
  "parent_index_block_hash": "0x4ce9a17477fc40fe89e072e7ab52c3b0589aeb4b60307ed703a4775e350b8ad4",
  "burn_block_time": 1712686363,
  "burn_block_time_iso": "2024-04-09T18:12:43.000Z",
  "burn_block_hash": "0x00000000000000000001a5367c55059afc29a9013e4931256c73e05918c8b085",
  "burn_block_height": 838489,
  "miner_txid": "0xd4bc4467650754b4c7ab18c5ea9abdcdea71cff6f0190c6b584d073fd1aac0cb",
  "tx_count": 446,
  "execution_cost_read_count": 14601,
  "execution_cost_read_length": 37586019,
  "execution_cost_runtime": 1730806671,
  "execution_cost_write_count": 1123,
  "execution_cost_write_length": 108753
}
 */
type BlockData = {
  canonical: boolean;
  height: number;
  hash: string;
  index_block_hash: string;
  parent_block_hash: string;
  parent_index_block_hash: string;
  burn_block_time: number;
  burn_block_time_iso: string;
  burn_block_hash: string;
  burn_block_height: number;
  miner_txid: string;
  tx_count: number;
  execution_cost_read_count: number;
  execution_cost_read_length: number;
  execution_cost_runtime: number;
  execution_cost_write_count: number;
  execution_cost_write_length: number;
};

type NodeInfoV2 = {
  peer_version: number;
  pox_consensus: string;
  burn_block_height: number;
  stable_pox_consensus: string;
  stable_burn_block_height: number;
  server_version: string;
  network_id: number;
  parent_network_id: number;
  stacks_tip_height: number;
  stacks_tip: string;
  stacks_tip_consensus_hash: string;
  genesis_chainstate_hash: string;
  unanchored_tip: null;
  unanchored_seq: null;
  exit_at_block_height: null;
  node_public_key: string;
  node_public_key_hash: string;
  affirmations: {
    heaviest: string;
    stacks_tip: string;
    sortition_tip: string;
    tentative_best: string;
  };
  last_pox_anchor: {
    anchor_block_hash: string;
    anchor_block_txid: string;
  };
  stackerdbs: any[];
};

export async function get_block(block_number: number) {
  return got
    .get(`${base_api()}/extended/v2/blocks/${block_number}`, {
      retry: {
        limit: 10,
        methods: ['GET'],
      },
      timeout: {
        request: 10000,
      },
    })
    .json<BlockData>();
}

export async function get_info_v2() {
  return got.get(`${base_api()}/v2/info`).json<NodeInfoV2>();
}

class Tracker {
  latestHeight = 0;
  latestTip = '';
  blocksByHash: Record<string, BlockData> = {};
  blocksByHeight: Record<number, string[]> = {};

  async fetch_and_save_block(block_number: number) {
    const block = await pRetry(() => get_block(block_number), {
      onFailedAttempt: (error) => {
        console.log(
          `Failed to fetch block ${block_number}: ${error}. Retrying ${error.attemptNumber} <-- ${error.retriesLeft}...`
        );
      },
    });
    this.blocksByHash[block.hash] = block;
    if (!this.blocksByHeight[block.height]) {
      this.blocksByHeight[block.height] = [];
    }
    if (!this.blocksByHeight[block.height].includes(block.hash)) {
      this.blocksByHeight[block.height].push(block.hash);
      const hashes = this.blocksByHeight[block.height];
      if (hashes.length > 1) {
        console.log(`------------reorg-height-${block_number}-----------------
      Reorg detected at height ${block_number}, ${hashes.length} blocks found
      hashes: ${hashes.join(', ')}
      block data: ${hashes
        .map((hash) => JSON.stringify(this.blocksByHash[hash]))
        .join('\n')}
      `);
      }
    }
    return block;
  }

  async startUp() {
    const info = await get_info_v2();
    this.latestHeight = info.stacks_tip_height;
    this.latestTip = info.stacks_tip;

    const queue = new PQueue();
    let counter = env().MAX_TRACKING_SIZE;
    range(
      this.latestHeight - env().MAX_TRACKING_SIZE,
      this.latestHeight
    ).forEach((i) => {
      queue.add(async () => {
        const block = await this.fetch_and_save_block(i);
        console.log(`Fetched block ${block.height} |-> ${counter--} left`);
      });
    });

    await queue.onIdle();

    console.log(
      `startUp finished, latestHeight: ${this.latestHeight}, latestTip: ${this.latestTip}`
    );
  }

  async check() {
    const info = await get_info_v2();
    const latestHeight = info.stacks_tip_height;
    const latestTip = info.stacks_tip;

    if (latestHeight === this.latestHeight) {
      if (latestTip !== this.latestTip) {
        console.log(`Reorg tip found: ${latestTip}`);
      }
    } else {
      console.log(`Next block shown: ${latestHeight}`);
    }

    this.latestHeight = latestHeight;
    this.latestTip = latestTip;

    const queue = new PQueue();
    range(0, env().DOUBLE_CHECK_RECENT_SIZE).forEach((i) => {
      queue.add(async () => {
        await this.fetch_and_save_block(latestHeight - i);
      });
    });

    await queue.onIdle();

    await this.review();
  }

  async review() {
    const blocksInHeight = flatten(Object.values(this.blocksByHeight));
    if (Object.keys(this.blocksByHash).length !== blocksInHeight.length) {
      fs.writeFileSync(
        path.resolve(env().REORG_OUTPUT_LOCATION, `reorg-${Date.now()}.json`),
        JSON.stringify(
          {
            latestHeight: this.latestHeight,
            latestTip: this.latestTip,
            blocksByHash: this.blocksByHash,
            blocksByHeight: this.blocksByHeight,
          },
          null,
          2
        )
      );

      await alertToTelegram('reorg', 'reorg', {
        latestHeight: this.latestHeight.toString(),
        latestTip: this.latestTip,
        message: `Reorg detected: ${
          blocksInHeight.length - Object.keys(this.blocksByHash).length
        } blocks reorged.
        current block: ${this.latestHeight}`,
      });

      await this.restart();
    }
  }

  async restart() {
    this.latestHeight = 0;
    this.latestTip = '';
    this.blocksByHash = {};
    this.blocksByHeight = {};
    await this.startUp();
  }

  async run() {
    // check if file is writable at: env().REORG_OUTPUT_LOCATION
    fs.access(env().REORG_OUTPUT_LOCATION, fs.constants.W_OK, (err) => {
      if (err) {
        console.log(`Cannot write to ${env().REORG_OUTPUT_LOCATION}`);
        process.exit(1);
      }
    });

    if (env().ALERT_URL === undefined) {
      console.log('ALERT_URL is not set, will not send alerts.');
    }

    await this.startUp();
    // eslint-disable-next-line no-constant-condition
    while (true) {
      await this.check();
      console.log(
        `Sleeping... current blockHeight: ${this.latestHeight} :tip ${
          this.latestTip
        } <- ${new Date().toISOString()}`
      );
      await new Promise((resolve) => setTimeout(resolve, env().LOOP_INTERVAL));
    }
  }
}

async function main() {
  const tracker = new Tracker();
  await tracker.run();
}

main().catch((err) => {
  console.log(`Exit Error: ${err}`);
  process.exit(1);
});
