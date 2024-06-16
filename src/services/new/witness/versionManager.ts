import networks from "../../../services/networks";
import { NewCoreService } from "..";
import { HiveClient } from "../../../utils";
import { Collection } from "mongodb";



export const VersionConfig = {
    index_reset_id: 18,

     /**
      * should only be increased, but it can be decremented when trying a previous block reset
      * requires index_reset_id to be updated to trigger a reindex of the new block data
      */
    index_block_reset_id: 0,
    last_block_to_keep: [85032300],

    //Match with package.json and tag
    version_id: 'v0.1.5'
} as const;

/**
 * Manages signaling new versions of VSC releases.
 * Prevents conflicts and only applies upgrade if 70% of active nodes agree on it.
 * If node is not up to date then it will local block processing.
 */
export class VersionManager {
    self: NewCoreService;
    streamState: Collection;
    nonceMap: Collection;
    contracts: Collection;
    contractOutputs: Collection;
    blockHeaders: Collection;
    witnessHistory: Collection;
    witnessDb: Collection;
    accountAuths: Collection;
    txDb: Collection;
    electionResults: Collection;
    withdrawDb: Collection;
    ledgerDb: Collection;
    balanceDb: Collection;
    eventsDb: Collection<{
        id: 'hive_block',
        key: number
    }>;
    constructor(self: NewCoreService) {
        this.self = self;


        this.streamState = this.self.db.collection('stream_state')
        this.nonceMap = this.self.db.collection('nonce_map')
        this.contracts = this.self.db.collection('contracts')
        this.contractOutputs = this.self.db.collection('contract_outputs')
        this.blockHeaders = this.self.db.collection('block_headers')
        this.witnessHistory = this.self.db.collection('witness_history')
        this.witnessDb = this.self.db.collection('witnesses')
        this.accountAuths = this.self.db.collection('account_auths')
        this.txDb = this.self.db.collection('transaction_pool')
        this.electionResults = this.self.db.collection('election_results')
        this.withdrawDb = this.self.db.collection('bridge_withdrawals')
        this.ledgerDb = this.self.db.collection('bridge_ledger')
        this.balanceDb = this.self.db.collection('bridge_balances')
        this.eventsDb = this.self.db.collection('events')

        this.init = this.init.bind(this)
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

    async init() {
        const network = networks[this.self.config.get('network.id') as keyof typeof networks];

        const firstHiveBlockEvent = await this.eventsDb.findOne({id: 'hive_block'}, {sort: {key: 1}});
        const missingGenesis = !firstHiveBlockEvent || firstHiveBlockEvent.key !== network.genesisDay

        const resetBlocksEntry = await this.streamState.findOne({
            id: 'index_block_reset'
        });

        if(missingGenesis || (resetBlocksEntry !== null && resetBlocksEntry.val !== VersionConfig.index_block_reset_id)) {
            const index = resetBlocksEntry?.val ?? 0;
            const lastBlockToKeep = missingGenesis ? network.genesisDay - 1 : Math.min(...VersionConfig.last_block_to_keep.slice(index));

            console.log('Resetting block height to:', lastBlockToKeep);

            await this.eventsDb.deleteMany({
                id: 'hive_block',
                key: {
                    $gt: lastBlockToKeep,
                }
            })

            await this.streamState.findOneAndUpdate({
                id: 'last_hb'
            }, {
                $set: {
                    val: lastBlockToKeep
                }
            })

            await this.streamState.findOneAndUpdate({
                id: 'index_block_reset'
            }, {
                $set: {
                    val: VersionConfig.index_block_reset_id
                }
            }, {
                upsert: true
            })
        }

        const resetEntry = await this.streamState.findOne({
            id: "index_reset"
        })
        if(resetEntry === null || resetEntry.val !== VersionConfig.index_reset_id) {
            console.log('Must reset DB')

            
            await this.accountAuths.deleteMany({})
            await this.contractOutputs.deleteMany({})
            await this.contracts.deleteMany({})
            await this.witnessDb.deleteMany({})
            await this.witnessHistory.deleteMany({})
            await this.nonceMap.deleteMany({})
            await this.blockHeaders.deleteMany({})
            await this.txDb.deleteMany({})
            await this.electionResults.deleteMany({})
            await this.withdrawDb.deleteMany({})
            await this.ledgerDb.deleteMany({})
            await this.balanceDb.deleteMany({})

            await this.streamState.deleteOne({
                id: 'last_hb_processed'
            })

            await this.streamState.findOneAndUpdate({
                id: 'index_reset'
            }, {
                $set: {
                    val: VersionConfig.index_reset_id
                }
            }, {
                upsert: true
            })
        }
    }

    async start() {

    }
}