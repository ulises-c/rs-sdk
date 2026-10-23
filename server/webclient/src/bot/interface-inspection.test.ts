import '../lite/dom-shim.js';
import { expect, test } from 'bun:test';
import IfType from '#/config/IfType.js';
import { BotStateCollector } from './StateCollector.js';
import { ActionExecutor } from './ActionExecutor.js';

// Offline UI fixtures: no login, browser, mesh renderer or game packets.
test('ordinary state collection does not traverse or publish the interface snapshot', () => {
    let tableReads = 0;
    const client = { mainModalId: 1, getInterfaceOptions: () => [], interfaces: { get list() { tableReads++; return []; } } };
    const collector = new BotStateCollector(client as any);
    const state = (collector as any).collectInterfaceState();
    expect(tableReads).toBe(0);
    expect(state).toEqual({ isOpen: true, interfaceId: 1, options: [] });
});

test('on-demand action inspects the requesting bot table, not the active global', async () => {
    const root = new IfType();
    Object.assign(root, { id: 1, type: 0, width: 200, height: 100, children: [2], childX: [0], childY: [0] });
    const label = new IfType();
    Object.assign(label, { id: 2, type: 4, width: 100, height: 20, text: 'Visible fixture' });
    const table = [undefined, root, label];
    const client = { mainModalId: 1, interfaces: { list: table } };
    const collector = new BotStateCollector(client as any);
    const executor = new ActionExecutor(client as any);
    executor.setScanProvider(collector);
    const result = await executor.execute({ type: 'inspectInterface', reason: 'test' } as any);
    expect(result).toMatchObject({ success: true, phase: 'observation', data: { version: 1, rootId: 1, truncated: false } });
    expect(result.data.components.find((c: any) => c.id === 2).text).toBe('Visible fixture');
    expect(client.mainModalId).toBe(1);
    expect(label.text).toBe('Visible fixture');
});

test('inspection without a provider fails without dispatching anything', async () => {
    const executor = new ActionExecutor({} as any);
    expect(await executor.execute({ type: 'inspectInterface', reason: 'test' } as any)).toMatchObject({ success: false, reason: 'inspection_unavailable' });
});
