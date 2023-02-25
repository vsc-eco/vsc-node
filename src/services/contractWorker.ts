import NodeSchedule from 'node-schedule'
import { CoreService } from "./index"
import { CommitmentStatus } from "../types/contracts";
import { TransactionDbStatus, TransactionTypes } from '../types';
import { BenchmarkContainer } from '../utils';
import { CID } from 'ipfs-http-client';

export class ContractWorker {
    self: CoreService

    constructor(self: CoreService) {
        this.self = self
    }

    async hasExecuterJoinedContract(contract_id: string): Promise<boolean> {
        return await this.self.contractEngine.contractCommitmentDb.findOne({
          contract_id: contract_id,
          status: CommitmentStatus.active,
          node_identity: this.self.identity.id
    
        }) !== null ? true: false;
      }

    // pla: some regular occuring event needs to trigger this... on new vsc block received or smth?
    public async batchExecuteContracts() {

        console.log('EXECUTING SMART CONTRACTS')
        const transactions = await this.self.transactionPool.transactionPool.find({
            op: 'call_contract',
            status: TransactionDbStatus.included
        }).toArray()
        console.log('tx', transactions)
        if(transactions.length > 0) {
            const output = await this.self.contractEngine.contractExecuteRaw('kjzl6cwe1jw149ac8h7kkrl1wwah8jkrnam9ys5yci2vhssg05khm71tktdbcbz', [
                transactions[0]
            ], {
                benchmark: new BenchmarkContainer().createInstance()
            })
            console.log(JSON.stringify(output, null, 2))
            const data = await this.self.transactionPool.createTransaction({
                ...output,
                op: 'contract_output',
                state_merkle: output.state_merkle.toString(),
            })
            console.log(data)
            await this.self.transactionPool.transactionPool.findOneAndUpdate({
                id: transactions[0].id,

            }, {
                $set: {
                    status: TransactionDbStatus.confirmed,
                    executed_in: "TBD",
                    output: data.id
                }
            })

            await this.self.contractEngine.contractDb.findOneAndUpdate({
                'id': "kjzl6cwe1jw149ac8h7kkrl1wwah8jkrnam9ys5yci2vhssg05khm71tktdbcbz"
            }, {
                $set: {
                    state_merkle: output.state_merkle
                }
            })
        }
        // pla: have a deterministic way of fetching the transactions out of the transactionpool DB
        const txToProcess = []

        // pla: procedurally execute contracts so we dont get state conflicts
        // for (const tx in txToProcess) {
        //     results = this.self.contractEngine.contractExecuteRaw(contractInputTx.contract_id, [contractInputTx])
        // }

        // ....
    }

    async start() {
        this.batchExecuteContracts()
        NodeSchedule.scheduleJob('* * * * *', async () => {
            this.batchExecuteContracts()
        })
    }
}