import { HiveClient } from "../utils";
import { PrivateKey } from "@hiveio/dhive";
import { CoreService } from "./index";
import moment from "moment";


export class NodeInfoService {
    self: CoreService;
    constructor(self: CoreService) {
        this.self = self
    }
    async announceNode() {
        /**
         * Registers node with HIVE blockchain
         * Creates two way link between node DID identity (signing key) & IPFS PeerID & HIVE account
         * Once established, other nodes can index and identify each other and create partner relationships for smart contract execution or data exchange.
         * 
         * This handles linkage between Hive account <--> DID
         * In P2P channels: link can be verified between DID <--> PeerId
         */
        

        const hiveAccount = process.env.HIVE_ACCOUNT

        if(!hiveAccount || !process.env.HIVE_ACCOUNT_ACTIVE) {
            console.warn('Cannot register node due to lack of hive account name or postingkey')
            return;
        }
        const [accountDetails] = await HiveClient.database.getAccounts([hiveAccount])

        let json_metadata;
        try {
            json_metadata = JSON.parse(accountDetails.json_metadata)
        } catch {
            json_metadata = {}
        }
        if(json_metadata.vsc_node) {
            if(moment().subtract('3', 'day').toDate() < new Date(json_metadata.vsc_node.unsigned_proof.ts)) {
                //Node registration not required
                return
            }
        }

        const unsigned_proof = {
            net_id: this.self.config.get('network.id'),
            ipfs_peer_id: (await this.self.ipfs.id()).id.toString(),
            ts: new Date().toISOString(),
            hive_account: hiveAccount,
            witness: {
                enabled: false,
                signing_keys: {
                    posting: PrivateKey.fromString(this.self.config.get('identity.signing_keys.posting')).createPublic().toString(),
                    active: PrivateKey.fromString(this.self.config.get('identity.signing_keys.active')).createPublic().toString(),
                    owner: PrivateKey.fromString(this.self.config.get('identity.signing_keys.owner')).createPublic().toString()
                }
            }
        }
        const registrationInfo = {
            did: this.self.identity.id,
            unsigned_proof,
            signed_proof: await this.self.identity.createJWS(unsigned_proof),
        }

        const dag = await this.self.ipfs.dag.put(registrationInfo)

        const publishResult = await this.self.ipfs.name.publish(dag)
        console.log(publishResult)
        await HiveClient.broadcast.updateAccount({
            account: hiveAccount,
            memo_key: accountDetails.memo_key,
            json_metadata: JSON.stringify({
                ...JSON.parse(accountDetails.json_metadata),
                vsc_node: registrationInfo
            })
        }, PrivateKey.from(process.env.HIVE_ACCOUNT_ACTIVE))
    }
    async start() {
        await this.announceNode()
    }
}