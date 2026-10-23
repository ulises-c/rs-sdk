import { expect, test } from 'bun:test';
import { BotSDK } from '../index';
import type { InterfaceSnapshotState } from '../types';

test('inspects only on demand and accepts supported closed interfaces', async () => {
    const sdk = new BotSDK({ botUsername: 'offline_fixture', autoLaunchBrowser: false });
    const closed: InterfaceSnapshotState = { version: 1, rootId: -1, components: [], truncated: false };
    const calls: unknown[] = [];
    (sdk as any).sendAction = async (action: unknown) => { calls.push(action); return { success: true, data: closed }; };
    expect(calls).toHaveLength(0);
    expect(await (sdk as any).inspectInterface()).toEqual(closed);
    expect(calls).toEqual([{ type: 'inspectInterface', reason: 'SDK' }]);
});

test('fails explicitly for old clients and malformed inspection responses', async () => {
    const sdk = new BotSDK({ botUsername: 'offline_fixture', autoLaunchBrowser: false });
    (sdk as any).sendAction = async () => ({ success: false, message: 'Unknown action type: inspectInterface' });
    await expect((sdk as any).inspectInterface()).rejects.toThrow('Unknown action type');
    (sdk as any).sendAction = async () => ({ success: true, data: { version: 99 } });
    await expect((sdk as any).inspectInterface()).rejects.toThrow('Unsupported interface inspection');
});
