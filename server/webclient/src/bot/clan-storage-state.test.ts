import { describe, expect, test } from 'bun:test';
import { collectClanStorageState, CLAN_STORAGE_CLIENTCODE } from './clan-storage-state.js';

const base = {
    isOpen: true,
    session: 1,
    revision: 2,
    actionRevision: 0,
    storeRevision: 5,
    serverTime: 1,
    clan: { id: 1, name: 'Stud Unit' },
    rank: 9,
    rankName: 'Owner',
    effectiveRank: 9,
    canDeposit: true,
    capacity: { used: 1, max: 800 },
    noteMode: false,
    items: [{ slot: 0, id: 995, name: 'Coins', count: 10, minRank: 5, canWithdraw: true, cooldownUntil: null, reason: null }],
    cooldowns: { newMember: null, promotion: null },
    controls: { close: 1, bank: 2, mode: 3, depositInventory: 4 },
    components: { inv: 5, sideInv: 6 },
    input: null,
    notice: '',
    error: null,
    errorReason: null,
    receipt: null
};
const tree = (text: string) => [
    { clientCode: 0, text: null, children: [1] },
    { clientCode: CLAN_STORAGE_CLIENTCODE, text, children: null }
];

describe('clan storage state reader', () => {
    test('reads the hidden JSON component under the open modal', () => {
        expect(collectClanStorageState(tree(JSON.stringify(base)), 0)?.items[0].name).toBe('Coins');
    });
    test('no modal, malformed JSON or missing fields read as null', () => {
        expect(collectClanStorageState(tree(JSON.stringify(base)), -1)).toBeNull();
        expect(collectClanStorageState(tree('{not json'), 0)).toBeNull();
        expect(collectClanStorageState(tree(JSON.stringify({ ...base, items: null })), 0)).toBeNull();
        expect(collectClanStorageState(tree(JSON.stringify({ ...base, revision: 1.5 })), 0)).toBeNull();
        expect(collectClanStorageState(tree(JSON.stringify({ ...base, isOpen: false })), 0)).toBeNull();
        expect(collectClanStorageState([{ clientCode: 0, text: null, children: [0] }], 0)).toBeNull(); // cycles stop
    });
});
