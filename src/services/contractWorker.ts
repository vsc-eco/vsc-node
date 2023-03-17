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
    
        }) !== null;
      }

    // pla: some regular occuring event needs to trigger this... on new vsc block received or smth?
    // pla: (obviously) has issues when it cant find the contract on the local ipfs node (contractExecuteRaw crashes)
    public async batchExecuteContracts() {

        console.log('EXECUTING SMART CONTRACTS')

        // pla: create more sophisticated sort to introduce a fair and deterministic way to select tx to process?
        // maybe fetch the included_in prop, convert to a block height, sort by block height and afterwards continue to 
        // to sort after the fetch by the property X (TBD)
        const sort = { op: -1 };

        const transactions = await this.self.transactionPool.transactionPool.find({
            op: 'call_contract',
            status: TransactionDbStatus.included
        })
        //.sort(sort)
        .limit(this.self.config.get('witness.batchExecutionSize')).toArray()
        console.log('tx', transactions)

        for (const transaction of transactions) {
            const output = await this.self.contractEngine.contractExecuteRaw(transaction.headers.contract_id, [
                transaction
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
                id: transaction.id,
            }, {
                $set: {
                    status: TransactionDbStatus.confirmed,
                    executed_in: "TBD",
                    output: data.id
                }
            })

            // pla: shouldnt we not do this here and instead create a VSCOperations.contract_output transaction and let
            // the block parser do the updating of the DB, same for the above txpool update i guess 
            // (though for the mempool updates it might make sense so the mempool updates can be propagated b4 the block creation/ parsing)
            await this.self.contractEngine.contractDb.findOneAndUpdate({
                'id': transaction.headers.contract_id
            }, {
                $set: {
                    state_merkle: output.state_merkle
                }
            })
        }
    }

    async start() {
        this.batchExecuteContracts()
        NodeSchedule.scheduleJob('* * * * *', async () => {
            this.batchExecuteContracts()
        })
    }
}