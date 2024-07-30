import * as IPFS from 'kubo-rpc-client'
import { Collection, Db, MongoServerError } from "mongodb";
import DeepEqual from 'deep-equal'
import PQueue from "p-queue";
import { encodePayload } from 'dag-jose-utils'
import { NewCoreService } from ".";
import { BlockHeader, HiveAccountAuthority, TransactionDbStatus, TransactionDbType, WitnessDbRecord } from "./types";
import networks from "../networks";
import { createMongoDBClient, fastStream, sleep, truthy } from "../../utils";
import { BlsCircuit } from './utils/crypto/bls-did';
import BitSet from 'bitset';
import { EventRecord, ParserFuncArgs, StreamParser, computeKeyId } from './utils';
import { CID } from 'multiformats';


interface BlockHeaderDbRecord {
    id: string
    proposer: string
    merkle_root: string
    sig_root: string
    block: string
    start_block: number
    end_block: number
    slot_height: number
    stats: {
        size: number
    }
    ts: Date
}

type WitnessHistoryDbRecord =
  | {
      account: string
      type: 'witness.toggle'
      valid_from: number
      enabled: boolean
      net_id: string
      ref_id: string
    }
  | {
      account: string
      type: 'witness.last_signed'
      valid_from: number
      ref_id: string
    }


export class ChainBridgeV2 {
    streamParser: StreamParser
    db: Db;
    events: Collection<EventRecord>;
    accountAuths: Collection<HiveAccountAuthority>;
    streamState: Collection
    witnessDb: Collection<WitnessDbRecord>
    witnessHistoryDb: Collection<WitnessHistoryDbRecord>
    consensusDb: Collection
    consensusDataDb: Collection
    blockHeaders: Collection<BlockHeaderDbRecord>
    contractOutputDb: Collection
    pinQueue: PQueue;
    self: NewCoreService;

    

    constructor(coreService) {
        this.self = coreService
        this.pinQueue = new PQueue({concurrency: 5})

        this.defaultFilter = this.defaultFilter.bind(this)
        this.blockParser = this.blockParser.bind(this)
    }

    get blockLag() {
        return this.streamParser.stream.blockLag
    }

    get parseLag() {
        if(this.streamParser.stream.calcHeight) {
            return this.streamParser.stream.calcHeight - this.streamParser.lastParsed 
        } else {
            return 999999;
        }
    }

    protected defaultFilter(args) {
        const {tx} = args

        const [op, opPayload] = tx.operations[0]
        // console.log(opPayload)
        const multisigAccount = networks[this.self.config.get('network.id')].multisigAccount
        try {
            if (op === "account_update") {
                return {
                    pass: true
                }
            } else if (op === 'custom_json') {
                if (opPayload.id.startsWith('vsc.')) {
                    return {
                        pass: true
                    }
                }
            } else if(op === 'transfer') {
                if(opPayload.to === multisigAccount || opPayload.from === multisigAccount || opPayload.to.includes('vsc.') || opPayload.from.includes('vsc.')) {
                    return {
                        pass: true
                    }
                }
            }
        } catch {
    
        }
        return {
            pass: false
        }
    }

    protected async blockParser(args: ParserFuncArgs<'tx'>) {
        const {data, halt} = args;

        const {tx, blkHeight, block_id, timestamp} = data;

        for(const [op, opPayload] of tx.operations) {

            // console.log('The teleporter is broken!', op, opPayload)

            
            if (op === "account_update") {
                // await args.halt()
                try {
                    let json
                    try {
                        json = JSON.parse(opPayload.json_metadata)
                    } catch {
                        json = {}
                    }
                    
                    const keys: HiveAccountAuthority['keys'] = []
                    // TODO zod verification
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
                        const net_id = json.vsc_node.unsigned_proof.net_id
                        
                        
                        const lastRecordHistory = await this.witnessHistoryDb.findOne({
                            account: opPayload.account,
                            type: 'witness.toggle'
                        }, {
                            sort: {
                                valid_from: -1
                            }
                        })
                        
                        let valid_from2: number;
                        //Ensure lastRecord
                        if (!!lastRecordHistory) {
                            if (lastRecordHistory.type === 'witness.toggle' && lastRecordHistory.enabled === enabled && lastRecord) {
                                valid_from2 = lastRecord.valid_from
                            } else {
                                await this.witnessHistoryDb.updateOne({
                                    _id: lastRecordHistory._id
                                }, {
                                    $set: {
                                        valid_to: blkHeight
                                    }
                                })
                                valid_from2 = blkHeight;
                            }
                        } else {
                            valid_from2 = blkHeight
                        }
    
                        await this.witnessHistoryDb.updateOne({
                            account: opPayload.account,
                            valid_from:valid_from2,
                            type: "witness.toggle"
                        }, {
                            $set: {
                                enabled,
                                net_id: net_id,
                                ref_id: tx.transaction_id
                            }
                        }, {
                            upsert: true
                        })
    
                        await this.witnessHistoryDb.updateOne({
                            account: opPayload.account,
                            valid_from:blkHeight,
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
                                version_id: json.vsc_node.unsigned_proof.version_id,
                                ipfs_peer_id: json.vsc_node.unsigned_proof.ipfs_peer_id,
                                signing_keys: json.vsc_node.unsigned_proof.witness.signing_keys,
                                last_signed: blkHeight
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
                                    valid_to: blkHeight
                                }
                            })
                            valid_from = blkHeight;
                        }
                    } else {
                        valid_from = blkHeight
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
                        
                        
                        console.log(opPayload.id === "vsc.propose_block", json.net_id, this.self.config.get('network.id'),json.replay_id === 2)
                        if(opPayload.id === "vsc.propose_block" && json.net_id === this.self.config.get('network.id') && json.replay_id === 2) {
                            console.log('REPLAYING BLOCK')
                            try {
                                //Initial checks passed
                                const blockHeight = blkHeight;
                                // const witnessSet = (await this.getWitnessesAtBlock(blockHeight)).map(e => {
                                //     return e.keys.find(key => {
                                //       return key.t === 'consensus'
                                //       //TODO finish verification flow
                                //     })
                                // }).sort((a, b) => {
                                //     return a.account - b.account;
                                // }).filter(e => !!e).map(e => e.key)
                                const lastElection = await this.self.electionManager.getValidElectionOfblock(blockHeight)
                                const blockSignerList = (await this.self.electionManager.getMembersOfBlock(blockHeight));
                                const witnessSet = blockSignerList.map(e => e.key)
                                // console.log('Asking for schedule at slot', blockHeight)
                                const witnessSchedule = await this.self.witness.getBlockSchedule(blockHeight)
    
                                
                                const slotHeight = (blockHeight - (blockHeight % networks[this.self.config.get('network.id')].roundLength)) //+ networks[this.self.config.get('network.id')].roundLength
                                const witnessSlot = witnessSchedule.find(e => {
                                    //Ensure witness slot is within slot start and end
                                    // console.log('slot check', e.bn === slotHeight && e.account === opPayload.required_auths[0])
                                    return e.bn === slotHeight && e.account === opPayload.required_auths[0]
                                })
                                
                                /**
                                 * TODO:
                                 * - On top of slot validation, double broadcast validation needs to be done to prevent processing the same block
                                 */
                                if(witnessSlot) {
                                    const signedBlock = {
                                        ...json.signed_block,
                                        block: CID.parse(json.signed_block.block)
                                    }
    
                                    const circuit = BlsCircuit.deserialize(signedBlock, witnessSet)
    
                                    
                                    let pubKeys: string[] = []
                                    let signerNames: string[] = []
                                    for(let pub of circuit.aggPubKeys) {
                                        pubKeys.push(pub[0])
                                        signerNames.push(blockSignerList.find(e => e.key === pub[0]).account)
                                    }
    
    
                                    //Aggregate pubkeys
                                    circuit.setAgg(pubKeys)
                                    const signed_block = json.signed_block
                                    signed_block.block = IPFS.CID.parse(signed_block.block)
                                    const signedBlockNoSig = signed_block;
                                    delete signedBlockNoSig.signature
                                    
    
                                    const isValid = await circuit.verify((await this.self.ipfs.dag.put(signedBlockNoSig, {
                                        onlyHash: true
                                    })).bytes);

                                    if(!isValid) {
                                        console.log('singature is NOT valid')
                                        continue;
                                    }
                                    
                                    const voteMajority = 2/3
                                    


                                    let votedWeight = 0;
                                    let totalWeight = 0;
                                    if(lastElection.weights) {
                                        //Vote based off weight
                                        for(let key of pubKeys) {
                                            const member = lastElection.members.find(e => e.key === key)
                                            if(member) {
                                                votedWeight += lastElection.weights[lastElection.members.indexOf(member)]
                                            }
                                        }
                                        // votedWeight = lastElection.weight_total * voteMajority
                                        totalWeight = lastElection.weight_total
                                    } else {
                                        //Vote based off signer count
                                        votedWeight = pubKeys.length
                                        totalWeight = witnessSet.length
                                    }
                                    
                                    if((votedWeight / totalWeight) < voteMajority) {
                                        console.log('Not hitting vote majority')
                                        continue;
                                    }
                                    const anchorId = (await this.self.ipfs.dag.put(json.signed_block, {
                                        onlyHash: true
                                    })).toString()

                                    const [startBlock, endBlock] = signedBlock.headers.br

                                    const alreadyIncludedBlock = await this.blockHeaders.findOne({
                                        $or: [
                                            {
                                                slot_height: slotHeight
                                            }, 
                                            {
                                                id: anchorId
                                            }
                                        ]
                                    })
 
                                    if(alreadyIncludedBlock) {
                                        console.log(new Error('Already includedInBlock'))
                                        continue;
                                    }
                                    
                                    console.log([startBlock, endBlock])
                                    const block_full = (await this.self.ipfs.dag.get(signed_block.block)).value
                                    console.log('full block content', block_full)
                                    
                                    await this.blockHeaders.findOneAndUpdate({
                                        id: anchorId
                                    }, {
                                        $set: {
                                            proposer: opPayload.required_auths[0],
                                            merkle_root: signed_block.merkle_root,
                                            sig_root: block_full.sig_root,
                                            block: signed_block.block.toString(),
                                            start_block: startBlock,
                                            end_block: endBlock,
                                            slot_height: slotHeight,
                                            stats: {
                                                size: (await this.self.ipfs.block.get(signed_block.block)).length
                                            },
                                            ts: timestamp,
                                            signers: signerNames
                                        }
                                    }, {
                                        upsert: true
                                    })

                                    console.log(block_full)

                                    // TODO pin block_full somewhere
                                    let nonceMap = {}
                                    for(let i = 0; i < block_full.txs.length; i++) {
                                        const tx = block_full.txs[i];
                                        this.pinQueue.add(async() => {
                                            // console.log(json.block_hash)
                                            await this.self.ipfs.pin.add(IPFS.CID.parse(tx.id), {
                                                recursive: false
                                            })
                                        })
                                        const start = Date.now();
                                        console.log('Fetching IPFS CID: ', tx.id)
                                        const txData = (await this.self.ipfs.dag.get(CID.parse(tx.id))).value
                                        console.log('Finished Fetching IPFS CID:', tx.id, Date.now() - start)
                                        
                                        if(tx.type === TransactionDbType.output) {
                                            await this.self.contractEngine.contractDb.findOneAndUpdate({
                                                id: txData.contract_id,
                                            }, {
                                                $set: {
                                                    state_merkle: txData.state_merkle,
                                                },
                                            })

                                            //Process as output
                                            await this.contractOutputDb.findOneAndUpdate({
                                                id: tx.id,
                                            }, {
                                                $set: {
                                                    anchored_index: i,
                                                    anchored_height: blkHeight,
                                                    anchored_id: anchorId,
                                                    anchored_block: block_id,
                                                    contract_id: txData.contract_id,
                                                    state_merkle: txData.state_merkle,
                                                    //TODO: look into properly handling side effects aka on chain actions
                                                    side_effects: txData.side_effects,
                                                    //TODO: future; handle op index (i.e multiple oprations in 1 tx)
                                                    inputs: txData.inputs.map(e => {
                                                        if(e.startsWith('@remote')) {
                                                            //work on this some more
                                                            return Number(e.split('/')[1]);
                                                        } else {
                                                            return e;
                                                        }
                                                    }),
                                                    results: txData.results,
                                                    // logs: txData.logs,
                                                    gas: {
                                                        IO: txData.io_gas
                                                    }
                                                }
                                            }, {
                                                upsert: true
                                            })
                                            for(let txInput of txData.inputs) {
                                                try {
                                                    await this.self.transactionPool.txDb.findOneAndUpdate({
                                                        id: txInput
                                                    }, {
                                                        $set: {
                                                            status: TransactionDbStatus.confirmed,
                                                            output: {
                                                                index: txData.inputs.indexOf(txInput),
                                                                id: tx.id,
                                                            }
                                                        }
                                                    })
                                                } catch (e) {
                                                    console.error(e)
                                                }
                                            }
                                            if(txData.ledger_results) {
                                                for(let idx in txData.ledger_results) {
                                                    const ledgerEntry = txData.ledger_results[idx]
                                                    if(ledgerEntry.to === "#withdraw") {
                                                        //Safety for when replaying
                                                        const withdrawRecord = await this.self.witness.balanceKeeper.withdrawDb.findOne({
                                                            id: `${tx.id}-${idx}`
                                                        })
                                                        if(!withdrawRecord) {
                                                            await this.self.witness.balanceKeeper.withdrawDb.insertOne({ 
                                                                id: `${tx.id}-${idx}`,
                                                                amount: ledgerEntry.amount,
                                                                from: ledgerEntry.from,
                                                                dest: ledgerEntry.dest,
                                                                type: "CONTRACT_WITHDRAW"
                                                            })
                                                        }
                                                    } 
                                                    await this.self.witness.balanceKeeper.ledgerDb.findOneAndUpdate({
                                                        id: `${tx.id}-${idx}`
                                                    }, {
                                                        $set: {
                                                            amount: ledgerEntry.amount,
                                                            from: ledgerEntry.from,
                                                            to: ledgerEntry.to,
                                                            dest: ledgerEntry.dest,
                                                            owner: ledgerEntry.owner,
                                                        }
                                                    }, {
                                                        upsert: true
                                                    })
                                                }
                                            }
                                        } else if(tx.type === TransactionDbType.input) {
                                            nonceMap[await computeKeyId(txData.headers.required_auths)] = txData.headers.nonce

                                            // console.log('reindex txRecord', txRecord, tx, txData)
                                            // console.log(txData.headers.nonce)
                                            try {
                                                //Do ingestion if not already indexed.
                                                //This will mainly be the case during initial sync
                                                //Note, transactions that are ingested do not have sig data attached
                                                await this.self.transactionPool.txDb.insertOne({
                                                    status: TransactionDbStatus.included,
                                                    id: tx.id,
                                                    required_auths: txData.headers.required_auths, // TODO input validation
                                                    headers: {
                                                        nonce: txData.headers.nonce
                                                    },
                                                    data: txData.tx,
                                                    local: false,
                                                    accessible: true,
                                                    first_seen: new Date(),
                                                    anchored_height: endBlock,
                                                    anchored_block: block_id,
                                                    anchored_id: anchorId, 
                                                    anchored_index: i,
                                                    anchored_op_index: 0,
                                                    src: "vsc"
                                                })
                                            } catch (e) {
                                                if (
                                                  e instanceof MongoServerError &&
                                                  e.code === 11000 // key already exist
                                                ) {
                                                  //Modify existing
                                                  await this.self.transactionPool.txDb.findOneAndUpdate(
                                                    {
                                                      id: tx.id,
                                                    },
                                                    {
                                                      $set: {
                                                        status: TransactionDbStatus.included,
                                                        anchored_height: endBlock,
                                                        anchored_block: block_id,
                                                        anchored_id: anchorId,
                                                        anchored_index: i,
                                                        anchored_op_index: 0,
                                                      },
                                                    },
                                                  )
                                                } else {
                                                    console.log(e)
                                                }
                                            }
                                        }
                                    }

                                    for(let [key, nonce] of Object.entries<number>(nonceMap)) {
                                        await this.self.nonceMap.findOneAndUpdate({
                                          id: key
                                        }, {
                                            $set: {
                                                nonce: nonce + 1
                                            }
                                        }, {
                                            upsert: true
                                        })
                                    }
    
                                    
                                    // if(circuit.verifyPubkeys(pubKeys)) {
                                    // }
    
                                    
                                } else {
                                    console.log('witness slot does not match')
                                }
                                // await args.halt()
                            } catch(ex) {
                                console.log(ex)
                                console.log('Error on index process')
                            }
                        }
                    }
                } catch (ex) {
                    console.log(ex)
                }
            }
        }
        
    }


    async processVSCBlock() {

    }

    async getLatestBlock(): Promise<number> { 
        const block = await this.events.findOne({}, {
            sort: {
                key: -1
            }
        })
        if (!block) {
            throw new Error('could not get lastest block')
        }
        return Number(block.key)
    }

    async getWitnessesAtBlock(blk: number) {
        //This is not safe as it can vary with historical records
        const witnesses = await this.witnessDb.find({
            net_id: this.self.config.get('network.id')
        }).toArray()
        const filteredWitnesses = (await Promise.all(witnesses.map(async(e) => {
            const data = await this.witnessHistoryDb.findOne({
                    type: "witness.toggle",
                    account: e.account,
                    
                    valid_from: {
                        $lte: blk
                    },
                    
                }, {
                sort: {
                    valid_from: -1
                }
            })
            // console.log(data)

            if(!data) {
                // console.log('filtered out 309', e.account)
                return null;
            }
            
            if(data.type === 'witness.toggle' && data.enabled !== true) {
                // console.log('filtered out 314', e.account, data)
                return null;
            }
                const keys = await this.accountAuths.findOne({
                    account: data.account,
                    valid_from: {
                        $lt: blk
                    },
                //     $or: [
                //         {
                //             valid_to: {$exists: false}
                //         }, {
                //             valid_to: {
                //                 $gt: blk
                //         }
                //     }
                // ]
            }, {
                sort: {
                    valid_from: -1
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

            if(!lastSigned) {
                return null
            }

            const maxSignedDiff = (3 * 24 * 60 * 20)

            if(blk - lastSigned.valid_from > maxSignedDiff) {
                return null
            }

            // console.log(keys)
            if(keys) {
                return { ...e, keys: keys.keys }
            } else {
                // console.log('keys is empty')
                // console.log('filtered out 347 keys', e.account)
                return null
            }
        }))).filter(truthy)
        
        // console.log('filteredWitnesses', filteredWitnesses, filteredWitnesses.length)
        return filteredWitnesses.sort((a, b) => {
            return ('' + a.account).localeCompare(b.account);
        })
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
        this.blockHeaders = this.db.collection('block_headers')
        this.contractOutputDb = this.db.collection('contract_outputs')
        
        this.streamParser = new StreamParser({
            events: this.events,
            streamState: this.streamState,
            genesisDay: (await this.streamState.findOne({
                id: "last_hb"
            }) || {val: networks[this.self.config.get('network.id')].genesisDay}).val
        })
        
        try {
            await this.events.createIndex({
                id: -1,
                key: -1
            }, {
                unique: true
            })
        } catch {

        }
        try {
            await this.events.createIndex({
                key: -1
            })
        } catch {

        }
        this.streamParser.addFilter({
            func: this.defaultFilter
        })
        this.streamParser.addParser({
            name: "chain-bridge",
            type: 'tx',
            priority: "before",
            func: this.blockParser
        })
    }

    async start() {
        await this.streamParser.init()
        await this.streamParser.start()
        // const witnesses = await this.self.chainBridge.getWitnessesAtBlock(78_000_000)
        // console.log('witnesses at time', witnesses.map(e => e.account))
        
        let blkNum
        setInterval(async() => {
            const diff = (blkNum - this.streamParser.stream.blockLag) || 0
            blkNum = this.streamParser.stream.blockLag

            const stateHeader = await this.streamState.findOne({
                id: 'last_hb_processed'
            })
            this.self.logger.info(`blockLag blockLag=${this.blockLag} streamRate=${Math.round(diff / 15)} parseLag=${this.streamParser.stream.calcHeight - stateHeader.val}`)
        }, 15_000)

        const lastLags: {
            parseLag: number;
            blockLag: number;
        }[] = [];
        const updateLastLags = () => {
            lastLags.push({
                parseLag: this.parseLag,
                blockLag: this.blockLag,
            })
            if (lastLags.length > 5) {
                lastLags.shift()
            }
        }
        const exitIfStuck = () => {
            const oldest = lastLags[0];
            const newest = lastLags[4];

            if (newest.parseLag < 40) {
                return;
            }

            if (oldest.parseLag === newest.parseLag) {
                process.exit(0);
            }

            if (newest.parseLag - newest.blockLag < 40) {
                return;
            }

            if (newest.parseLag > oldest.parseLag) {
                process.exit(0);
            }
        }
        setInterval(() => {
            updateLastLags();
            if (lastLags.length === 5) {
                exitIfStuck();
            }
        }, 60_000)
    }
}