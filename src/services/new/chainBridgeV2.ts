import * as IPFS from 'kubo-rpc-client'
import { Collection, Db } from "mongodb";
import DeepEqual from 'deep-equal'
import PQueue from "p-queue";
import { NewCoreService } from ".";
import { BlockHeader, HiveAccountAuthority } from "./types";
import networks from "../networks";
import { createMongoDBClient, fastStream, sleep } from "../../utils";
import { BlsCircuit } from './utils/crypto/bls-did';
import BitSet from 'bitset';



interface EventRecord {
    id: "hive_block"
    key: string | number
    [k: string]: any
}

interface ProcessingDepthMap {
    hive_block_parser: number
    vsc_block_parser: number
    vsc_block_verification: number
}


export class ChainBridgeV2 {
    stream: fastStream;
    db: Db;
    events: Collection<EventRecord>;
    accountAuths: Collection<HiveAccountAuthority>;
    streamState: Collection
    witnessDb: Collection
    witnessHistoryDb: Collection
    consensusDb: Collection
    consensusDataDb: Collection
    blockHeaders: Collection<BlockHeader>
    pinQueue: PQueue;
    self: NewCoreService;

    _tickHandles: Record<string, {
        type?: 'tx' | 'block'
        func: Function
    }>

    constructor(coreService) {
        this._tickHandles = {}
        this.self = coreService
        this.pinQueue = new PQueue({concurrency: 5})
    }


    async _processBlock([block_height, block]) {
        // console.log(block)
        let transactions = []
        for (let tx of block.transactions) {
            // console.log(tx)
            const [op, opPayload] = tx.operations[0]
            // console.log(opPayload)
            if (op === "account_update") {
                transactions.push({
                    operations: tx.operations,
                    transaction_id: tx.transaction_id,
                    index: block.transactions.indexOf(tx)
                })
            } else if (op === 'custom_json') {
                try {
                    if (opPayload.id.startsWith('vsc.')) {
                        transactions.push({
                            operations: tx.operations,
                            transaction_id: tx.transaction_id,
                            index: block.transactions.indexOf(tx)
                        })
                    }
                } catch {

                }
            }
        }
        // console.log({
        //     block_height,
        //     transactions
        // })
        await this.events.updateOne({
            id: 'hive_block',
            key: block_height
        }, {
            $set: {
                transactions
            }
        }, {
            upsert: true
        })
    }

    registerTickHandle(name, func: Function, opts?: {type: 'tx' | 'block'}) {
        this._tickHandles[name] = {
            type: opts.type,
            func
        }
    }

    async processEventStream() {
        console.log('processingEvents')
        let lastBlock;

        const lastProcessed = await this.streamState.findOne({
            id: 'last_hb_processed'
        })

        console.log(lastProcessed)
        if(lastProcessed) {
            lastBlock = lastProcessed.val
        }


        if (!lastBlock) {
            lastBlock = (await this.events.findOne({
                id: "hive_block"
            }, {
                sort: {
                    key: 1
                }
            }) || {}).key
        }
        while (true) {
            const blocks = await this.events.find({
                id: 'hive_block',
                key: { $gt: lastBlock }
            }, {
                sort: {
                    key: 1
                },
                limit: 120
            }).toArray()
            // console.log(blocks, {
            //     id: 'hive_block',
            //     key: {$gt: lastBlock}
            // })
            if (blocks.length === 0) {
                await sleep(2_000)
            }
            for (let blk of blocks) {
                for(let [name, {type, func}] of Object.entries(this._tickHandles)) {
                    if(type === 'block') {
                        try {
                            await func(blk)
                        } catch(ex) {
                            console.log(ex)
                        }
                    }
                }
                for (let tx of blk.transactions) {

                    try {
                        //Handle insertions of account update into DB or other TXs
                        const [op, opPayload] = tx.operations[0]
                        // console.log(opPayload)
                        if (op === "account_update") {
                            try {
                                let json
                                try {
                                    json = JSON.parse(opPayload.json_metadata)
                                } catch {
                                    json = {}
                                }
                                
                                const keys = []
                                if(Array.isArray(json.did_keys)) {
                                    keys.push(...json.did_keys)
                                }
                                const lastRecord = await this.accountAuths.findOne({
                                    account: opPayload.account,
                                }, {
                                    sort: {
                                        valid_from: -1
                                    }
                                })
                                
                                if (json.vsc_node) {
                                    // console.log(json)
                                    // console.log(opPayload)
                                    // console.log(tx)
                                    keys.push({
                                        ct: 'DID',
                                        t: 'node_id',
                                        key: json.vsc_node.did as string,
                                    })
                                    
                                    const enabled = json.vsc_node.unsigned_proof.witness.enabled;
                                    
                                    
                                    const lastRecordHistory = await this.witnessHistoryDb.findOne({
                                        account: opPayload.account,
                                        type: 'witness.toggle'
                                    }, {
                                        sort: {
                                            valid_from: -1
                                        }
                                    })
                                    
                                    let valid_from2;
                                    //Ensure lastRecord
                                    if (!!lastRecordHistory) {
                                        if (lastRecordHistory.enabled === enabled) {
                                            valid_from2 = lastRecord.valid_from
                                        } else {
                                            await this.witnessHistoryDb.updateOne({
                                                _id: lastRecordHistory._id
                                            }, {
                                                $set: {
                                                    valid_to: Number(blk.key)
                                                }
                                            })
                                            valid_from2 = Number(blk.key);
                                        }
                                    } else {
                                        valid_from2 = Number(blk.key)
                                    }
    
                                    await this.witnessHistoryDb.updateOne({
                                        account: opPayload.account,
                                        valid_from:valid_from2,
                                        type: "witness.toggle"
                                    }, {
                                        $set: {
                                            enabled,
                                            ref_id: tx.transaction_id
                                        }
                                    }, {
                                        upsert: true
                                    })

                                    await this.witnessHistoryDb.updateOne({
                                        account: opPayload.account,
                                        valid_from:Number(blk.key),
                                        type: "witness.last_signed"
                                    }, {
                                        $set: {
                                            ref_id: tx.transaction_id
                                        }
                                    }, {
                                        upsert: true
                                    })
                                    
    
                                    //Handle witness DB update
                                    await this.witnessDb.updateOne({
                                        account: opPayload.account
                                    }, {
                                        $set: {
                                            net_id: json.vsc_node.unsigned_proof.net_id,
                                            ipfs_peer_id: json.vsc_node.unsigned_proof.ipfs_peer_id,
                                            signing_keys: json.vsc_node.unsigned_proof.witness.signing_keys,
                                            last_signed: blk.key
                                        }
                                    }, {
                                        upsert: true
                                    })
                                }
                                
        
                                let valid_from;
                                //Ensure lastRecord
                                if (!!lastRecord) {
                                    if (DeepEqual(lastRecord.keys, keys)) {
                                        valid_from = lastRecord.valid_from
                                    } else {
                                        await this.accountAuths.updateOne({
                                            _id: lastRecord._id
                                        }, {
                                            $set: {
                                                valid_to: Number(blk.key)
                                            }
                                        })
                                        valid_from = Number(blk.key);
                                    }
                                } else {
                                    valid_from = Number(blk.key)
                                }
        
    
                                if(typeof keys !== 'undefined') {
                                    await this.accountAuths.updateOne({
                                        account: opPayload.account,
                                        valid_from
                                    }, {
                                        $set: {
                                            keys: keys as any,
                                            ref_id: tx.transaction_id
                                        }
                                    }, {
                                        upsert: true
                                    })
                                }
                            } catch(ex) {
                                // console.log(ex)
                                // console.log(opPayload.json_metadata)
                            }
                        } else if (op === 'custom_json') {
                            try {
                                if (opPayload.id.startsWith('vsc.')) {


                                    // console.log(opPayload)
                                    // console.log('txDI', tx)
                                    for(let [name, {type, func}] of Object.entries(this._tickHandles)) {
                                        if(type === 'tx') {
                                            try {
                                                tx.block_height = blk.key
                                                await func([opPayload, tx])
                                            } catch (ex) {
                                                console.log(ex)
                                            }
                                        }
                                    }
                                    const json = JSON.parse(opPayload.json)
                                    // await this.events.updateOne({
                                    //     id: "announce_block",
                                    //     key: json.block_hash,
                                    // }, {
                                    //     $set: {
                                    //         block_height: blk.key,
                                    //         status: "need_pin"
                                    //     }
                                    // }, {
                                    //     upsert: true
                                    // })

                                    if(opPayload.id === "vsc.propose_block" && json.net_id === this.self.config.get('network.id')) {
                                        //Initial checks passed
                                        const slotHeight = Number(blk.key);
                                        const witnessSet = (await this.getWitnessesAtBlock(slotHeight)).map(e => {
                                            return e.keys.find(key => {
                                              console.log(key)
                                              return key.t === "consensus"
                                            })
                                        }).filter(e => !!e).map(e => e.key)
                                        const witnessSchedule = await this.self.witness.roundCheck(slotHeight)

                                        //Check witnessSlot validity prior to validation
                                        const witnessSlot = witnessSchedule.find(e => {
                                            return e.bn === slotHeight && e.account === opPayload.required_auths[0]
                                        })

                                        if(witnessSlot) {
                                            const signedBlock = {
                                                ...json.signed_block,
                                                block: IPFS.CID.parse(json.signed_block.block)
                                            }
    
                                            const circuit = BlsCircuit.deserialize(signedBlock, witnessSet)
                                            
                                            let pubKeys = []
                                            for(let pub of circuit.aggPubKeys) {
                                                pubKeys.push(pub)
                                            }

                                            if(circuit.verifyPubkeys(pubKeys)) {

                                            }

                                            
                                            this.pinQueue.add(async() => {
                                                // console.log(json.block_hash)
                                                await this.self.ipfs.pin.add(IPFS.CID.parse(json.block_hash), {
                                                    recursive: false
                                                })
                                                await this.self.ipfs.pin.rm(IPFS.CID.parse(json.block_hash))
                                            })
                                        }
                                        
                                        
                                    }
                                }
                            } catch (ex) {
                                console.log(ex)
    
                            }
                        }

                    } catch (ex) {
                        console.log(ex)
                    }

                    
                }
                if(this.pinQueue.size > 0) {
                    // console.log('this.pinQueue.size', this.pinQueue.size)
                }
                lastBlock = blk.key
                await this.streamState.updateOne({
                    id: 'last_hb_processed'
                }, {
                    $set: {
                        val: lastBlock
                    }
                }, {
                    upsert: true
                })
            }
            //TODO: handle commiting after X has completed
        }
    }

    async getWitnessesAtBlock(blk: number) {
        const witnesses = await this.witnessDb.find().toArray()
        const filteredWitnesses = (await Promise.all(witnesses.map(async(e) => {
            let query
            let sort
            if(blk) {
                query = {
                    type: "witness.toggle",
                    account: e.account,
                    
                    valid_from: {
                        $lt: blk
                    },
                    
                }
                sort = {
                    valid_from: -1
                }
            } else {
                query = {
                    type: "witness.toggle",
                    account: e.account,
    
                    $or: [{
                        valid_to: {
                            $exists: false
                        }
                    }, {
                        valid_to: null
                    }]
                }
                sort = {
                    valid_from: -1
                }
            }
            const data = await this.witnessHistoryDb.findOne(query, {
                sort
            })
            // console.log(data)

            if(!data) {
                // console.log('filtered out 309', e.account)
                return null;
            }
            
            if(data.enabled !== true) {
                // console.log('filtered out 314', e.account, data)
                return null;
            }

            // console.log(data, {
            //     account: data.account,
            //     valid_from: {
                //         $gt: data.valid_from
                //     }
                // })
                const keys = await this.accountAuths.findOne({
                    account: data.account,
                    valid_from: {
                        $lte: data.valid_from
                    },
                    $or: [
                        {
                            valid_to: {$exists: false}
                        }, {
                            valid_to: {
                                $gt: data.valid_from
                        }
                    }
                ]
            }, {
                sort: {
                    valid_to: 1
                }
            })
            
            const lastSigned = await this.witnessHistoryDb.findOne({
                account: data.account,
                type: "witness.last_signed",
                valid_from: {
                    $lt: blk
                }
            }, {
                sort: {
                    valid_from: -1
                }
            })

            const maxSignedDiff = (3 * 24 * 60 * 20)

            if(blk - lastSigned.valid_from > maxSignedDiff) {
                return null
            }

            // console.log(keys)
            if(keys) {
                e.keys = keys.keys;
            } else {
                // console.log('keys is empty')
                // console.log('filtered out 347 keys', e.account)
                return null
            }
            
            return e;
        }))).filter(e => !!e)
        
        // console.log('filteredWitnesses', filteredWitnesses, filteredWitnesses.length)
        return filteredWitnesses;
    }

    async createConsensusHeader(height: number) {
        const consensusList = await this.getWitnessesAtBlock(height)

    }

    async init() {
        
        this.db = this.self.db
        this.events = this.db.collection('events')
        this.accountAuths = this.db.collection('account_auths')
        this.streamState = this.db.collection('stream_state')
        this.witnessDb = this.db.collection('witnesses')
        this.witnessHistoryDb = this.db.collection('witness_history')
        this.consensusDb = this.db.collection('consensus')
        this.consensusDataDb = this.db.collection('consensus_data')
        
        try {
            await this.events.createIndex({
                id: -1,
                key: -1
            }, {
                unique: true
            })
        } catch {

        }
        const startBlock = (await this.streamState.findOne({ id: "last_hb" }) || {} as any).val || networks[this.self.config.get('network.id')].genesisDay
        console.log('start block is', startBlock)
        this.stream = await fastStream.create({
            startBlock
        })
        await this.stream.init()
        void (async () => {
            let lastBlk;
            setInterval(async () => {
                if (lastBlk) {
                    await this.streamState.updateOne({
                        id: 'last_hb'
                    }, {
                        $set: {
                            val: lastBlk
                        }
                    }, {
                        upsert: true
                    })
                }
            }, 1000)
            for await (let [block_height, block] of this.stream.streamOut) {
                // console.log('processing block', block_height)
                await this._processBlock([block_height, block])
                lastBlk = block_height
            }
        })()
        this.processEventStream()
    }

    async start() {
        this.stream.startStream()

        const witnesses = await this.self.chainBridge.getWitnessesAtBlock(78_000_000)
        console.log('witnesses at time', witnesses.map(e => e.account))
    }
}