import Axios from 'axios'
import { BTCBlockStream } from "./bitcoin-wrapper/utils";
import { sleep } from '../utils';
import { TransactionPoolService } from '../services/transactionPool';
import { CoreService } from '../services';


async function waitTxConfirm(id: string, self: CoreService) {
    for( ; ; ) {
        const {data} = await Axios.post('http://localhost:1337/api/v1/graphql', {
            query: `
            query MyQuery {
                findTransaction(id: "${id}") {
                  status
                }
              }`
        })
        console.log(data.data)
        await self.p2pService.memoryPoolChannel.call('announce_tx', {
            payload: {
              id: id.toString()
            },
            mode: 'basic'
        })
        if(data.data.findTransaction.status === "CONFIRMED") {
            return;
        }
        await sleep(30_000)
    }
}

void (async () => {
    const contract_id = 'd03a60d82f820bd2fc3bdaf9882a4cbf70eaafe0'

    const core = new CoreService({
        prefix: 'manual tx core',
        printMetadata: true,
        level: 'debug',
        mode: 'lite'
    })

    await core.start()

    const transactionPool = new TransactionPoolService(core)

    await transactionPool.start()

    
    
    let headerBulk = [] as any
    let x = 0;
    for await(let [header] of BTCBlockStream(0)) {
        headerBulk.push(header)
        x = x + 1;
        if(x >= 20) {
            const result = await transactionPool.callContract(contract_id, {
                action: 'processHeaders',
                payload: {
                    headers: headerBulk
                }
            });
            core.logger.debug('result of contract invokation' , result)
            await waitTxConfirm(result.id, core)
            await sleep(10 * 60_000)
            headerBulk = []
            x = 0;
        }
    }
})()