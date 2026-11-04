import { describe, expect, test } from 'bun:test';
import { collectClanTabState, CLAN_TAB_CLIENTCODE } from './clan-tab-state.js';

const state = { seq: 3, clan: { id: 1, name: 'Stud Unit' }, memberCount: 2, onlineCount: 1, members: [{ name: 'Cant Pvm', rank: 9, rankName: 'Owner', online: true }, { name: 'Bot Raven', rank: 1, rankName: 'Recruit', online: false }] };

describe('clan tab state reader', () => {
    test('finds the hidden JSON under the slot-7 interface', () => {
        const list = [{ clientCode: 0, text: null, children: [1] }, { clientCode: 0, text: null, children: [2] }, { clientCode: CLAN_TAB_CLIENTCODE, text: JSON.stringify(state), children: null }];
        expect(collectClanTabState(list, 0)).toEqual(state);
    });
    test('no tab, bad JSON or a wrong shape read as null', () => {
        expect(collectClanTabState([], -1)).toBeNull();
        expect(collectClanTabState([{ clientCode: CLAN_TAB_CLIENTCODE, text: '{', children: null }], 0)).toBeNull();
        expect(collectClanTabState([{ clientCode: CLAN_TAB_CLIENTCODE, text: '{"seq":1}', children: null }], 0)).toBeNull();
    });
});
