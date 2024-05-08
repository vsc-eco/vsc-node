import { PrivateKey } from "@hiveio/dhive"
import { HiveClient } from "../../utils"
import { CoreService } from "../../services"

const contractId = 'vs41q9c3ygzj5gxun4pc8g6d7ag2sh6xhep79jt6urx2dw2w4k3f35s8cj639g4t6qsp'

void (async () => {
    const core = new CoreService({
        prefix: 'manual tx core',
        printMetadata: true,
        level: 'debug',
        mode: 'lite'
    })

    await core.start()
    
    const broadcast = await HiveClient.broadcast.json({
        
        required_auths: [],
        required_posting_auths: [process.env.HIVE_ACCOUNT],
        id: "vsc.tx",
        json: JSON.stringify({
            net_id: core.config.get('network.id'),
            __v: '0.1',
            __t: 'native',
            tx: {
                op: 'call_contract',
                action: 'dumpEnv',
                contract_id: contractId,
                payload: 'sldfjlksdjfl'
            }
        })
    }, PrivateKey.fromString(process.env.HIVE_ACCOUNT_POSTING))
    console.log(broadcast)
    process.exit()
})()