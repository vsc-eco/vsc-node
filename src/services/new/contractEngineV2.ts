import { Collection } from "mongodb";
import { NewCoreService } from ".";
import { AddrRecord, TransactionContainerV2, TransactionDbRecordV2 } from "./types";
import { encodePayload } from 'dag-jose-utils'
import { bech32 } from "bech32";
import { VmContainer } from "./vm/utils";
import { CID } from "kubo-rpc-client";
import { ParserFuncArgs } from "./utils/streamUtils";
import { BlsCircuit } from "./utils/crypto/bls-did";
import {z} from 'zod'


enum ContractErrors {
    success = 0,
    invalid_action = -1,
    runtime_error = -2
}

interface ContractInfo {
    id: string
    code: string
    name: string
    description:string
    creator: string
    owner: string | null
    state_merkle: string
}

interface ContractVersion {
    id: string
    code: string
    //Valid block height
    height: number
    index: number
    
    ref_id: string
}

/**
 * WASM VM runner context
 */
export class VmContext {
    engine: ContractEngineV2;
    outputStacks: Record<string, Array<any>>
    outputState: Record<string, string>
    contractCache: Map<string, ContractInfo>
    args: { 
        contractList: Array<string>; 
        injectedContracts?: Record<string, {
            code: string,
            state_merkle?: string
        }>
    };
    vm: VmContainer;
    constructor(engine: ContractEngineV2, args: {
        contractList: Array<string>
        injectedContracts?: Record<string, {
            code: string,
            state_merkle?: string
        }>
    }) {
        this.engine = engine
        this.args = args;

        this.outputStacks = {}
        this.outputState = {}
    }

    async init() {
        let args = {
            debug: true,
            state: {

            },
            modules: {

            },
            timeout: 5_000
        }
        for(let contractId of this.args.contractList) {
            const contractRecord = await this.engine.contractDb.findOne({id: contractId})
            if (!contractRecord) {
                console.log(`warning: ignoring contract does not exist with id: ${contractId}`);
                if(this.args.injectedContracts) { 
                    if(this.args.injectedContracts[contractId]) {
                        args.state[contractId] = this.args.injectedContracts[contractId].state_merkle
                        args.modules[contractId] = this.args.injectedContracts[contractId].code
                    }
                }
                continue
            }
            const contractOuput = await this.engine.contractOutputs.findOne({ 
                contract_id: contractId
            }, {
                sort: {
                    anchored_height: -1
                }
            })
            
            args.modules[contractId] = contractRecord.code
            args.state[contractId] = contractOuput ? contractOuput.state_merkle : contractRecord.state_merkle
        }
        this.vm = new VmContainer(args)

        console.log('vm init')
        await this.vm.init()
        console.log('vm readying')
        await this.vm.onReady()
    }

    async processTx(tx: TransactionDbRecordV2, balanceMap?: Record<string, {HBD: number, HIVE: number}>) {
        const contract_id = (tx.data as any).contract_id;
        if(!this.args.contractList.includes(contract_id)) {
            throw new Error(`Contract ID "${contract_id}" not registered with VmContext`)
        }
        

        const blockHeader = await this.engine.self.chainBridge.blockHeaders.findOne(tx.anchored_id ? {
            id: tx.anchored_id
        } : {
            slot_height: {$lte: tx.anchored_height}
        }, tx.anchored_id ? {} : {
            sort: {
                slot_height: -1
            }
        })

        if (!blockHeader) {
            throw new Error(`could not find block header for ${JSON.stringify({
                anchored_id: tx.anchored_id,
                anchored_height: tx.anchored_height,
            }, null, 2)}`)
        }

        const requiredAuths = tx.required_auths.map(e => typeof e === 'string' ? e : e.value).map(e => {
            if(tx.src === 'hive') {
                //Format should be human readable
                return `hive:${e}`
            } else {
                //i.e did:key:123etcetc
                return e
            }
        })

       const callOutput = await this.vm.call({
            contract_id,
            action: tx.data.action,
            payload: JSON.stringify(tx.data.payload),
            intents: tx.headers.intents,
            balance_map: balanceMap || {},

            env: {
                'anchor.id': blockHeader.id,
                'anchor.height': tx.anchored_height || blockHeader.slot_height,
                'anchor.block': tx.anchored_block || `hive:${tx.id}`,
                'anchor.timestamp': blockHeader.ts.getTime(),


                'msg.sender': requiredAuths[0],
                //Retain the type info as well.
                //TODO: properly parse and provide authority type to contract
                //Such as ACTIVE vs POSTING auth
                'msg.required_auths': requiredAuths,
                'tx.origin': requiredAuths[0],
            }
        })

        return callOutput
    }

    async directExecute(tx: TransactionDbRecordV2, directArgs: {

        balanceMap: Record<string, {
            HBD: number,
            HIVE: number
        }>
    }) {
        const contract_id = (tx.data as any).contract_id;
        if(!this.args.contractList.includes(contract_id)) {
            throw new Error(`Contract ID "${contract_id}" not registered with VmContext`)
        }
        

        const blockHeader = await this.engine.self.chainBridge.blockHeaders.findOne(tx.anchored_id ? {
            id: tx.anchored_id
        } : {
            slot_height: {$lte: tx.anchored_height}
        }, tx.anchored_id ? {} : {
            sort: {
                slot_height: -1
            }
        })

        if (!blockHeader) {
            throw new Error(`could not find block header for ${JSON.stringify({
                anchored_id: tx.anchored_id,
                anchored_height: tx.anchored_height,
            }, null, 2)}`)
        }

        const requiredAuths = tx.required_auths.map(e => typeof e === 'string' ? e : e.value).map(e => {
            if(tx.src === 'hive') {
                //Format should be human readable
                return `hive:${e}`
            } else {
                //i.e did:key:123etcetc
                return e
            }
        })

       const callOutput = await this.vm.call({
            contract_id,
            action: tx.data.action,
            payload: JSON.stringify(tx.data.payload),
            intents: tx.headers.intents,

            balance_map: directArgs.balanceMap,
            env: {
                'anchor.id': blockHeader.id,
                'anchor.height': tx.anchored_height || blockHeader.slot_height,
                'anchor.block': tx.anchored_block || `hive:${tx.id}`,
                'anchor.timestamp': blockHeader.ts.getTime(),


                'msg.sender': requiredAuths[0],
                //Retain the type info as well.
                //TODO: properly parse and provide authority type to contract
                //Such as ACTIVE vs POSTING auth
                'msg.required_auths': requiredAuths,
                'tx.origin': requiredAuths[0],
            }
        })

        return callOutput
    }
    
    async finish() {
        let outputs: {contract_id: string, stateMerkle: string}[] = []
        for await(let output of this.vm.finishIterator()) {
            outputs.push(output)
        }
        return outputs;
    }
}

const CONTRACT_DATA_AVAILABLITY_PROOF_REQUIRED_HEIGHT =  84162592;

export class ContractEngineV2 {
    self: NewCoreService;
    addrsDb: Collection<AddrRecord>;
    contractDb: Collection<ContractInfo>;
    contractVersionDb: Collection<ContractVersion>;
    contractOutputs: Collection<{
        id: string
        anchored_block: string
        anchored_id: string
        anchored_index: number
        contract_id: string

        state_merkle: string
    }>
    constructor(self: NewCoreService) {
        this.self = self;

        
        this.blockParser = this.blockParser.bind(this)
    }
    
    protected async blockParser(args: ParserFuncArgs<'tx'>) {
        const {tx, blkHeight} = args.data

        const proofRequired = blkHeight >= CONTRACT_DATA_AVAILABLITY_PROOF_REQUIRED_HEIGHT

        let members: string[] | undefined = undefined

        for(let index in tx.operations) {
            const [opName, op] = tx.operations[index]
            // console.log('OPPDATA', tx.operations[index])
            if(opName === "custom_json") {
                const json = JSON.parse(op.json)
                
    
                console.log('OPPAYLOAD DATA INSERT', op, opName)
                if(op.id === "vsc.create_contract") {
                    if (proofRequired) {
                        // validate proof
                        if (
                            typeof json !== 'object' ||
                            json === null ||
                            typeof json.storage_proof !== 'object' ||
                            typeof json.storage_proof?.hash !== 'string' ||
                            typeof json.storage_proof?.signature !== 'object' ||
                            typeof json.storage_proof?.signature?.sig !=='string' ||
                            typeof json.storage_proof?.signature?.bv !=='string' ||
                            typeof json.code !== 'string'
                        ) {
                            continue;
                        }
                        try {
                            const sigCid = CID.parse(json.storage_proof.hash)
                            members ??= (await this.self.electionManager.getMembersOfBlock(blkHeight))
                                .map((m) => m.key);
                            const isValid = await BlsCircuit.deserialize({hash: sigCid.bytes, signature: json.storage_proof.signature}, members)
                                                            .verify(sigCid.bytes);
                            if (!isValid) {
                                this.self.logger.info(
                                `contract storage proof is invalid for op ${index} tx ${tx.transaction_id}`,
                                )
                                continue
                            }
                            const {value} = await this.self.ipfs.dag.get(
                                sigCid
                            );
                            if (value?.type !== 'data-availability' || value?.cid !== json.code) {
                                this.self.logger.info(
                                    `contract storage proof data is invalid for op ${index} tx ${tx.transaction_id}`,
                                )
                                continue;
                            }
                            await this.self.ipfs.pin.add(sigCid);
                        } catch (e) {
                            this.self.logger.error(`failed to verify contract storage proof for op ${index} tx ${tx.transaction_id}: ${e}`)
                            continue;
                        }
                    }

                    const start = Date.now()
                    console.log('pinning contract CID', json.code);
                    await this.self.ipfs.pin.add(json.code)
                    console.log('finished pinning contract CID', json.code, Date.now() - start)

                    const contractIdHash = (await encodePayload({
                        ref_id: tx.transaction_id,
                        index //Note index in TX
                    })).cid
        
                    const bech32Addr = bech32.encode('vs4', bech32.toWords(contractIdHash.bytes));
        
                    console.log('smart contract addr', bech32Addr)
                    await this.contractDb.findOneAndUpdate({
                        id: bech32Addr
                    }, {
                        $set: {
                            code: json.code,
                            name: json.name,
                            description: json.description,
                            creator: op.required_auths[0],
                            //Default to null owner IF not available
                            //Aka immutable
                            owner: json.owner ? json.owner : null,
                            state_merkle: (await this.self.ipfs.object.new({ template: 'unixfs-dir' })).toString(),
                            ref_id: tx.transaction_id,
                            created_height: blkHeight
                        }
                    }, {
                        upsert: true
                    })

                    //First version
                    await this.contractVersionDb.findOneAndUpdate({ 
                        id: bech32Addr,
                        height: blkHeight,
                    }, {
                        $set: {
                            code: json.code,
                            ref_id: tx.transaction_id
                        }
                    }, {
                        upsert: true
                    })
                } else if(op.id === 'vsc.update_contract') {

                    
                    // validate proof
                    if (
                        typeof json.storage_proof?.hash !== 'string' ||
                        typeof json.storage_proof?.signature !== 'object' ||
                        typeof json.storage_proof?.signature?.sig !=='string' ||
                        typeof json.storage_proof?.signature?.bv !=='string'
                    ) {
                        continue;
                    }
                    try {
                        //Can't pull from this.
                        const cid = CID.parse(json.storage_proof.hash)
                        const {value: msg} = await this.self.ipfs.dag.get(cid)
                        if (typeof msg?.cid !== 'string' || msg?.type !== 'data-availability') {
                            continue;
                        }
                        if (msg.cid !== json.code) {
                            continue;
                        }
                        members ??= (await this.self.electionManager.getMembersOfBlock(blkHeight))
                            .map((m) => m.key);
                        const isValid = await BlsCircuit.deserialize({hash: cid.bytes, signature: json.storage_proof.signature}, members)
                                                        .verify(cid.bytes);
                        if (!isValid) {
                            this.self.logger.info(
                            `contract storage proof is invalid for op ${index} tx ${tx.transaction_id}`,
                            )
                            continue
                        }
                    } catch (e) {
                        this.self.logger.error(`failed to verify contract storage proof for op ${index} tx ${tx.transaction_id}: ${e}`)
                        continue;
                    }

                    const jsonData = z.object({
                        id: z.string().min(1),
                        code: z.string().min(1),
                    }).passthrough().safeParse(json)

                    if(jsonData.success === false) { 
                        //Missing stuff
                        continue;
                    }

                    const contractInfo = await this.contractDb.findOne({
                        id: json.id
                    })

                    if(!contractInfo) {
                        this.self.logger.error(`contract creator does not match with the transaction sender`)
                        continue
                    }

                    //TODO: figure out modifying contract owners in the future
                    //Assume first required_auth is owner. (it shouldn't be anything else)
                    if(contractInfo.owner !== op.required_auths[0]) { 
                        this.self.logger.error(`contract creator does not match with the transaction sender`)
                        continue
                    }

                    await this.contractVersionDb.findOneAndUpdate({ 
                        id: json.id,
                        height: blkHeight,
                        //Index in block
                        index: Number(args.data.idx),
                        //Index of operate if multiple ops in index
                        opIndex: Number(index)
                    }, {
                        $set: {
                            code: json.code,
                            ref_id: tx.transaction_id
                        }
                    }, {
                        upsert: true
                    })
                }
            }
        }
    }
    
    vmContext(contractList: Array<string>) {
        return new VmContext(this, {
            contractList
        })
    }

    async init() {
        this.addrsDb = this.self.db.collection('addrs')
        this.contractDb = this.self.db.collection('contracts')
        this.contractOutputs = this.self.db.collection('contract_outputs')
        this.contractVersionDb = this.self.db.collection('contract_versions')
        this.self.chainBridge.streamParser.addParser({
            name: "contract-engine",
            type: 'tx',
            priority: 'before',
            func: this.blockParser
        })

        try {
            await this.contractVersionDb.createIndex({
                id: 1, 
                height: 1
            })
        } catch {

        }
    }

    async start() {
        
    }

}
