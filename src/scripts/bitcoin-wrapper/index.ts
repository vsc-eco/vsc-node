import {Collection, Db, MongoClient} from 'mongodb'
import { utils, BTCUtils, ser, ValidateSPV } from '@summa-tx/bitcoin-spv-js'
import {Long} from 'mongodb'
import { BTCBlockStream, parseTxHex, reverse, rpcBitcoinCall } from "./utils"
import hash256 from '../vendor/hash256'
import * as merkle from '../vendor/merkle'
import assert from '../vendor/bsert'

const constants = {
    bitcoin_validity_depth: 6, //1 hour
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

  async function getProof() {

}

export class BitcoinWrapper {
    db: Db
    blockHeaders: Collection
    preHeaders: Collection
    transactions: Collection
    preTransactions: Collection


    async activatePreheaders() {
        const topHeader =  await this.preHeaders.findOne({}, {sort: {
            totalDiff: -1
        }})

        // console.log(topHeader)
        let previousBlock;
        let blocksToPush = []
        let topDepth = 0;
        for( ; ; ) {

            const header = await this.preHeaders.findOne({
                hash: previousBlock || topHeader.previousblockhash
            })
            const insertedHeader = await this.blockHeaders.findOne({
                hash: topHeader.previousblockhash
            })
            if(header === null) {
                console.log('header', insertedHeader)
                if(insertedHeader === null) {
                    // console.log('breaking 75')
                    break;
                } else {
                    return;
                }
            }
            // console.log('previousBlockhash', header.previousblockhash)
            // console.log('depth', topDepth, constants.bitcoin_validity_depth)
            if(topDepth > constants.bitcoin_validity_depth - 1) {
                console.log('pushing header')
                blocksToPush.push(header)
            }
            topDepth = topDepth + 1;
            previousBlock = header.previousblockhash
        }
        console.log('blocksToPush', blocksToPush.length)
        if(blocksToPush.length > 0) {
            // console.log(`Processed ${blocksToPush.length} blocks`, {
            //     height: {
            //         $lt: blocksToPush[0].height,
            //         $gt: blocksToPush[blocksToPush.length - 1].height
            //     }
            // })
            await this.blockHeaders.insertMany(blocksToPush.map(e => {
                delete e._id
                return e;
            }))
            const blk = await this.preHeaders.deleteMany({
                height: {
                    $gte: blocksToPush[0].height,
                    $lte: blocksToPush[blocksToPush.length - 1].height
                }
            })
            console.log(blk)
        }
        

    }

    async replayBtc() {
        try {

            // await this.blockHeaders.deleteMany({})
            const topHeader = await this.blockHeaders.findOne({}, {sort: {height:-1}})
            console.log('topHeader.height', topHeader.height)
            let totalDiff = 0n
            for await(let [rawBH, blockHeader] of BTCBlockStream(topHeader?.height || 0)) {
                // console.log(blockHeader)
                console.log(blockHeader.height)
                const header = await this.blockHeaders.findOne({
                    height: blockHeader.height
                })
                // console.log(rawBH)
                if(!header) {
                    let diff = ValidateSPV.validateHeaderChain(new Uint8Array(Buffer.from(rawBH, 'hex')))
                    // console.log('totalDiff', totalDiff.toString())
                    // totalDiff = totalDiff + diff;
                    const dieCounter = (await this.preHeaders.findOne({}, {sort: {
                        height: -1,
                    }}) || {height: 0}).height  - (await this.preHeaders.findOne({}, {sort: {
                            height: 1,
                    }}) || {height: 0}).height
    
                    // console.log((await this.preHeaders.findOne({}, {sort: {
                    //     height: 1,
                    // }}) || {height: 0}), (await this.preHeaders.findOne({}, {sort: {
                    //         height: 1,
                    // }}) || {height: 0}), dieCounter)
                    const previousHeader = await this.preHeaders.findOne({hash: blockHeader.previousblockhash})
                    const totalDiff = BigInt(previousHeader?.totalDiff || 0n) + diff;
                    // console.log(typeof totalDiff, totalDiff, diff, BigInt(previousHeader?.totalDiff || 0))
                    // console.log(dieCounter, constants.bitcoin_validity_depth)
                    if(dieCounter <= constants.bitcoin_validity_depth) {
                        const preheader = await this.preHeaders.findOne({
                            hash: blockHeader.hash
                        })
                        if(!preheader) {
                            await this.preHeaders.insertOne({
                                ...blockHeader,
                                diff: new Long(Number(diff & 0xFFFFFFFFn), Number((diff >> 32n) & 0xFFFFFFFFn)),
                                totalDiff: new Long(Number(totalDiff & 0xFFFFFFFFn), Number((totalDiff >> 32n) & 0xFFFFFFFFn)),
                                ts: new Date(blockHeader.time * 1000)
                            })
                        }
                    } else {
                        
                    }
                    await this.activatePreheaders()
                    // await this.blockHeaders.insertOne({
                    //     ...blockHeader,
                    //     totalDiff:  new Long(Number(totalDiff & 0xFFFFFFFFn), Number((totalDiff >> 32n) & 0xFFFFFFFFn))
                    // })
                }
            }
        } catch(ex) {
            console.log(ex)
        }
    }

    async validateTXs() {

    }

    async createProof(tx_id: string) {
        const dataTx = (await rpcBitcoinCall('getrawtransaction', [tx_id, 1])).result
        // const blockHeader = 
        const merkleProof = await getMerkleProof(tx_id, dataTx.blockhash)
        const vinProf = parseTxHex(dataTx.hex)
        // console.log(merkleProof)
        // console.log(dataTx, vinProf)
        const blockHeader = (await rpcBitcoinCall('getblockheader', [dataTx.blockhash])).result
        const blockHeaderRaw = (await rpcBitcoinCall('getblockheader', [dataTx.blockhash, false])).result
        console.log((merkleProof[0] as any).length, (merkleProof[0] as any).reduce((a, b) => a + b))
        
        const fullProof ={
            ...vinProf,
            intermediate_nodes: (merkleProof[0] as any).reduce((a, b) => a + b),
            index: merkleProof[1],
            tx_id: reverse(tx_id),
            // confirming_header: dataTx.blockhash
            confirming_header: {
                raw: blockHeaderRaw,
                hash: reverse(blockHeader.hash),
                height: typeof blockHeader.height === 'number' ? blockHeader.height : blockHeader.height,
                prevhash: reverse(blockHeader.previousblockhash),
                merkle_root: reverse(blockHeader.merkleroot),
            }
        }
        console.log('fullProof', fullProof)

        try {
            let validProof = ValidateSPV.validateProof(ser.deserializeSPVProof(JSON.stringify(fullProof)))
            console.log('validProof', validProof)
        } catch (ex) {
            console.log(ex)
        }
    }

    async start() {
        const mongo = await MongoClient.connect('mongodb://localhost:27017')
        this.db = mongo.db('vsc-wrapper')
        this.blockHeaders = this.db.collection('headers')
        this.transactions = this.db.collection('transactions')
        this.preHeaders = this.db.collection('pre-headers')
        this.preTransactions = this.db.collection('pre-transactions')


        try {
            await this.createProof('190fb999369677fd7248ea8b78e7f2748cb969ad59125ca335f269326d06e437')

        } catch (ex) {
            console.log(ex.response)
        }
        // await this.blockHeaders.deleteMany({})
        // await this.preHeaders.deleteMany({})
        setInterval(async() => {
            const topHeader = await this.blockHeaders.findOne({}, {sort: {height:-1}})

            console.log('height', topHeader.height, 'at 30s')
        }, 30 * 1000)

        await this.replayBtc()
    }
}

void (async () => {
    const wrapper = new BitcoinWrapper()
    await wrapper.start()
})()