# Clans and clan storage

Server-side clans with one shared store per clan, reachable from every bank, plus clan hiscore
boards. Off unless enabled per world:

| Env | Default | Effect |
|---|---|---|
| `CLAN_STORAGE_ENABLED` | `false` | `/clan` commands, the bank screen's **Clan storage** button, the storage screen |
| `CLAN_CHAT_ENABLED` | `false` | clan chat (`/` lines) and the clan side tab; needs `CLAN_STORAGE_ENABLED` |
| `CLAN_HISCORES_ENABLED` | `false` | `/hiscores/clans`, `/hiscores/clan/NAME`, JSON under `/api/hiscores/...`, player-page clan line |
| `CLAN_STORAGE_SIZE` | `800` | item kinds per clan store |
| `CLAN_MAX_MEMBERS` | `500` | members per clan |
| `CLAN_HISCORE_MIN_MEMBERS` | `3` | visible members a clan needs to be ranked |
| `CLAN_HISCORES_CACHE_MS` | `60000` | clan board cache |

With both off the server behaves like upstream (the bank button is a hidden layer nobody sees).
State lives in the GE ledger (`GE_DATABASE`, default `data/market.sqlite`).

## Commands (public chat)

The 2004 chat packer has no `/`: the client sends `/clan` as ` clan`, lower-cased, with `_` turned into
spaces. Names are matched space/underscore-insensitively, so `bot geometry` = `bot_geometry`.

| Command | Who |
|---|---|
| `/clan create NAME` (1–12 letters, digits, spaces) | anyone not in a clan (and not inside the 24 h rejoin cooldown) |
| `/clan invite PLAYER` | rank ≥ `minInvite` (default Admin) |
| `/clan accept [NAME]` | invitee, within 10 min |
| `/clan leave` | anyone but the Owner |
| `/clan kick PLAYER` | Admin+ over lower ranks |
| `/clan rank PLAYER RANK [COOLDOWN]` | Admin+ (ranks below their own); `owner` transfers ownership |
| `/clan trust PLAYER` | Owner/Deputy: waives the new-member and promotion cooldowns |
| `/clan access ITEM RANK\|default [5m]` | Admin+: per-item minimum rank and withdraw cooldown |
| `/clan set SETTING VALUE` | Admin+; `hiscores`, `showMembers`, `showBankValues`, `showStorage` need Deputy+; `notices on` = login/logout lines in clan chat |
| `/clan info`, `/clan members`, `/clan disband` (Owner, empty store) | |

Ranks (stored as numbers, never renumbered): Recruit 1, Corporal 2, Sergeant 3, Lieutenant 4,
Captain 5, General 6, Admin 7, Deputy owner 8, Owner 9.

## Clan chat and the clan tab (`CLAN_CHAT_ENABLED`)

- **Chat:** a public chat line starting with `/` (that is not `/clan ...`) goes to your clan, OSRS
  style: every member online on this world gets the game message `[Stud Unit] Clan Founder: text` (this
  chatbox draws game messages in plain black; it has no colour tags for them and no clan channel).
  Same word filter as public chat; muted players are silent (the mute check runs before the clan hook,
  so `/clan` commands are refused while muted too); members who ignore the speaker don't get the line
  (ignore lists are read from `db.sqlite`, as the friend server keeps them). Not in a clan: "You are not
  in a clan." and nothing is said. Members on other worlds are not reached (single-world ledger).
  A line whose first word is `clan` is read as a command (`/clan war tonight` answers with help).
- **Never public:** the server swallows `/clan ...` and `/` lines (no overhead text, no public chat,
  no out-of-range broadcast). The *sender's own* client still echoes what was typed (overhead text and a
  `Name: /clan ...` line in its own chatbox): that echo is drawn by the client before sending, so only
  a client change could hide it.
- **Clan tab:** sidebar slot 7 (bottom-left, empty in this revision) shows the clan name, member and
  online counts and the roster: online members first (rank in green), then offline members (rank in
  red), up to 60 rows (`...and N more`). Built from the friends-list frame. It updates on member
  login/logout, joins, leaves, kicks, rank changes and disband (event-driven, no per-tick ledger reads).
  This client draws **no icon** for slot 7 (it loads 13 side icons and plots none there), so the tab is
  clickable but blank until selected; an icon needs a client change (load a 14th `sideicons` sprite and
  plot it when `sideIcon[7] != -1`) or an edit of the `backbase2` sidebar background, which every
  player would see, members or not.

## Access rules

- Deposit: rank ≥ `minDeposit` (Recruit). Withdraw: rank ≥ the item's rule, else `minWithdraw` (Sergeant).
  Coins default to **Captain, 5 min** per member.
- New members wait `newMemberHours` (24) before withdrawing; a raised rank applies after
  `promotionHours` (12), a lowered rank at once. `/clan trust` waives both.
- Leaving or being kicked: 24 h before joining or founding any clan.
- Kicks and rank changes: 20 per actor per hour.
- Notes deposit as their real item; withdraw as Item or Note (the bank's two select boxes). Untradeable, quest and dummy items are refused.
- Every deposit, withdrawal, refusal and management action is in `clan_log` with world, coordinate and
  store revision; deposits/withdrawals commit the player save checkpoint in the same transaction.

## Bots (SDK)

```ts
await bot.openClanStorage();                 // opens the nearest bank if needed, then the clan button
await bot.clanDeposit('Logs', 10);
await bot.clanDepositInventory();
await bot.clanWithdraw('Coins', 1000);       // reason 'rank' | 'cooldown' refusals come back locally
await bot.clanWithdraw('Logs', 50, { noted: true });
await bot.closeClanStorage();
sdk.getClanStorageState();                   // full private state (items, canWithdraw, cooldowns, receipt)

await sdk.sendClanChat('ore run done');      // public chat with a leading "/"
sdk.getClanChat();                           // [{ clan, sender, text, tick }] parsed from game messages
sdk.getClanState();                          // the clan tab: clan, memberCount, onlineCount, members[]
```

Each action waits for the server's acknowledged revision and verifies the backpack delta; a timeout
returns `outcome: 'unknown'` and is never retried automatically.

## Hiscores

Boards from current values: Overall, each skill, Quest Points, Bank value, Clan storage value, Wealth
(member bank values + storage), Average level. Hidden names and staff are not listed, summed or counted.
Skill sums use player rows at level 15+ (as the player boards); Overall uses true totals. Privacy:
`hiscores off` removes the clan from every board and page; `showMembers off` hides the member list;
`showBankValues off` hides per-member and total bank value.
