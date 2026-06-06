import { Nimbus, type NimbusConfig } from '@nimbus-sh/sdk';
import {
  claimDemoSessionForDestroy,
  listExpiredDemoSessions,
  markDemoSessionDestroyed,
  markDemoSessionDestroyFailed,
} from './demo-sessions.js';

export interface DemoCleanupResult {
  scanned: number;
  claimed: number;
  destroyed: number;
  failed: number;
}

export async function cleanupExpiredDemoSessions(
  env: any,
  config: NimbusConfig,
): Promise<DemoCleanupResult> {
  const rows = await listExpiredDemoSessions(env);
  const result: DemoCleanupResult = {
    scanned: rows.length,
    claimed: 0,
    destroyed: 0,
    failed: 0,
  };
  if (rows.length === 0) return result;

  const nimbus = Nimbus.fromEnv(env, config);
  for (const row of rows) {
    const claimed = await claimDemoSessionForDestroy(
      env,
      row.sessionId,
      row.userId,
      'demo-idle-ttl',
    );
    if (!claimed) continue;
    result.claimed++;
    try {
      await nimbus.sandbox(row.sessionId, {
        tenant: 'demo',
        subject: row.userId,
      }).destroy({ reason: 'demo-idle-ttl' });
      await markDemoSessionDestroyed(env, row.sessionId, 'demo-idle-ttl');
      result.destroyed++;
    } catch (e: any) {
      await markDemoSessionDestroyFailed(env, row.sessionId, e?.message || String(e));
      result.failed++;
    }
  }
  return result;
}
