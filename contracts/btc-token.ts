import _ from '../src/environment'



class BigDecimal {
    bigint: bigint;
    static decimals: number;
    constructor(value) {
        let [ints, decis] = String(value).split(".").concat("");
        decis = decis.padEnd(BigDecimal.decimals, "0");
        this.bigint = BigInt(ints + decis);
    }
    static fromBigInt(bigint) {
        return Object.assign(Object.create(BigDecimal.prototype), { bigint });
    }
    divide(divisor) { // You would need to provide methods for other operations
        return BigDecimal.fromBigInt(this.bigint * BigInt("1" + "0".repeat(BigDecimal.decimals)) / divisor.bigint);
    }
    toString() {
        const s = this.bigint.toString().padStart(BigDecimal.decimals+1, "0");
        return s.slice(0, -BigDecimal.decimals) + "." + s.slice(-BigDecimal.decimals)
                //.replace(/\.?0+$/, "");
    }
}
BigDecimal.decimals = 10; // Configuration of the number of decimals you want to have.


const BTCCR_CONTRACT = 'd03a60d82f820bd2fc3bdaf9882a4cbf70eaafe0'

interface Transfer {
    
    dest: string
    
    asset_type: "TOKEN:WBTC"
    
    memo?: string
    
    inputs: Array<{
        id: string
        amount: number
        hash_lock?: string
    }>
}

interface Mint {
    dest: string

    asset_type: "TOKEN:WBTC"

    memo?: string

    amoount: number
}

interface LedgerOutput {
    

    balance: number
    obalance: number //Original balance

    asset_type: string

    memo?: string

    address: string
    controllers?: Array<{
        type: "DID"
        authority: string
    }>

    outputs: Array<{
        id: string
        amount: number
        type?: 'MINT' | 'REDEEM'
    }>

    //Immutable
    inputs: Array<{
        id: string
        amount: number
        type?: 'MINT' | 'REDEEM'
    }>

    created_lock: {
        block_ref: string
    }
}

interface HtlcTransfer {
    blockLock: number
    hashLock: string
    receiver: string
    memo?: string 
    inputs: Array<{
        id: string
        amount: number
    }>
}

function verifyLock(controller, params?:{hashLockImage?: string}): boolean {
    if(typeof controller.lock === 'object') {
        if(controller.lock.type === 'time') {
            if(controller.lock.value < api.input.included_block && api.input.sender.id === controller.authority) {
                return true;
            } else {
                return false;
            }
        } else if (controller.lock.type === 'hash') {
            if(!params?.hashLockImage) {
                return false;
            }
            if(utils.SHA256(params?.hashLockImage) === controller.lock.value && api.input.sender.id === controller.authority) {
                return true;
            } else {
                return false;
            }
        }
    }
    if(controller.authority == api.input.sender.id) {
        return true;
    }
    return false;
}

actions.applyHtlc = async (tx: HtlcTransfer) => {
    const supposedController = [
        //Redeem
        {
            type: 'DID',
            authority: api.input.sender.id,
            lock: {
                type: 'time',
                // value: api.input.included_block + 300
                value: tx.blockLock
            }
        },
        //Receiver
        {
            type: 'DID',
            authority: (tx as any).receiver,
            lock: {
                type: 'hash',
                value: (tx as any).hashLock
            }
        }
    ]
    const address = utils.SHA256(JSON.stringify(supposedController))

    let modifyOuts:Array<[string, LedgerOutput, number]> = []
    let totalRefBal = 0;
    for(let input of tx.inputs) {
        const out = await state.pull<LedgerOutput>(`outputs/${input.id}`)
        if(out.balance >= input.amount) {
            //OK
            const compareAddr = [{
                type: 'DID',
                authority: api.input.sender.id,
            }]
            if(out.address === utils.SHA256(JSON.stringify(compareAddr))) {
                totalRefBal = totalRefBal + input.amount
                out['balance'] = out['balance'] - input.amount
                modifyOuts.push([input.id, out, input.amount])
                continue;
            } else {
                return;
            }
        } else {
            return;
        }
    }
    //At this point operation has been validated
    
    const output: LedgerOutput = {
        address,
        controllers: supposedController as any,

        balance: totalRefBal,
        obalance: totalRefBal,
        asset_type: "TOKEN:WBTC",
        memo: tx.memo,

        outputs: [],
        inputs: tx.inputs,

        created_lock: {
            block_ref: api.input.included_in
        }
    }

    const outputId = utils.SHA256(JSON.stringify(output))

    for(let [id, val, debitAmount] of modifyOuts) {
        val.outputs.push({
            id: outputId,
            amount: debitAmount
        })
        await state.update(`outputs/${id}`, val)
    } 


    //New output
    await state.update(`outputs/${outputId}`, output)
}

actions.applyTx = async (tx: Transfer) => {


    const supposedController = [
        {
            type: 'DID',
            authority: api.input.sender.id
        }
    ]
    const address = utils.SHA256(JSON.stringify(supposedController))

    let modifyOuts:Array<[string, LedgerOutput, number]> = []
    let totalRefBal = 0;
    for(let input of tx.inputs) {
        const out = await state.pull<LedgerOutput>(`outputs/${input.id}`)
        if(out.balance >= input.amount) {
            //OK
            if(!out.controllers) {
                if(out.address === address) {
                    totalRefBal = totalRefBal + input.amount
                    out['balance'] = out['balance'] - input.amount
                    modifyOuts.push([input.id, out, input.amount])
                    continue;
                } else {
                    return;
                }
            } else {
                let cleared = false;
                for(let controller of out.controllers) {
                    if(verifyLock(controller, {
                        hashLockImage: input.hash_lock
                    })) {
                        cleared = true;
                        break;
                    }
                }
                if(!cleared) {
                    return
                }
                totalRefBal = totalRefBal + input.amount
                out['balance'] = out['balance'] - input.amount
                modifyOuts.push([input.id, out, input.amount])
            }
        } else {
            return;
        }
    }
    //At this point operation has been validated
    
    const output: LedgerOutput = {
        address: tx.dest,

        balance: totalRefBal,
        obalance: totalRefBal,
        asset_type: "TOKEN:WBTC",
        memo: tx.memo,

        outputs: [],
        inputs: tx.inputs,

        created_lock: {
            block_ref: api.input.included_in
        }
    }

    const outputId = utils.SHA256(JSON.stringify(output))

    for(let [id, val, debitAmount] of modifyOuts) {
        val.outputs.push({
            id: outputId,
            amount: debitAmount
        })
        await state.update(`outputs/${id}`, val)
    } 


    //New output
    await state.update(`outputs/${outputId}`, output)
}

actions.mint = async (tx: {tx_id: string}) => {

    const relayState = await state.remoteState(BTCCR_CONTRACT)

    const verifiedTx = await relayState.pull(`txs/${tx.tx_id}`)

    
    if(verifiedTx) {
        const btcOutput = utils.bitcoin.BTCUtils.extractOutputAtIndex(utils.bitcoin.SPVUtils.deserializeHex((verifiedTx as any).vout), 0)
        const val = utils.bitcoin.BTCUtils.extractValue(btcOutput)

        var a = new BigDecimal(val.toString());
        var b = new BigDecimal("100000000");
    
        const amount = Number(a.divide(b).toString());

        const controllers = [
            {
                type: "DID",
                authority: api.input.sender.id as string
            }
        ]
        
        const output:LedgerOutput = {
            address: utils.SHA256(JSON.stringify(controllers)),
            controllers: controllers as any,
    
            balance: amount,
            obalance: amount,
    
            inputs: [{
                id: tx.tx_id,
                amount: amount,
                type: 'MINT'
            }],
            outputs: [],
    
            asset_type: "TOKEN:WBTC",
    
            created_lock: {
                block_ref: api.input.included_in
            }
        }
    
        const outputId = utils.SHA256(JSON.stringify(output))
    
        await state.update<LedgerOutput>(`outputs/${outputId}`, output)
    }
}