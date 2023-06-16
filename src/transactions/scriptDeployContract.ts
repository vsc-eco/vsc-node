import { init } from './core'
import { HiveClient } from '../utils'
import { PrivateKey } from '@hiveio/dhive'
import * as fs from 'fs/promises'
import Path from 'path'
import { CID } from 'ipfs-http-client'
import { TransactionPoolService } from '../services/transactionPool'
import { createHAMT } from 'hamt-sharding'
import crypto from 'crypto'

void (async () => {
  const setup: { identity; config; ipfsClient; logger } = await init()

  console.log(new Date())

  const contractLocation = './contracts'

  const directory = (await fs.readdir(contractLocation)).filter(function (e) {
    return e.endsWith('manifest.json')
  })
  console.log(directory)
  for (let contractFile of directory) {
    try {
        const path = Path.join(contractLocation, [contractFile.split('.')[0], 'js'].join('.'))
        await fs.stat(path)

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
      
        const confirmation = await TransactionPoolService.createContract({
                name: manifestData.name,
                code: code,
                description: manifestData.description
            },
        setup);
        console.log(confirmation)

    } catch(ex) {
        console.log(ex)
    }
  }

  // process.exit(0)
})()
