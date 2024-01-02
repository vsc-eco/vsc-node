import { Collection } from "mongodb";
import { NewCoreService } from ".";
import { AddrRecord } from "./types";
import { encodePayload } from 'dag-jose-utils'
import { bech32 } from "bech32";
import { VmContainer } from "./vm/utils";


enum ContractErrors {
    success = 0,
    invalid_action = -1,
    runtime_error = -2
}

export class ContractEngineV2 {
    self: NewCoreService;
    addrsDb: Collection<AddrRecord>;
    contractDb: Collection<{
        id: string
        code: string
        name: string
        description:string
        creator: string
    }>;
    
    constructor(self: NewCoreService) {
        this.self = self;

        
        this.blockTick = this.blockTick.bind(this)
    }
    
    async blockTick([opPayload, tx]) {
        console.log('opPayload, tx', opPayload, tx)
        for(let index in tx.operations) {
            const [opName, op] = tx.operations[index]
            const json = JSON.parse(op.json)
            
            console.log('OPPAYLOAD DATA INSERT', op, opName)
            if(op.id === "vsc.create_contract") {
                const contractIdHash = (await encodePayload({
                    ref_id: tx.transaction_id,
                    index
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
                        creator: opPayload.required_auths[0],
                        state_merkle: (await this.self.ipfs.object.new({ template: 'unixfs-dir' })).toString(),
                        ref_id: tx.transaction_id
                    }
                }, {
                    upsert: true
                })
            }
        }
    }
    
    async init() {
        this.addrsDb = this.self.db.collection('addrs')
        this.contractDb = this.self.db.collection('contracts')
        this.self.chainBridge.registerTickHandle('contract-engine', this.blockTick, {
            type: 'tx'
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
            state_merkle: (contractInfo as any).state_merkle,
            cid: contractInfo.code,
            contract_id: args.contract_id
        })

        await vm.init()
        await vm.onReady()

        const txResults = []

        for(let tx of args.txs) {
            const result = await vm.call({
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

    async start() {
        
    }

}