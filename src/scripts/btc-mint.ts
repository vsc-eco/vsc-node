// @ts-nocheck
import { utils, BTCUtils, ser, ValidateSPV } from '@summa-tx/bitcoin-spv-js'
import { parseTxHex, reverse, rpcBitcoinCall } from './bitcoin-wrapper/utils';
import { CoreService } from '../services';
import { TransactionPoolService } from '../services/transactionPool';
function readUInt64(buff, offset) {
    return buff.readInt32LE(offset) + 0x100000000*buff.readUInt32LE(offset + 4);
  }
  
  function readInt64(buff, offset) {
     var word0 = buff.readUInt32LE(offset);
     var word1 = buff.readUInt32LE(offset+4);
     if (!(word1 & 0x80000000))
        return word0 + 0x100000000*word1;
     return -((((~word1)>>>0) * 0x100000000) + ((~word0)>>>0) + 1);
  }


  function verifuint(value, max) {
    if (typeof value !== 'number')
      throw new Error('cannot write a non-number as a number');
    if (value < 0)
      throw new Error('specified a negative value for writing an unsigned value');
    if (value > max) throw new Error('RangeError: value out of range');
    if (Math.floor(value) !== value)
      throw new Error('value has a fractional component');
  }
  function readUInt64LE(buffer, offset) {
    const a = buffer.readUInt32LE(offset);
    let b = buffer.readUInt32LE(offset + 4);
    b *= 0x100000000;
    verifuint(b + a, 0x001fffffffffffff);
    return b + a;
  }


void (async () => {
    // const data = await rpcBitcoinCall('getrawtransaction', ['49f41574c550a6d080520207c08023e27f812a2f75ce0d7c6170cbfb168b6b6c', 1])
    // console.log(data.result.hex)
    // const vinProf = parseTxHex(data.result.hex)
    // console.log(vinProf, utils.deserializeHex(vinProf.vout))
    // const output = BTCUtils.extractOutputAtIndex(utils.deserializeHex(vinProf.vout), 0)
    // console.log('output', output)
    // const val = BTCUtils.extractValue(output)
    
    // console.log(val, val / 100_000_000n, 5000045000n / 100_000_000n)

    // var a = new BigDecimal(val.toString());
    // var b = new BigDecimal( "100000000");

    // console.log(Number(a.divide(b).toString()))
    // console.log(readUInt64LE(Buffer.from(val), 0))
    // const bytes = new Uint8Array(val);
    // const uint = new Uint32Array(bytes.buffer)[0];
    // console.log(uint);



    const contract_id = '71bb304cfe80a8fb4605007d589ba4d0eab6da59'

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
            tx_id: '112ba175a1e04b14ba9e7ea5f76ab640affeef5ec98173ac9799a852fa39add3'
        }
    });
    core.logger.debug('result of contract invokation' , result)

})()