import { describe, expect, test } from 'bun:test';
import { clanChatCommand, clanChatFromMessages, parseClanChatLine } from '../clan-chat';

describe('clan chat helpers', () => {
    test('parses "[Clan] Sender: text"', () => {
        expect(parseClanChatLine('[Stud Unit] Cant Pvm: meet at varrock: now')).toEqual({ clan: 'Stud Unit', sender: 'Cant Pvm', text: 'meet at varrock: now' });
        expect(parseClanChatLine('[Clan] Bot Raven joined Stud Unit.')).toBeNull();
        expect(parseClanChatLine('Welcome to RuneScape.')).toBeNull();
    });
    test('picks clan lines out of game messages, oldest first', () => {
        const msgs = [
            { type: 0, text: '[Stud Unit] Bot Tester: second', sender: '', tick: 9, fromSelf: false },
            { type: 2, text: '[Stud Unit] Fake: public chat', sender: 'Fake', tick: 8, fromSelf: false },
            { type: 0, text: '[Stud Unit] Bot Raven: first', sender: '', tick: 3, fromSelf: false }
        ];
        expect(clanChatFromMessages(msgs).map(m => `${m.sender}:${m.text}`)).toEqual(['Bot Raven:first', 'Bot Tester:second']);
    });
    test('send text gets exactly one leading slash', () => {
        expect(clanChatCommand('hello')).toBe('/hello');
        expect(clanChatCommand('/hello')).toBe('/hello');
        expect(clanChatCommand('  hi')).toBe('/hi');
    });
});
