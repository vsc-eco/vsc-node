import { utils, BTCUtils, ser, ValidateSPV } from '@summa-tx/bitcoin-spv-js'
import {CID} from 'kubo-rpc-client'
import { CoreService } from '../services';
import { TransactionPoolService } from '../services/transactionPool';
import { sleep } from '../utils';
import Axios from 'axios'
import { waitTxConfirm } from './utils';
import { globalConfig } from './config';




void (async () => {

    const mint_contract = globalConfig.btcTokenContract

    const core = new CoreService({
        prefix: 'manual tx core',
        printMetadata: true,
        level: 'debug',
        mode: 'lite'
    })

    await core.start()

    const transactionPool = new TransactionPoolService(core)

    const ipfs = core.ipfs

    await transactionPool.start()

    const {state_merkle:mint_state} = await core.contractEngine.contractDb.findOne({
        id: mint_contract
    })

   
    console.log(mint_state)
    let links = []
    try {
        const val = (await ipfs.dag.resolve(CID.parse(mint_state), {
            path: 'outputs'
        }))
        console.log(val)
        console.log(val, (await ipfs.dag.get(val.cid)).value.Links)
        links = (await ipfs.dag.get(val.cid)).value.Links
    } catch(ex) {
        console.log(ex)
    }

    let [dest, amount] = process.argv.slice(process.argv.length - 2) as any

    amount = Number(amount)


    if(typeof amount !== 'number') {
        console.log('Amount must be number: script.ts <dest> <amount>')
        process.exit()
    }

    if(!dest.startsWith('did:')) {
        console.log('Dest must be a DID: script.ts <dest> <amount>')
        process.exit()
    }

    let inputs = [];
    let remainingAmount = amount;
    for(let out of links) {
        let outContent = (await ipfs.dag.get(out.Hash)).value

        let amt;
        if(outContent.balance >= remainingAmount) {
            console.log('case 1')
            amt = remainingAmount
        } else if(outContent.balance < remainingAmount) {
            console.log('case 2')
            amt = outContent.balance
        }
        remainingAmount = remainingAmount - amt;
        console.log('amt', amt, outContent.balance, remainingAmount, outContent, out.Name)
        
        inputs.push({
            id: out.Name,
            amount: amt
        })

        if(remainingAmount === 0) {
            break;
        }
    }

    console.log(remainingAmount, inputs)
    if(remainingAmount !== 0) {
        console.log('Not enough balance! Cannot execute transaction')
        process.exit()
    }

    let TransferOp = {
        dest: dest,
        asset_type: 'TOKEN:WBTC',
        inputs
    }

    console.log(TransferOp.inputs.map(e => e.amount).reduce((a, b, c) => {

        return a + b;
    }))

    const result = await transactionPool.callContract(mint_contract, {
        action: 'applyTx',
        payload: TransferOp
    });
    const date = new Date();
    await waitTxConfirm(result.id, core, (state) => {
        if(state === "INCLUDED") {
            console.log('Included after', new Date().getTime() - date.getTime(), 's')
        }
    })
    console.log('Confirmed after', new Date().getTime() - date.getTime(), 's')


})()