import { Collection } from "mongodb";
import { NewCoreService } from ".";
import { MessageHandleOpts } from "./p2pService";
import { SignatureType, TransactionContainerV2, TransactionDbRecordV2, TransactionDbStatus, TransactionDbType } from "./types";
import { HiveClient, unwrapDagJws } from "../../utils";
import { PrivateKey } from "@hiveio/dhive";
import { encodePayload } from 'dag-jose-utils'
import { CID } from "kubo-rpc-client";
import { verifyTx } from "./utils";
import { convertTxJws } from "@vsc.eco/client/dist/utils";
import DAGCbor from 'ipld-dag-cbor'
import NodeSchedule from 'node-schedule'

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

        this.blockParser = this.blockParser.bind(this)
        this.onTxAnnounce = this.onTxAnnounce.bind(this)
    }

    /**
     * Runs when "announce_tx" is broadcasted on the P2P channels
     * @todo cleanup and DRY out signature validation logic.
     * @param param0 
     * @returns 
     */
    async onTxAnnounce({message}: MessageHandleOpts) {
        let decodedTx;
        let rawTx;
        let tx_id;
        let sig_data = message.sig_data; //Must always be defined
        if(message.type === 'ref_tx') {
            tx_id = message.id
            rawTx = (await this.self.ipfs.block.get(tx_id))
            decodedTx = DAGCbor.util.deserialize(rawTx)
        } else if(message.type = 'direct_tx') {
            rawTx = Buffer.from(message.data, 'base64url');
            decodedTx = DAGCbor.util.deserialize(rawTx)
            tx_id = (await this.self.ipfs.block.put(rawTx, {
                pin: false,
                format: 'dag-cbor'
            })).toString()
        } else {
            return;
        }
        const txRecord = await this.txDb.findOne({
            id: tx_id
        })
        if(!txRecord) { 
            if(!sig_data) {
                return;
            }
            //Run validation pipeline!
            
            const jwsList = await convertTxJws({
                sig: sig_data,
                tx: rawTx.toString('base64url')
            })
            const cid = await CID.parse(tx_id)
        
            for(let jws of jwsList) {
                if(jws.jws.payload !== Buffer.from(cid.bytes).toString('base64url')) {
                    return;
                }
                let signedDid;
                try {
                    const verifyResult = await this.self.identity.verifyJWS(jws.jws)
            
                    signedDid = verifyResult.kid.split('#')[0]
                } catch (ex) {
                    return;
                }
            
                if(!decodedTx.headers.required_auths.map(e => {
                    //Ensure there is no extra query fragments
                    return e.split('?')[0]
                }).includes(signedDid) && !(decodedTx.headers.payer === signedDid)) {
                    return;
                }
            }
            //TODO: Do nonce validation

            await this.txDb.insertOne({
                id: cid.toString(),
                status: TransactionDbStatus.unconfirmed,
                headers: {
                    nonce: decodedTx.headers.nonce
                },
                required_auths: decodedTx.headers.required_auths.map(e => {
                    const [value, query] = e.split('?')
                    return {
                        value,
                    }
                }),
                data: decodedTx.tx,
                sig_hash: (await this.self.ipfs.block.put(Buffer.from(sig_data, 'base64url'), {
                    format: 'dag-cbor'
                })).toString(),
                src: 'vsc',
                first_seen: new Date(),
                local: true,
                accessible: true
            })
        }
    }

    /**
     * Ingests TX into DB
     */
    async ingestTx(args: {
        tx: string,
        //Raw sig data
        sig: string
        broadcast?: boolean
    }) {
        if(typeof args.broadcast !== 'undefined') {
            //default to broadcast yes
            args.broadcast = true
        }

        const jwsList = await convertTxJws({
            sig: args.sig,
            tx: args.tx
        })
        const buf = Buffer.from(args.tx, 'base64url')
        const cid = await DAGCbor.util.cid(buf)
        const decodedTx = DAGCbor.util.deserialize(buf) as TransactionContainerV2
    
        for(let jws of jwsList) {
            console.log(jws.jws.payload, Buffer.from(cid.bytes).toString('base64url'))
            if(jws.jws.payload !== Buffer.from(cid.bytes).toString('base64url')) {
                throw new Error('Invalid Signature')
            }
            let signedDid;
            try {
                const verifyResult = await this.self.identity.verifyJWS(jws.jws)
        
                signedDid = verifyResult.kid.split('#')[0]
            } catch {
                throw new Error('Invalid Signature')
            }
        
            if(!decodedTx.headers.required_auths.map(e => {
                //Ensure there is no extra query fragments
                return e.split('?')[0]
            }).includes(signedDid) && !(decodedTx.headers.payer === signedDid)) {
                throw new Error('Incorrectly signed by wrong authority. Not included in "required_auths"')
            }
        }
        //TODO: Do nonce validation

        const txRecord = await this.txDb.findOne({
            id: cid.toString()
        })
        if(!txRecord) { 
            await this.txDb.insertOne({
                id: cid.toString(),
                status: TransactionDbStatus.unconfirmed,
                headers: {
                    nonce: decodedTx.headers.nonce
                },
                required_auths: decodedTx.headers.required_auths.map(e => {
                    const [value, query] = e.split('?')
                    return {
                        value,
                    }
                }),
                data: decodedTx.tx,
                sig_hash: (await this.self.ipfs.block.put(Buffer.from(args.sig, 'base64url'), {
                    format: 'dag-cbor'
                })).toString(),
                src: 'vsc',
                first_seen: new Date(),
                local: true,
                accessible: true
            })
        }
        await this.self.ipfs.block.put(buf, {
            format: 'dag-cbor'
        })

        
        if(buf.length > CONSTANTS.max_broadcast_size) {
            //Over broadcast limit
            await this.self.p2pService.memoryPoolChannel.call('announce_tx', {
                payload: {
                    type: 'ref_tx',
                    id: cid.toString(),
                    //Fill in
                    sig_data: args.sig
                },
                mode: 'basic'
            })
        } else {
            await this.self.p2pService.memoryPoolChannel.call('announce_tx', {
                payload: {
                    type: 'direct_tx',
                    data: buf.toString('base64url'),
                    //Fill in
                    sig_data: args.sig
                },
                mode: 'basic'
            })
        }


        return {
            id: cid.toString()
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
                    data: {
                        op: 'dummy_tx',
                        action: 'dummy_tx',
                        payload: 'test-test'
                    }
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
                },
                headers: {
                    type: TransactionDbType.null,
                    lock_block: currentBlock + 20 * 15,
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

    /**
     * Hive block parser for TX pool
     * @param args 
     * @returns 
     */
    protected async blockParser(args) {
        try {

             
            const {tx, blkHeight} = args.data

            for(let [op, opBody] of tx.operations) {
                if(op === 'custom_json') {
                    // console.log('picked up TX', tx, fullTx)
                    if(opBody.id === 'vsc.announce_tx' || opBody.id === 'vsc.tx') {
                        const json = JSON.parse(opBody.json)
            
                        if(json.net_id !== this.self.config.get('network.id')) {
                            return;
                        }
            
                        const required_auths = []
                        required_auths.push(...opBody.required_posting_auths.map(e => {
                            return `${e}?type=posting`
                        }))
                        required_auths.push(...opBody.required_auths.map(e => {
                            return `${e}?type=active`
                        }))
                        const txData = {
                            status: TransactionDbStatus.included,
                            id: `${tx.transaction_id}-${tx.index}`,
                            required_auths,
                            anchored_height: blkHeight,
                            anchored_index: tx.index,
                            headers: {
                                // lock_block: fullTx.block_height + 120,
                            },
                            data: {
                                contract_id: json.tx.contract_id,
                                op: json.tx.op,
                                payload: json.tx.payload,
                                action: json.tx.action,
                            },
                            result: null,
                            local: false,
                            first_seen: new Date(),
                            accessible: true,
                            src: "hive" as any,
                        }
                        await this.txDb.findOneAndUpdate({
                            id: `${tx.transaction_id}-${tx.index}`,
                        }, {
                            $set: txData
                        }, {
                            upsert: true
                        })
                    }
                }
            }
        } catch (ex) {
            console.log(ex)
        }
    }
    
    async init() {
        this.txDb = this.self.db.collection('transaction_pool')

        try {
            await this.txDb.createIndex(
                {
                    id: 1,
                },
                {
                    unique: true,
                },
            )
        } catch {}

        // this.self.chainBridge.registerTickHandle('tx_pool.processTx', this.tickHandle, {
        //     type: 'tx',
        //     priority: 'before'
        // })
        this.self.chainBridge.streamParser.addParser({
            name: "tx-pool",
            type: 'tx',
            priority: 'before',
            func: this.blockParser
        })
        this.self.p2pService.memoryPoolChannel.register('announce_tx', this.onTxAnnounce, {
            loopbackOk: true
        })
        NodeSchedule.scheduleJob('*/5 * * * *', async () => { 
            const unconfirmedTxs = await this.txDb.find({
                status: TransactionDbStatus.unconfirmed
            }).toArray()
    
            for(let tx of unconfirmedTxs) {
                await this.self.p2pService.memoryPoolChannel.call('announce_tx', {
                    payload: {
                        type: 'direct_tx',
                        data: Buffer.from(await this.self.ipfs.block.get(CID.parse(tx.id))).toString('base64url'),
                        //Fill in
                        sig_data: Buffer.from(await this.self.ipfs.block.get(CID.parse(tx.sig_hash))).toString('base64url')
                    },
                    mode: 'basic'
                })
            }
        })
    }

    async start() {

    }
}