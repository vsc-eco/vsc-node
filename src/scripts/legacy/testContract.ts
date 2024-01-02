

/**
 * Executes a smart contract manually for testing purpoess
 */
import fs from 'fs/promises'
import { BenchmarkContainer } from "../../utils"
import { CoreService } from "../../services"


void (async () => {
    const core = new CoreService({
        prefix: 'manual tx core',
        printMetadata: true,
        level: 'debug',
        mode: 'lite',
        // newService: {} as any
    })

    await core.start()
    
    // const output = await core.contractEngine.contractExecuteRaw('462014fc9a93a689908bfe4abe57edb758bd2064', [
    //     await core.transactionPool.transactionPool.findOne({
    //         id: 'bafyreia7mxcncss2hr3fbtuz3x2wrpe5eifdqlihqbb2lvw6iqvkow4ome'
    //     })
    // ], {
    //     benchmark: new BenchmarkContainer().createInstance(),
    //     codeOverride: (await fs.readFile('contracts/btc-token.js')).toString()
    // })
    
    // console.log(output)
    // console.log(JSON.stringify(output.log_matrix, null, 2))
})()