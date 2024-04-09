import { createEnv } from '@t3-oss/env-core';
import memoizee from 'memoizee';
import process from 'process';
import { z } from 'zod';

export const env = memoizee(() =>
  createEnv({
    server: {
      STACKS_API_URL: z.string().default('https://api.mainnet.hiro.so'),
      MAX_TRACKING_SIZE: z.coerce.number().default(100),
      DOUBLE_CHECK_RECENT_SIZE: z.coerce.number().default(10),
      REORG_OUTPUT_LOCATION: z.string().default('./reorg_data'),
      LOOP_INTERVAL: z.coerce.number().default(10000),
      ALERT_URL: z.string().optional(),
    },
    runtimeEnv: process.env,
  })
);
