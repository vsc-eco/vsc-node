import networks from "@/services/networks";
import { NewCoreService } from "..";
import { HiveClient } from "../../../utils";


/**
 * Manages signaling new versions of VSC releases.
 * Prevents conflicts and only applies upgrade if 70% of active nodes agree on it.
 * If node is not up to date then it will local block processing.
 */
export class VersionManager {
    self: NewCoreService;
    constructor(self: NewCoreService) {
        this.self = self;
    }

    /**
     * Retrieve consensus agreed upon block version.
     * @returns 
     */
    async getEffectiveVersion() {
        const multisigAccount = networks[this.self.config.get('network.id')].multisigAccount

        const [accountInfo] = await HiveClient.database.getAccounts([multisigAccount])
        console.log(accountInfo)

        let json_metadata
        try {
            json_metadata = JSON.parse(accountInfo.json_metadata)
        } catch {
            json_metadata = {}
        }

        if(json_metadata.vsc_config) {
            return {
                block_version: json_metadata.vsc_config.block_version
            }
        } else {
            return {
                block_version: 0,
                err: "INVALID"
            }
        }
    }
}