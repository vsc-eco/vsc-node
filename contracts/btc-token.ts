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



const CONFIG = {
    BTCCR_CONTRACT: '42fe0195bb2fe0afe7e015871d8c5749d07177cc',
    WP_PUB: '034240ccd025374e0531945a65661aedaac5fff1b2ae46197623e594e0129e8b13',
    DECIMAL_PLACES: "100000000",
    ACCEPTABLE_FEE: 1, //1% to cover exchange costs % 
    MAX_GAS_FEE: 16_000 //Maximum allowed gas fee for redeem transactions
}

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
        index?: number
        type?: 'MINT' | 'REDEEM'
    }>

    // created_lock: {
    //     block_ref: string
    // }
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

function compileScript(pubKey: string, addrKey: string) {
    return Buffer.from(`21${pubKey}ad20${addrKey}`)
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

        // created_lock: {
        //     block_ref: api.input.included_in
        // }
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
    // const supposedController = [
    //     {
    //         type: 'DID',
    //         authority: api.input.sender.id
    //     }
    // ]
    // const address = utils.SHA256(JSON.stringify(supposedController))

    let modifyOuts:Array<[string, LedgerOutput, number]> = []
    let totalRefBal = 0;
    for(let input of tx.inputs) {
        const out = await state.pull<LedgerOutput>(`outputs/${input.id}`)
        if(out.balance >= input.amount) {
            //OK
            if(!out.controllers) {
                if(out.address === api.input.sender.id) {
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

        // created_lock: {
        //     block_ref: api.input.included_in
        // }
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

actions.registerDeposit = async (args: {addr?: string}) => {
    const didAddr = args?.addr || api.input.sender.id; 
    const scriptCompiled = compileScript(CONFIG.WP_PUB, utils.SHA256(didAddr))
    const hash160 = utils.bitcoin.BTCUtils.hash160(scriptCompiled)
    console.log(hash160)
    
    const addr = new Uint8Array(21)
    addr.set([0x05])
    addr.set(hash160, 1)

    await state.update(`btc_addrs/${utils.base58.encode(addr)}`, {
        val: didAddr
    })
}

actions.redeem = async (tx: Transfer) => {
    let modifyOuts:Array<[string, LedgerOutput, number]> = []
    let totalRefBal = 0;
    for(let input of tx.inputs) {
        const out = await state.pull<LedgerOutput>(`outputs/${input.id}`)
        if(out.balance >= input.amount) {
            //OK
            if(!out.controllers) {
                if(out.address === api.input.sender.id) {
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
    
    const output: any = {
        status: 'pending',
        //BTC addresss
        WP_PUB: CONFIG.WP_PUB,
        address: tx.dest,

        balance: totalRefBal,
        rblance: 0,
        asset_type: "TOKEN:WBTC",

        inputs: tx.inputs,
    }

    const outputId = utils.SHA256(JSON.stringify(output) + api.input.included_in)

    for(let [id, val, debitAmount] of modifyOuts) {
        val.outputs.push({
            id: outputId,
            type: 'REDEEM',
            amount: debitAmount
        })
        await state.update(`outputs/${id}`, val)
    } 


    //New output
    await state.update(`redeems/${outputId}`, output)
}

actions.redeemProof = async (args) => {
    const relayState = await state.remoteState(CONFIG.BTCCR_CONTRACT)

    const {proof} = args
    const tx_id = utils.bitcoin.reverseBytes(proof.tx_id)

    const bundleHeaders = await relayState.pull(`headers/${calcKey(proof.confirming_height)}`) || {}

    const header = bundleHeaders[proof.confirming_height]


    const decodeHex = new Uint8Array(Buffer.from(header, 'hex'))
    const prevBlock = utils.bitcoin.SPVUtils.serializeHex(utils.bitcoin.BTCUtils.extractPrevBlockLE(decodeHex))
    // const timestamp = utils.bitcoin.BTCUtils.extractTimestampLE(decodeHex)
    const merkleRoot = utils.bitcoin.SPVUtils.serializeHex(utils.bitcoin.BTCUtils.extractMerkleRootLE(decodeHex))
    // console.log(timestamp.toString())
    const headerHash = utils.bitcoin.SPVUtils.serializeHex(utils.bitcoin.BTCUtils.hash256(decodeHex))

    const confirming_header = {
        raw: header,
        hash: headerHash,
        height: proof.confirming_height,
        prevhash: prevBlock,
        merkle_root: merkleRoot,
    }

    const fullProof = {
        ...proof,
        confirming_header
    }
    let validProof = utils.bitcoin.ValidateSPV.validateProof(utils.bitcoin.ser.deserializeSPVProof(JSON.stringify(fullProof)))

    if(validProof) {
        let txIndex = -2
        for( ; ; ) {
            try {
    
                txIndex = txIndex + 2
                const btcOutput0 = utils.bitcoin.BTCUtils.extractOutputAtIndex(utils.bitcoin.SPVUtils.deserializeHex((proof as any).vout),txIndex)
                const btcOutput1 = utils.bitcoin.BTCUtils.extractOutputAtIndex(utils.bitcoin.SPVUtils.deserializeHex((proof as any).vout),txIndex+1)
                const outHash = utils.bitcoin.BTCUtils.extractHash(btcOutput0)
                const val = utils.bitcoin.BTCUtils.extractValue(btcOutput0)
                const opReturnData = utils.bitcoin.BTCUtils.extractOpReturnData(btcOutput1)
            
                var a = new BigDecimal(val.toString());
                var b = new BigDecimal(CONFIG.DECIMAL_PLACES);
            
                const redeemedAmount = Number(a.divide(b).toString());
        
                console.log(redeemedAmount)
        
                const hex = utils.bitcoin.ser.serializeHex(opReturnData)
                log('out hex', hex)
                const redeem = await state.pull(`redeems/${hex}`) as any
                if(redeem) {
                    const hashBreak = utils.base58.decode(redeem.address)
                    if(redeem.status === "pending" && utils.base58.encode(outHash) === utils.base58.encode(hashBreak.slice(1))) {
                        redeem.status = 'complete'
                        redeem.tx_id = tx_id
                        redeem.out_index = txIndex
                        redeem.rbalance = redeem.rbalance + redeemedAmount
        
                        await state.update(`redeems/${hex}`, redeem)
                    }
                }
            } catch (ex) {
                log(ex)
                break
            }
        }
    }
}

function calcKey(height: number) {
    const cs = 100
    const keyA = Math.floor((height / cs)) * cs

    return `${keyA}-${keyA + cs}`
}

actions.mint = async (args: {
    proof:any
    destAddr?: string
}) => {
    const relayState = await state.remoteState(CONFIG.BTCCR_CONTRACT)

    const {proof} = args
    const tx_id = utils.bitcoin.reverseBytes(proof.tx_id)

    const bundleHeaders = await relayState.pull(`headers/${calcKey(proof.confirming_height)}`) || {}

    const header = bundleHeaders[proof.confirming_height]


    try {
        const decodeHex = new Uint8Array(Buffer.from(header, 'hex'))
        const prevBlock = utils.bitcoin.SPVUtils.serializeHex(utils.bitcoin.BTCUtils.extractPrevBlockLE(decodeHex))
        // const timestamp = utils.bitcoin.BTCUtils.extractTimestampLE(decodeHex)
        const merkleRoot = utils.bitcoin.SPVUtils.serializeHex(utils.bitcoin.BTCUtils.extractMerkleRootLE(decodeHex))
        // console.log(timestamp.toString())
        const headerHash = utils.bitcoin.SPVUtils.serializeHex(utils.bitcoin.BTCUtils.hash256(decodeHex))
    
        const confirming_header = {
            raw: header,
            hash: headerHash,
            height: proof.confirming_height,
            prevhash: prevBlock,
            merkle_root: merkleRoot,
        }
    
        const fullProof = {
            ...proof,
            confirming_header
        }
        
        let validProof = utils.bitcoin.ValidateSPV.validateProof(utils.bitcoin.ser.deserializeSPVProof(JSON.stringify(fullProof)))
    
        if(validProof && !(await state.pull<any>(`wraps/${tx_id}`))) {
            let txIndex = -1;
            for( ; ; ) {
                txIndex = txIndex + 1;
    
                try {
                    const btcOutput = utils.bitcoin.BTCUtils.extractOutputAtIndex(utils.bitcoin.SPVUtils.deserializeHex((proof as any).vout), txIndex)
                    const depHash = utils.bitcoin.BTCUtils.extractHash(btcOutput)

                    const addrHash = new Uint8Array(21)
                    addrHash.set([5])
                    addrHash.set(depHash, 1)

                    const record = await state.pull(`btc_addrs/${utils.base58.encode(addrHash)}`)
            
                    log('record is', record)
                    let destAddr;
                    if(record) {
                        destAddr = (record as any).val
                    } else if(args.destAddr) {
                        const key = utils.SHA256(args.destAddr)
                        const hash160 = utils.bitcoin.BTCUtils.hash160(compileScript(CONFIG.WP_PUB, key))
                        console.log(hash160)
                        if(utils.base58.encode(hash160) === utils.base58.encode(depHash)) {
                            destAddr = args.destAddr
                        } else {
                            continue;
                        }
                    } else {
                        const key = utils.SHA256(api.input.sender.id)
                        const hash160 = utils.bitcoin.BTCUtils.hash160(compileScript(CONFIG.WP_PUB, key))
                        console.log(hash160)
                        if(utils.base58.encode(hash160) === utils.base58.encode(depHash)) {
                            destAddr = args.destAddr
                        } else {
                            continue;
                        }
                    }
            
            
                    const val = utils.bitcoin.BTCUtils.extractValue(btcOutput)
                
                    var a = new BigDecimal(val.toString());
                    var b = new BigDecimal(CONFIG.DECIMAL_PLACES);
                
                    const amount = Number(a.divide(b).toString());
            
            
                    // const controllers = [
                    //     {
                    //         type: "DID",
                    //         authority: api.input.sender.id as string
                    //     }
                    // ]
                    
                    const output:LedgerOutput = {
                        address: destAddr,
                        // controllers: controllers as any,
                
                        balance: amount,
                        obalance: amount,
                
                        inputs: [{
                            id: tx_id,
                            amount: amount,
                            index: txIndex,
                            type: 'MINT'
                        }],
                        outputs: [],
                
                        asset_type: "TOKEN:WBTC",
                        
                    }
                
                    const outputId = utils.SHA256(JSON.stringify(output))
                
                    await state.update<LedgerOutput>(`outputs/${outputId}`, output)
                } catch(ex) {
                    log(ex)
                    break;
                }
            }
            await state.update<any>(`wraps/${tx_id}`, "1")
        }
    }catch (ex) {
        log(ex)
    }
}

