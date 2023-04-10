import NodeSchedule from 'node-schedule'
import { CoreService } from "./index"
import { CommitmentStatus } from "../types/contracts";
import { TransactionDbStatus, TransactionRaw, TransactionDbType } from '../types';
import { BenchmarkContainer } from '../utils';
import { CID } from 'ipfs-http-client';
import { ContractOutput, VSCTransactionTypes } from '../types/vscTransactions';

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

        this.self.logger.info('EXECUTING SMART CONTRACTS')

        // TBD replace with deterministic way that works by taking the hash of a hive block thats beeing created shortly before the anchor block into consideration,
        // for that to work smoothly the simultaneous execution (start) of this method is required throughout all validators
        const sort: any = { "id": -1 };

        const transactions = await this.self.transactionPool.transactionPool.find({
            op: 'call_contract',
            status: TransactionDbStatus.included
        })
        .sort(sort)
        .limit(this.self.config.get('witness.batchExecutionSize') || 100).toArray()
        this.self.logger.debug('tx about to be batch executed', transactions)

        for (const transaction of transactions) {
            const output = await this.self.contractEngine.contractExecuteRaw(transaction.headers.contract_id, [
                transaction
            ], {
                benchmark: new BenchmarkContainer().createInstance()
            })

            this.self.logger.debug('output of tx processing', transaction, output)

            output.parent_tx_id = transaction.id

            const txRaw: TransactionRaw = {
                ...output,
                op: VSCTransactionTypes.contract_output,
                payload: null,
                type: TransactionDbType.output
            }

            // pla: included original 'callContract' tx id in the contract output tx to let the nodes know that they can update their local tx pool state
            const result = await this.self.transactionPool.createTransaction(txRaw)

            await this.self.transactionPool.transactionPool.findOneAndUpdate({
                    id: transaction.id.toString(),
                }, {
                $set: {
                    status: TransactionDbStatus.processed,
                }
            })

            this.self.logger.debug('injected contract output tx into local db', result)
        }
    }

    async start() {
        this.batchExecuteContracts()
        NodeSchedule.scheduleJob('* * * * *', async () => {
            this.batchExecuteContracts()
        })
    }
}