import { Collection } from "mongodb";
import { NewCoreService } from ".";
import { AddrRecord, TransactionContainerV2, TransactionDbRecordV2 } from "./types";
import { encodePayload } from 'dag-jose-utils'
import { bech32 } from "bech32";
import { VmContainer } from "./vm/utils";


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
}

/**
 * WASM VM runner context
 */
class VmContext {
    engine: ContractEngineV2;
    outputStacks: Record<string, Array<any>>
    outputState: Record<string, string>
    contractCache: Map<string, ContractInfo>
    args: { contractList: Array<string>; };
    vm: VmContainer;
    constructor(engine: ContractEngineV2, args: {
        contractList: Array<string>
    }) {
        this.engine = engine
        this.args = args;

        this.outputStacks = {}
        this.outputState = {}
    }

    async init() {
        let args = {
            state: {

            },
            modules: {

            }
        }
        for(let contractId of this.args.contractList) {
            const contractRecord = await this.engine.contractDb.findOne({id: contractId})
            console.log({id: contractId}, contractRecord)
            //Replace with proper state storage
            args.state[contractId] = (contractRecord as any).state_merkle
            args.modules[contractId] = contractRecord.code
        }
        this.vm = new VmContainer(args)

        await this.vm.init()
        await this.vm.onReady()
    }

    async processTx(tx: TransactionDbRecordV2) {
        const contract_id = (tx.data as any).contract_id;
        if(!this.args.contractList.includes(contract_id)) {
            throw new Error('Contract ID not registered with VmContext')
        }
        

       const callOutput = await this.vm.call({
            contract_id,
            action: tx.data.action,
            payload: JSON.stringify(tx.data.payload)
        })

        return callOutput
    }
    
    async finish() {
        let outputs = []
        for await(let output of this.vm.finishIterator()) {
            outputs.push(output)
        }
        return outputs;
    }
}

export class ContractEngineV2 {
    self: NewCoreService;
    addrsDb: Collection<AddrRecord>;
    contractDb: Collection<ContractInfo>;
    
    constructor(self: NewCoreService) {
        this.self = self;

        
        this.blockParser = this.blockParser.bind(this)
    }
    
    protected async blockParser(args) {
        const {tx} = args.data

        for(let index in tx.operations) {
            const [opName, op] = tx.operations[index]
            // console.log('OPPDATA', tx.operations[index])
            if(opName === "custom_json") {
                const json = JSON.parse(op.json)
                
    
                console.log('OPPAYLOAD DATA INSERT', op, opName)
                if(op.id === "vsc.create_contract") {
                    const contractIdHash = (await encodePayload({
                        ref_id: tx.transaction_id,
                        index //Note index in TX
                    })).cid
        
                    const bech32Addr = bech32.encode('vs4', bech32.toWords(contractIdHash.bytes));

                    console.log('pinning contract CID', json.code);
                    await this.self.ipfs.pin.add(json.code)
        
                    console.log('smart contract addr', bech32Addr)
                    await this.contractDb.findOneAndUpdate({
                        id: bech32Addr
                    }, {
                        $set: {
                            code: json.code,
                            name: json.name,
                            description: json.description,
                            creator: op.required_auths[0],
                            state_merkle: (await this.self.ipfs.object.new({ template: 'unixfs-dir' })).toString(),
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


    async createContractOutput(args: {
        txs: any
        contract_id: string
    }) {
        const contractInfo = await this.contractDb.findOne({
            id: args.contract_id
        })
        if(!contractInfo) {
            throw new Error('Contract not registered with node or does not exist')
        }


        if(args.txs.length === 0) {
            return null;
        }

        const vm = new VmContainer({
            // cid: contractInfo.code,
            // contract_id: args.contract_id
        } as any)

        await vm.init()
        await vm.onReady()

        const txResults = []

        for(let tx of args.txs) {
            const result = await vm.call({
                contract_id: args.contract_id,
                action: tx.data.action,
                payload: JSON.stringify(tx.data.payload)
            })

            
            let ret
            let code
            let msg
            if(result.ret) {
                const parsedResult: {
                    msg?: string
                    code: number
                    ret?: string
                } = JSON.parse((result as any).ret);
                ret = parsedResult.ret,
                code = parsedResult.code
                msg = parsedResult.msg
            }
            console.log('parsed result', result)
            txResults.push({
                ret: ret,
                code: code || result.errorType,
                logs: (result as any).logs,
                //Dont store gas usage if 0
                ...(result.IOGas > 0 ? {gas: result.IOGas} : {})
            })
        }
        const state_merkle = await vm.finishAndCleanup()
        console.log('finishing and cleaning up')
        
        const returnObj = {
            input_map: args.txs.map(e => e.id),
            state_merkle,
            results: txResults
        }

        console.log('returnObj', returnObj)

        return returnObj
    }

    async init() {
        this.addrsDb = this.self.db.collection('addrs')
        this.contractDb = this.self.db.collection('contracts')
        this.self.chainBridge.streamParser.addParser({
            name: "contract-engine",
            type: 'tx',
            priority: 'before',
            func: this.blockParser
        })
    }

    async start() {
        
    }

}