import { Collection } from "mongodb";
import { NewCoreService } from ".";
import { MessageHandleOpts } from "./p2pService";
import { SignatureType, TransactionDbRecordV2, TransactionDbStatus, TransactionDbType } from "./types";
import { HiveClient } from "../../utils";
import { PrivateKey } from "@hiveio/dhive";

export class TransactionPoolV2 {
    self: NewCoreService;
    txDb: Collection<TransactionDbRecordV2>
    constructor(self: NewCoreService) {
        this.self = self

        this.tickHandle = this.tickHandle.bind(this)
    }

    async onTxAnnounce({message}: MessageHandleOpts) {
        console.log(message)
    }

    /**
     * Creates a demo TX for testing purposes
     */
    async createDummyTx(opts: {
        where: 'onchain' | 'offchain'
    }) {
        if(opts.where === 'onchain')  {
            const broadcast = await HiveClient.broadcast.json({
                required_auths: [],
                required_posting_auths: [process.env.HIVE_ACCOUNT],
                id: 'vsc.announce_tx',
                json: JSON.stringify({
                    net_id: this.self.config.get('network.id'),
                    op: 'dummy_tx',
                    action: 'dummy_tx',
                    payload: 'test-test'
                })
            }, PrivateKey.fromString(process.env.HIVE_ACCOUNT_POSTING))

            return broadcast;
        } else if(opts.where === 'offchain') {
            // const dataObj = {
            //     hello: "world"
            // }
            const currentBlock = await HiveClient.blockchain.getCurrentBlockNum()
            const partialData = {
                // ...dataObj,
                __t: 'vsc-tx',
                __v: '0.2',
                tx: { 
                    op: "null",
                    payload: 'test',
                    type: TransactionDbType.null,
                },
                headers: {
                    lock_block: currentBlock + 120,
                },
                required_auths: [
                    // {
                    //     // type: "posting",
                    //     value: this.self.identity.id
                    // }
                    this.self.identity.id
                ]
            } as any
            const result = await this.self.identity.createDagJWS(partialData)
            console.log(result)
            partialData.signatures = result.jws.signatures.map(e => {
                console.log(Buffer.from(e.protected, 'base64').toString())
                return {
                    t: SignatureType.JWS,
                    p: e.protected,
                    s: e.signature
                }
            })
            console.log(partialData)
            const cid = await this.self.ipfs.dag.put(partialData)
            console.log(await this.self.ipfs.block.stat(cid))
        } else {
            throw new Error('Invalid opts.where')
        }
    }

    async tickHandle(inData) {
        const [tx, fullTx] = inData
        // console.log('picked up TX', tx, fullTx)
        if(tx.id === 'vsc.announce_tx') {
            const json = JSON.parse(tx.json)

            if(json.net_id !== this.self.config.get('network.id')) {
                return;
            }

            const required_auths = []
            required_auths.push(...tx.required_posting_auths.map(e => {
                return {
                    type: 'posting',
                    value: e
                }
            }))
            required_auths.push(...tx.required_auths.map(e => {
                return {
                    type: 'active',
                    value: e
                }
            }))
            console.log('required_auths', required_auths)
            const txData = {
                status: TransactionDbStatus.included,
                id: fullTx.transaction_id,
                required_auths,
                headers: {
                    anchored_height: fullTx.block_height,
                    lock_block: fullTx.block_height + 120
                },
                data: {
                    op: json.op,
                    payload: json.payload,
                    action: json.action,
                },
                result: null,
                local: false,
                first_seen: new Date(),
                accessible: true,
                src: "hive" as any,
            }
            console.log('txData', txData)
            await this.txDb.insertOne(txData)
        }
    }
    
    async init() {
        this.txDb = this.self.db.collection('transaction_pool')
        this.self.chainBridge.registerTickHandle('tx_pool.processTx', this.tickHandle, {
            type: 'tx'
        })
        this.self.p2pService.memoryPoolChannel.register('announce_tx', this.onTxAnnounce)
        // this.createDummyTx({where: 'offchain'})
        // this.createDummyTx({where: 'onchain'})
    }

    async start() {

    }
}