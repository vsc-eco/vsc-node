import { PrivateKey } from "@hiveio/dhive";
import NodeSchedule from 'node-schedule'
import { getCommitHash, HiveClient } from "../utils";
import { CoreService } from "./index";
import moment from "moment";
import { Collection } from "mongodb";


export class NodeInfoService {
    self: CoreService;
    gitCommit: any;
    nodeStatus: Collection<{
        id: string
        action: string
        expries: Date
    }>;
    lastUpdate: Date;

    constructor(self: CoreService) {
        this.self = self

        this.announceNode = this.announceNode.bind(this)
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


        if(moment().subtract('1', 'minute').toDate() < this.lastUpdate && this.lastUpdate) {
            return;
        }
        

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

        let witnessEnabled = this.self.config.get("witness.enabled");
        let disableReason;

        const nodeStatuses = await this.nodeStatus.find({
            action: 'disable_witness',
            expires: {
                $gt: new Date()
            }
        }).toArray()



        if(typeof witnessEnabled === "undefined") {
            witnessEnabled = false;
        }

        if(nodeStatuses.length > 0) {
            witnessEnabled = false
            disableReason = nodeStatuses[0].id
        }

        const ipfs_peer_id = (await this.self.ipfs.id()).id.toString()

       
        if(json_metadata.vsc_node) {
            if(
                json_metadata.vsc_node.unsigned_proof.witness.enabled === witnessEnabled && 
                json_metadata.vsc_node.unsigned_proof.net_id === this.self.config.get('network.id') && 
                json_metadata.vsc_node.unsigned_proof.ipfs_peer_id === ipfs_peer_id,
                json_metadata.vsc_node.unsigned_proof.git_commit === this.gitCommit,
                json_metadata.vsc_node.unsigned_proof.witness.disabled_reason === disableReason,
                json_metadata.vsc_node.unsigned_proof.witness.plugins?.includes('multisig')
            ) {
                if(moment().subtract('3', 'day').toDate() < new Date(json_metadata.vsc_node.unsigned_proof.ts)) {
                    //Node registration not required
                    return
                }
            }
        }



        const unsigned_proof = {
            net_id: this.self.config.get('network.id'),
            ipfs_peer_id,
            ts: new Date().toISOString(),
            hive_account: hiveAccount,
            git_commit: this.gitCommit,
            witness: {
                enabled: witnessEnabled,
                disabled_reason: disableReason,
                plugins: ['multisig'],
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

        const dag = await this.self.ipfs.dag.put(JSON.parse(JSON.stringify(registrationInfo)))

        const publishResult = await this.self.ipfs.name.publish(dag)
        console.log(publishResult)
        await HiveClient.broadcast.updateAccount({
            account: hiveAccount,
            memo_key: accountDetails.memo_key,
            json_metadata: JSON.stringify({
                ...json_metadata,
                vsc_node: registrationInfo
            })
        }, PrivateKey.from(process.env.HIVE_ACCOUNT_ACTIVE))

        this.lastUpdate = new Date()
    }

    async setStatus(options: {
        id: string
        action: string
        expires: Date
    }) {
        // await this.self
        await this.nodeStatus.findOneAndUpdate({
            id: options.id
        }, {
            $set: {
                action: options.action,
                expires: options.expires 
            }
        }, {
            upsert: true
        })
    }

    async retractStatus(id: string) {
        await this.nodeStatus.findOneAndDelete({
            id
        })
    }

    async start() {
        this.nodeStatus = this.self.db.collection('node_status')

        this.gitCommit = await getCommitHash()
        NodeSchedule.scheduleJob('0 * * * *', this.announceNode)
        await this.announceNode()
    }
}