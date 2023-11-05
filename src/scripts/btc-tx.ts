import {Collection, Db, MongoClient} from 'mongodb'
import { utils, BTCUtils, ser, ValidateSPV } from '@summa-tx/bitcoin-spv-js'
import {Long} from 'mongodb'
import { BTCBlockStream, parseTxHex, reverse, rpcBitcoinCall } from "./bitcoin-wrapper/utils"
import hash256 from './vendor/hash256'
import * as merkle from './vendor/merkle'
import assert from './vendor/bsert'
import { CoreService } from '../services'
import { TransactionPoolService } from '../services/transactionPool'


interface txProof {
    version: string
    vin: string
    vout: string
    locktime: string
    intermediate_nodes: string
    index: number
    tx_id: string
    confirming_height: number
}

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


void (async () => {
    const BHRaw = '00e0ff3fe95b44d10837636fe41b8ff98763cb267a3715f8abfa00000000000000000000db55a3ff3c1d10e2d855a8122fcc582bbadb01ea876fa5c7a6bbafa8d8c1d3d47590a864be8e051779c14481'

    const decodeHex = new Uint8Array(Buffer.from(BHRaw, 'hex'))
    const prevBlock = Buffer.from(BTCUtils.extractPrevBlockLE(decodeHex)).toString('hex')
    // const timestamp = utils.bitcoin.BTCUtils.extractTimestampLE(decodeHex)
    const merkleRoot = Buffer.from(BTCUtils.extractMerkleRootLE(decodeHex)).toString('hex')
    // console.log(timestamp.toString())
    const headerHash = Buffer.from(BTCUtils.hash256(decodeHex)).toString('hex');

    const confirming_header = {
        raw: BHRaw,
        hash: headerHash,
        height: 797674,
        prevhash: prevBlock,
        merkle_root: merkleRoot,
    }

    // console.log(confirming_header)
    const proof = await createProof('28d488ad2dbc188e36d51ccf6c7645cd52d98fef01f9940cfbf90cd86c5c4ba6')

    // console.log('calc proof', {
    //     ...proof,
    //     confirming_header
    // })
    // let validProof = ValidateSPV.validateProof(ser.deserializeSPVProof(JSON.stringify({
    //     ...proof,
    //     confirming_header
    // })))


    // console.log(validProof)

    // await sleep(15_000)

    // if(validProof) {
    //     process.exit()
    // } else {
    //     process.exit()

    // }

    const contract_id = '67c2a0d19e8a271da0b90d9b6c45a72d91185661'

    const core = new CoreService({
        prefix: 'manual tx core',
        printMetadata: true,
        level: 'debug',
        mode: 'lite'
    })

    await core.start()

    const transactionPool = new TransactionPoolService(core)

    await transactionPool.start()

    const result = await transactionPool.callContract(contract_id, {
        action: 'mint',
        payload: {
            proof
        }
    });
    core.logger.debug('result of contract invokation' , result)
})()