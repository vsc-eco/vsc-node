

/**
 * Executes a smart contract manually for testing purpoess
 */
import fs from 'fs/promises'
import { BenchmarkContainer } from "../utils"
import { CoreService } from "../services"


void (async () => {
    const core = new CoreService({
        prefix: 'manual tx core',
        printMetadata: true,
        level: 'debug',
        mode: 'lite'
    })

    await core.start()
    
    const output = await core.contractEngine.contractExecuteRaw('df4ca52b190e817d6b610fbfefb9eeb081888d4c', [
        await core.transactionPool.transactionPool.findOne({
            id: 'bafyreif6jzvfl3ig2vhl2pcv5rl4e2dnisqervhm3ysayf626w7u5f5vuy'
        })
    ], {
        benchmark: new BenchmarkContainer().createInstance(),
        codeOverride: (await fs.readFile('contracts/btc-token.js')).toString()
    })
    
    console.log(JSON.stringify(output.log_matrix, null, 2))
})()