import { Collection } from "mongodb";
import { NewCoreService } from ".";
import { MessageHandleOpts } from "./p2pService";
import { SignatureType, TransactionDbRecordV2, TransactionDbStatus, TransactionDbType } from "./types";
import { HiveClient, unwrapDagJws } from "../../utils";
import { PrivateKey } from "@hiveio/dhive";
import { encodePayload } from 'dag-jose-utils'
import { CID } from "kubo-rpc-client/dist/src";
import { verifyTx } from "./utils";

interface TxAnnounceMsg {
    //ref_tx = only CID of TX useful for TXs under 2kb
    //direct_tx entire TX data
    type: "ref_tx" | 'direct_tx'
    payload: any | CID
}

const CONSTANTS = {
    //Maximum size of directly broadcasting tx over pubsub. 
    //Instead of only CID
    //For large TXs CID ref should be used instead to prevent flooding network
    //TXs over pubsub direct are faster and incurr less receive latency.
    //Delivery is guaranteed.
    max_broadcast_size: 8_000
}

export class TransactionPoolV2 {
    self: NewCoreService;
    txDb: Collection<TransactionDbRecordV2>
    constructor(self: NewCoreService) {
        this.self = self

        this.tickHandle = this.tickHandle.bind(this)
    }

    async onTxAnnounce({message}: MessageHandleOpts) {
        console.log(message)
        let payload;
        let txId;
        if(message.type === 'ref_tx') {
            txId = message.id
            payload = (await this.self.ipfs.dag.get(txId)).value
        } else if(message.type = 'direct_tx') {
            payload = Buffer.from(message.data, 'base64');
            txId = (await this.self.ipfs.dag.put(payload, {
                onlyHash: true
            })).toString()
        } else {
            return;
        }

        const alreadyExistingTx = await this.txDb.findOne({
            id: txId.toString()
        })
        let auths = []
        if(!alreadyExistingTx) {
            const {content, auths: authsOut} = await unwrapDagJws(payload, this.self.ipfs, this.self.identity)

            console.log(content)

            await this.txDb.findOneAndUpdate({
                id: txId
            }, {

            }, {
                upsert: true
            })
        }
    }

    async broadcastRawTx(txData) {
        //Intercept final size data
        const {linkedBlock, cid} = await encodePayload(txData)
        //Added to IPFS irresepctive of broadcast method.
        await this.self.ipfs.block.put(linkedBlock)

        console.log('txData', txData)

        const validData = await verifyTx(txData, this.self.identity)
        console.log('validDid', validData, txData)

        const txRecord = await this.txDb.findOne({
            id: cid.toString()
        })
        if(!txRecord) {
            await this.txDb.findOneAndUpdate({
                id: cid.toString()
            }, {
                $set: {
                    status: TransactionDbStatus.unconfirmed,
                    required_auths: [],
                    headers: {
                        lock_block: null
                    },
                    data: txData.tx.payload,
                    result: null,
                    first_seen: new Date(),
                    accessible: true,
                    local: true,
                    src: 'vsc'
                }
            }, {
                upsert: true
            })
        }

        if(linkedBlock.length > CONSTANTS.max_broadcast_size) {
            //Over broadcast limit
            await this.self.p2pService.memoryPoolChannel.call('announce_tx', {
                payload: {
                    type: 'ref_tx',
                    id: cid.toString()
                },
                mode: 'basic'
            })
        } else {
            await this.self.p2pService.memoryPoolChannel.call('announce_tx', {
                payload: {
                    type: 'direct_tx',
                    data: Buffer.from(linkedBlock).toString('base64')
                },
                mode: 'basic'
            })
        }
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
        if(tx.id === 'vsc.announce_tx' || tx.id === 'vsc.tx') {
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
                    lock_block: fullTx.block_height + 120,
                    index: fullTx.index,
                    contract_id: json.data.contract_id
                },
                data: {
                    op: json.data.op,
                    payload: json.data.payload,
                    action: json.data.action,
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