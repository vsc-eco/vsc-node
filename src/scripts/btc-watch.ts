import Axios from 'axios'
import { sleep } from "../utils"

import {Collection, Db, MongoClient} from 'mongodb'
import { utils, BTCUtils, ser, ValidateSPV } from '@summa-tx/bitcoin-spv-js'
import {Long} from 'mongodb'
import { BTCBlockStream, parseTxHex, reverse, rpcBitcoinCall } from "../services/bitcoin-utils"
import hash256 from './vendor/hash256'
import * as merkle from './vendor/merkle'
import assert from './vendor/bsert'
import { CoreService } from '../services'
import { TransactionPoolService } from '../services/transactionPool'
import { CID } from 'kubo-rpc-client'
import { waitTxConfirm } from './utils'



async function getMerkleProof(txid, height) {
    let blockhash
    if(typeof height === 'number') {
        blockhash = (await rpcBitcoinCall('getblockhash', [height])).result;
    } else {
        blockhash = height
    }
    const block = (await rpcBitcoinCall('getblock', [blockhash])).result;
    
      // console.log('hHELLO')
    console.log(block)
    let index = -1;
    const txs = [];
    for (const [i, tx] of Object.entries(block.tx) as any) {
      if (tx === txid) { index = i >>> 0; } // cast to uint from string
      txs.push(Buffer.from(tx, 'hex').reverse());
    }

    assert(index >= 0, 'Transaction not in block.');

    const [root] = merkle.createRoot(hash256, txs.slice());
    // assert.bufferEqual(Buffer.from(block.merkleroot, 'hex').reverse(), root);

    
    const branch = merkle.createBranch(hash256, index, txs.slice());
    // console.log('root', root, branch)

    const proof = [];
    for (const hash of branch) { proof.push(hash.toString('hex')); }

    return [proof, index];
  }


async function createProof(tx_id: string) {
    const dataTx = (await rpcBitcoinCall('getrawtransaction', [tx_id, 1])).result
    // const blockHeader = 
    const merkleProof = await getMerkleProof(tx_id, dataTx.blockhash)
    const vinProf = parseTxHex(dataTx.hex)
    // console.log(merkleProof)
    // console.log(dataTx, vinProf)
    const blockHeader = (await rpcBitcoinCall('getblockheader', [dataTx.blockhash])).result
    const blockHeaderRaw = (await rpcBitcoinCall('getblockheader', [dataTx.blockhash, false])).result
    // console.log((merkleProof[0] as any).length, (merkleProof[0] as any).reduce((a, b) => a + b))
    
    console.log(merkleProof)
    const fullProof ={
        ...vinProf,
        intermediate_nodes: (merkleProof[0] as any).length > 2 ? (merkleProof[0] as any).reduce((a, b) => a + b) : '',
        index: merkleProof[1],
        tx_id: reverse(tx_id),
        confirming_header: {
            raw: blockHeaderRaw,
            hash: reverse(blockHeader.hash),
            height: typeof blockHeader.height === 'number' ? blockHeader.height : blockHeader.height,
            prevhash: reverse(blockHeader.previousblockhash),
            merkle_root: reverse(blockHeader.merkleroot),
        },
        confirming_height: blockHeader.height
    }
    console.log('fullProof', fullProof)

    try {
        let validProof = ValidateSPV.validateProof(ser.deserializeSPVProof(JSON.stringify(fullProof)))
        console.log('validProof', validProof, fullProof)
    } catch (ex) {
        console.log(ex)
    }
    return {
        ...vinProf,
        intermediate_nodes: (merkleProof[0] as any).length > 2 ? (merkleProof[0] as any).reduce((a, b) => a + b) : '',
        index: merkleProof[1],
        tx_id: reverse(tx_id),
        confirming_height: blockHeader.height
    };
}

void(async () => {

    const mint_contract = '4026eb79dd55cd663dc6afb219dff47ff3058613'
    const relay_contract = '42fe0195bb2fe0afe7e015871d8c5749d07177cc'

    const core = new CoreService({
        prefix: 'manual tx core',
        printMetadata: true,
        level: 'debug',
        mode: 'lite'
    })

    await core.start()

    const transactionPool = new TransactionPoolService(core)

    await transactionPool.start()


    let btcAddr = '1NU1q7ZdfhSzm5F1ocC7R2veKGSu8aeZEb'
    for( ; ; ) {
        const {state_merkle:mint_state} = await core.contractEngine.contractDb.findOne({
            id: mint_contract
        })

        
        const {state_merkle:relay_state} = await core.contractEngine.contractDb.findOne({
            id: relay_contract
        })
        let links = []
        try {
            const val = (await core.ipfs.dag.resolve(CID.parse(mint_state), {
                path: 'wraps'
            }))
            console.log(val, (await core.ipfs.dag.get(val.cid)).value.Links)
            links = (await core.ipfs.dag.get(val.cid)).value.Links
        } catch {

        }

        let relayedBlock;
        try {
            const dag = (await core.ipfs.dag.resolve(CID.parse(relay_state), {
                path: 'pre-headers/main'
            }))
            
            relayedBlock = Object.entries((await core.ipfs.dag.get(dag.cid)).value).map((e) => {
                return (e[1] as any).height 
            }).sort((a, b) => {
                return a - b;
            })[0] || 0
            console.log('topBlock', relayedBlock)
        } catch (ex) {
            console.log(ex)
            relayedBlock = 0;
        }

        const dataTx = (await rpcBitcoinCall('getrawtransaction', ['556e0615aae5abcf207a98a7de2969e63f9d3610fa69388bf5fc5d5da211a285', 1])).result
        console.log('dataTx', dataTx)

        try {

            const transactions = (await Axios.get(`https://chain.api.btc.com/v3/address/${btcAddr}/tx`)).data.data?.list
            console.log(transactions)
            
            let tx_id;
            for(let tx of transactions) {
                const dataTx = (await rpcBitcoinCall('getrawtransaction', [tx.hash, 1])).result
                console.log('dataTx', dataTx)
                // if(dataTx) {
                //     return
                // }
                // console.log(links.map(e => e.Name), tx.hash, !links.map(e => e.Name).includes(tx.hash), relayedBlock, (tx.block_height + 4))
                // console.log(!links.map(e => e.Name).includes(tx.hash), (relayedBlock > (tx.block_height + 4)))
                if(!links.map(e => e.Name).includes(tx.hash) && (relayedBlock > (tx.block_height + 4))) {
                    tx_id = tx.hash
                    break;
                }
            }

            if(tx_id) {
                const proof = await createProof(tx_id)
        
        
                const result = await transactionPool.callContract(mint_contract, {
                    action: 'mint',
                    payload: {
                        proof
                    }
                });
                const date = new Date();
                await waitTxConfirm(result.id, core, (state) => {
                    if(state === "INCLUDED") {
                        console.log('Included after', new Date().getTime() - date.getTime(), 's')
                    }
                })
                console.log('Confirmed after', new Date().getTime() - date.getTime(), 's')
            }
        } catch(ex) {
            console.log(ex)
        }
        await sleep(30_000)
    }
})()