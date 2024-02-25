import { init } from './core'
import { HiveClient } from '../utils'
import { PrivateKey } from '@hiveio/dhive'
import * as fs from 'fs/promises'
import Path from 'path'
import { CID } from 'kubo-rpc-client'
import { createHAMT } from 'hamt-sharding'
import crypto from 'crypto'
import { compileAS } from '../services/new/vm/compiler'

void (async () => {
  const setup: { identity; config; ipfsClient; logger } = await init()

  console.log(new Date())

  const contractLocation = './contracts/new'

  const directory = (await fs.readdir(contractLocation)).filter(function (e) {
    return e.endsWith('manifest.json')
  })
  console.log(directory)
  for (let contractFile of directory) {
    try {
        const path = Path.join(contractLocation, [contractFile.split('.')[0], 'tsa'].join('.'))
        await fs.stat(path)

        console.log(Path.join(contractLocation,contractFile))
        const manifestData = JSON.parse((await fs.readFile(Path.join(contractLocation,contractFile))).toString())

        console.log(manifestData)
        if(manifestData.deployedAt) {
            //Already deployed!
            continue;
        }

        let code = ""
        try {
            const data = await fs.readFile(path, 'utf8');
            code = data
        } catch (err) {
            // setup.logger.error('not able to load contract file:\n', err);
            process.exit(0)
        }

        const result = await compileAS({
          scriptPath: path
        })
        console.log(result)
        if(result.err) {
          console.log(`ERROR on compiling to WASM - ${result.err}`)
          process.exit(0)
        }

        if(result.binary.length > 240_000) {
          console.log(`ERROR compiled result must be smaller than 240KB. Total size: ${result.binary.length}`)
          process.exit(0)
        }
        const cid = await setup.ipfsClient.block.put(result.binary)

        console.log(cid)

        const broadcastResult = await HiveClient.broadcast.json({
          required_auths: [process.env.HIVE_ACCOUNT],
          required_posting_auths: [],
          id: 'vsc.create_contract',
          json: JSON.stringify({
            __v: '0.1',
            net_id: setup.config.get('network.id'),
            name: manifestData.name,
            code: cid.toString(),
            description: manifestData.description
          })
        }, PrivateKey.fromString(process.env.HIVE_ACCOUNT_ACTIVE))

        console.log(broadcastResult)
      
        // const confirmation = await TransactionPoolService.createContract({
        //         name: manifestData.name,
        //         code: code,
        //         description: manifestData.description
        //     },
        // setup);
        // console.log(confirmation)
        // manifestData.deployedAt = new Date().toISOString()
        // manifestData.deployedId = confirmation.id
        // console.log(manifestData)
        // console.log(contractFile)
        // await fs.writeFile(Path.join(contractLocation, contractFile), JSON.stringify(manifestData, null, 2))
    } catch(ex) {
        console.log(ex)
    }
  }

  // process.exit(0)
})()
