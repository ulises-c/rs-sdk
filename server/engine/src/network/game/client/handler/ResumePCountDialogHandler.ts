import { exchangeCount } from '#/engine/market/GrandExchange.js';
import { clanCount } from '#/engine/clan/ClanHooks.js';
import Player from '#/engine/entity/Player.js';
import ScriptState from '#/engine/script/ScriptState.js';
import ClientGameMessageHandler from '#/network/game/client/ClientGameMessageHandler.js';
import ResumePCountDialog from '#/network/game/client/model/ResumePCountDialog.js';

export default class ResumePCountDialogHandler extends ClientGameMessageHandler<ResumePCountDialog> {
    handle(message: ResumePCountDialog, player: Player): boolean {
        const { input } = message;
        if (exchangeCount(player, input)) return true;
        if (clanCount(player, input)) return true;

        if (!player.activeScript || player.activeScript.execution !== ScriptState.COUNTDIALOG) {
            return false;
        }

        player.activeScript.lastInt = input;
        player.executeScript(player.activeScript, true, true);
        return true;
    }
}
