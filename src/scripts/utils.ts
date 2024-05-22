import Axios from 'axios'
import { CoreService } from '../services';
import { sleep } from "../utils";

export async function waitTxConfirm(id: string, self: CoreService, func) {
    let lastStatus;
    for( ; ; ) {
        const {data} = await Axios.post('http://localhost:1337/api/v1/graphql', {
            query: `
            query MyQuery {
                findTransaction(filterOptions:{byId: "${id}"}) {
                  txs {
                    status
                  }
                }
              }`
        })
        console.log(data)
        await self.newService.p2pService.memoryPoolChannel.call('announce_tx', {
            payload: {
              id: id.toString()
            },
            mode: 'basic'
        })
        
        if(func && ['CONFIRMED', 'INCLUDED'].includes(data.data.findTransaction.txs[0].status) && lastStatus !== data.data.findTransaction.txs[0].status) {
            func(data.data.findTransaction.txs[0].status)
            lastStatus = data.data.findTransaction.txs[0].status
        }
        if(data.data.findTransaction.txs[0].status === "CONFIRMED") {
            return;
        }
        await sleep(5_000)
    }
}

