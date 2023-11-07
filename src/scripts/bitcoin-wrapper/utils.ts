import Axios from 'axios'
import { utils, BTCUtils, ser, ValidateSPV } from '@summa-tx/bitcoin-spv-js'
import Pushable from 'it-pushable';

export function reverse(str) {
  return Buffer.from(str, 'hex').reverse().toString('hex');
}


function hasWitnessBytes(bytes) {
  return bytes[4] === 0 && bytes[5] !== 0;
}

function toString(buf) {
  let str = '';
  for (const uint of buf) {
    let hex = uint.toString(16);
    if (hex.length === 1) { hex = `0${hex}`; }
    str += hex;
  }
  return str;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function rpcBitcoinCall(name: string, params) {
  const data = await Axios.post('http://bitcoin:bitcoin@149.56.25.168:8332', {
    "jsonrpc": "1.0", "id": "curltest", "method": name, "params": params
  })

  return data.data;
}

export async function* BTCBlockStream(options: {continueHead: boolean, height:number, signal: AbortSignal, }) {
  const bestBlock = await rpcBitcoinCall('getbestblockhash', null)

  const bestBlockHeader = (await rpcBitcoinCall('getblockheader', [bestBlock.result])).result
  console.log('best block height', bestBlockHeader.height)

  let promises = []
  let batchSize = 10
  let lastBlock = bestBlockHeader.height;
  for (let x = options.height; x <  bestBlockHeader.height; x++) {
    if (options.signal.aborted === true) {
      return;
    }
    if (promises.length > batchSize) {
      for (let data of (await Promise.all(promises)).filter(e => !!e).sort(({x:a}, {x:b}) => {
        return a - b;
      })) {
        lastBlock = data.x
        yield data;
      }
      promises = []
    }
    promises.push((async () => {
      for (; ;) {
        try {
          const blockHash = (await rpcBitcoinCall('getblockhash', [x])).result
          const blockData = (await rpcBitcoinCall('getblockheader', [blockHash])).result
          const blockDataRaw = (await rpcBitcoinCall('getblockheader', [blockHash, false])).result

          return {
            data: blockData,
            rawData: blockDataRaw,
            x,
          }

        } catch (ex) {
          if (ex.response?.data?.error?.code === -8 ) {
            // if(options.stop === true) {
            //   return null
            // }

            return null;
            // await sleep(60 * 1000)
            // continue;
          } else {
            // throw ex
            return null;
          }
        }
      }
    })())
  }

  console.log('89.lastBlock', lastBlock, bestBlockHeader.height)

  //Clear all remaining promises
  for (let data of (await Promise.all(promises)).filter(e => !!e).sort(({x:a}, {x:b}) => {
    return a - b;
  })) {
    lastBlock = data.x
    yield data;
  }
  promises = []

  if(options.continueHead) {
    console.log('options.continueHead', options.continueHead, 'lastBlock', lastBlock)
    try {
      for (let x = lastBlock + 1; x < Infinity; x++) {
        yield await getBtcBlock(x, options.signal)
  
        console.log('options.signal.aborted', options.signal.aborted)
        if (options.signal.aborted === true) {
          break
        }
      }

    } catch (ex) {
      console.log(ex)
    }
  }
}

async function getBtcBlock(x: number, signal: AbortSignal) {
  for (;;) {
    try {
      const blockHash = (await rpcBitcoinCall('getblockhash', [x])).result
      const blockData = (await rpcBitcoinCall('getblockheader', [blockHash])).result
      const blockDataRaw = (await rpcBitcoinCall('getblockheader', [blockHash, false])).result

      return {
        data: blockData,
        rawData: blockDataRaw,
        x,
      }
    } catch (ex) {
      if (ex.response?.data?.error?.code === -8) {
        if (signal.aborted === true) {
          break
        }

        // return null;
        console.log('for sure sleeping', x)
        await sleep(60 * 1000)
        continue
      } else {
        console.log(ex)
        // throw ex
        return null
      }
    }
  }
}



/**
 * Infinite BTC block stream. It will continue to stream blocks as the btc mainnet produces them
 * @param options 
 */
export async function* liveBTCBlocks(options: { height: number; signal: AbortSignal }) {
  for (let x = options.height; x < Infinity; x++) {
    for (;;) {
      try {
        const blockHash = (await rpcBitcoinCall('getblockhash', [x])).result
        const blockData = (await rpcBitcoinCall('getblockheader', [blockHash])).result
        const blockDataRaw = (await rpcBitcoinCall('getblockheader', [blockHash, false])).result

        yield {
          data: blockData,
          rawData: blockDataRaw,
          x,
        }
        break
      } catch (ex) {
        if (ex.response?.data?.error?.code === -8) {
          if (options.signal.aborted === true) {
            break
          }

          // return null;
          await sleep(60 * 1000)
          continue
        } else {
          // throw ex
          return null
        }
      }
    }
    if (options.signal.aborted === true) {
      break
    }
  }
}

export function parseTxHex(hex) {
  const raw = utils.deserializeHex(hex);
  let offset = 0;

  console.log(raw)
  // Handle version
  let version = raw.subarray(offset, offset + 4);
  version = toString(version);

  if (hasWitnessBytes(raw)) { offset += 6; } else { offset += 4; }

  let inputs = '';
  const vinCount = BTCUtils.determineVarIntDataLength(raw[offset]) || raw[offset];
  inputs += toString(raw.subarray(offset, offset + 1));
  offset += 1;

  // Handle inputs
  for (let i = 0; i < vinCount; i++) {
    // 32 byte hash
    const hash = raw.subarray(offset, offset + 32);
    inputs += toString(hash);
    offset += 32;
    // 32 bit integer
    const index = raw.subarray(offset, offset + 4);
    inputs += toString(index);
    offset += 4;

    // varint script
    const scriptSize = BTCUtils.determineVarIntDataLength(raw[offset]) || raw[offset];
    const varint = raw.subarray(offset, offset + 1);
    inputs += toString(varint);
    offset += 1;

    const script = raw.subarray(offset, offset + scriptSize);
    inputs += toString(script);
    offset += scriptSize;

    // 32 bit sequence
    const sequence = raw.subarray(offset, offset + 4);
    inputs += toString(sequence);
    offset += 4;
  }

  // Handle outputs
  let outputs = '';
  const voutCount = BTCUtils.determineVarIntDataLength(raw[offset]) || raw[offset];
  outputs += toString(raw.subarray(offset, offset + 1));
  offset += 1;

  for (let i = 0; i < voutCount; i++) {
    // value 64 bits
    const value = raw.subarray(offset, offset + 8);
    offset += 8;
    outputs += toString(value);

    // script varbytes
    const scriptSize = BTCUtils.determineVarIntDataLength(raw[offset]) || raw[offset];
    const varint = raw.subarray(offset, offset + 1);
    outputs += toString(varint);
    offset += 1;

    const script = raw.subarray(offset, offset + scriptSize);
    outputs += toString(script);
    offset += scriptSize;
  }

  // Handle locktime
  let locktime = raw.subarray(-4);
  locktime = toString(locktime);

  return {
    version,
    vin: inputs,
    vout: outputs,
    locktime
  };
}