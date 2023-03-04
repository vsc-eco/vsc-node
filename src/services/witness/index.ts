import { HiveClient } from "../../utils";
import { CoreService } from "../";
import { Collection } from "mongodb";


export class WitnessService {
    self: CoreService;
    witnessDb: Collection;
    constructor(self: CoreService) {
        this.self = self;
    }


    async proposeRound() {
        
    }

    async enableWitness() {
        this.self.identity

        // const transactionConfirm = await HiveClient.broadcast.json({
        //     required_auths: [],
        //     required_posting_auths: [process.env.HIVE_ACCOUNT],
        //     id: "vsc-testnet-hive",
        //     json: JSON.stringify({
        //         net_id: this.self.config.get("network.id"),
        //         action: "enable_witness",
        //         node_id: (await this.self.ipfs.id()).id,
        //         did: this.self.identity.id
        //     })
        // }, this.self.chainBridge.hiveKey)
        // console.log(transactionConfirm)

    }

    async start() {
        this.witnessDb = this.self.db.collection('witnesses')
        
    }
}