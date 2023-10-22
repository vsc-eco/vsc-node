// import { reverseEndianness } from '@summa-tx/bitcoin-spv-js/dist/utils'
import _ from '../src/environment'
// import { BTCUtils, utils as DataUtils, ValidateSPV } from '@summa-tx/bitcoin-spv-js'

// const utils = {
//     bitcoin: {
//         BTCUtils
//     }
// }

const validity_depth = 2;


const headersState = {

}

function calcKey(height: number) {
    const cs = 100
    const keyA = Math.floor((height / cs)) * cs

    return `${keyA}-${keyA + cs}`
}
actions.processHeaders = async (args) => {
    const preheaders: Record<string, {
        prevBlock: string
        timestamp: Date | string
        merkleRoot: string
        diff: BigInt
        totalDiff: BigInt
        height: number
        raw: string
    }> = await state.pull(`pre-headers/main`) || {
    }
    const {headers} = args;


    for(let rawBH of headers) {
        const decodeHex = new Uint8Array(Buffer.from(rawBH, 'hex'))
        const prevBlock = utils.bitcoin.reverseBytes(utils.bitcoin.BTCUtils.extractPrevBlockLE(decodeHex));
        const timestamp = utils.bitcoin.BTCUtils.extractTimestamp(decodeHex)
        // const timestamp = utils.bitcoin.BTCUtils.extractTimestampLE(decodeHex)
        const merkleRoot = utils.bitcoin.reverseBytes(utils.bitcoin.BTCUtils.extractMerkleRootLE(decodeHex))
        // console.log(timestamp.toString())
        const headerHash = utils.bitcoin.BTCUtils.hash256(decodeHex);
        const diff = utils.bitcoin.ValidateSPV.validateHeaderChain(decodeHex)

        let prevDiff;
        let prevHeight;
        if(prevBlock === '0000000000000000000000000000000000000000000000000000000000000000') {
            prevDiff = 0n;
            prevHeight = -1;
        } else if(typeof preheaders[prevBlock] === 'object') {
            prevDiff = BigInt(preheaders[prevBlock].totalDiff as any) //|| 0n
            prevHeight = preheaders[prevBlock].height //|| 0
        } else {
            continue;
        }

        const decodedHeader = {
            prevBlock: prevBlock,
            timestamp: new Date(Number(timestamp.toString()) * 1000).toISOString(),
            merkleRoot,
            diff,
            totalDiff: diff + prevDiff,
            height: prevHeight + 1,
            raw: rawBH
        }
        preheaders[utils.bitcoin.reverseBytes(headerHash)] = {
            ...decodedHeader
        }
        // console.log(decodedHeader, DataUtils.serializeHex(reverseEndianness(headerHash))
    }
    const mapSorted = Object.entries(preheaders).sort(([, a], [, b]) => {
        return Number(BigInt((a as any).totalDiff) - BigInt((b as any).totalDiff));
    })
    
    const topHeader = mapSorted[mapSorted.length - 1]

    let blocksToPush = [] as Array<any>
    let curDepth = 0;
    let prevBlock;
    for( ; ; ) {
        if(!prevBlock) {
            prevBlock = topHeader[0]
            //prevBlock = topHeader.pop()
        }

        if(preheaders[prevBlock]) {
            if(curDepth > validity_depth) {
                blocksToPush.push(preheaders[prevBlock])
            } else {
                curDepth = curDepth + 1;
            }
        } else {
            break;
            /**
             * let poppedBlock = mapSorted.pop();
            if(poppedBlock) {
                prevBlock = poppedBlock[0]
                continue;
            } else {
                break;
            }
             */
        }
        prevBlock = preheaders[prevBlock].prevBlock
    }
    
    
    let highestHeight = 0;
    for(let block of blocksToPush) {
        const key = calcKey(block.height)
        //Get headers in memory if not available
        if(!headersState[key]) {
            headersState[key] = await state.pull(`headers/${key}`) || {}
        }
        //Only override if not
        if(!headersState[key][block.height]) {
            headersState[key][block.height] = block.raw
        }
        if(highestHeight < block.height) {
            highestHeight = block.height
        }
        // headersState[calcKey(block.height as number)] = block.raw
    }

    for(let [key, {height}] of Object.entries(preheaders)) {
        if(highestHeight >= height) {
            console.log(highestHeight, height)
            delete preheaders[key];
        }
    }

    for(let [key, val] of Object.entries(headersState)) {
        await state.update(`headers/${key}`, val)
    }
    await state.update('pre-headers/main', preheaders)
}


actions.validateTxProof = async (args) => {
    const {proof} = args

    const bundleHeaders = await state.pull(`headers/${calcKey(proof.confirming_height)}`) || {}

    const header = bundleHeaders[proof.confirming_height]


    const decodeHex = new Uint8Array(Buffer.from(header, 'hex'))
    const prevBlock = Buffer.from(utils.bitcoin.BTCUtils.extractPrevBlockLE(decodeHex)).toString('hex');
    // const timestamp = utils.bitcoin.BTCUtils.extractTimestampLE(decodeHex)
    const merkleRoot = Buffer.from(utils.bitcoin.BTCUtils.extractMerkleRootLE(decodeHex)).toString('hex')
    // console.log(timestamp.toString())
    const headerHash = Buffer.from(utils.bitcoin.BTCUtils.hash256(decodeHex)).toString('hex');

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
        await state.update(`txs/${proof.tx_id}`, proof)
    }
}

