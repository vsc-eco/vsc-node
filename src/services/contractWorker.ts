import NodeSchedule from 'node-schedule'
import { CoreService } from "./index"
import { CommitmentStatus } from "../types/contracts";
import { TransactionDbStatus, TransactionRaw, TransactionDbType } from '../types';
import { BenchmarkContainer } from '../utils';
import { CID } from 'kubo-rpc-client';
import { ContractOutput, VSCTransactionTypes } from '../types/vscTransactions';

export class ContractWorker {
    self: CoreService
    network_id: string;

    constructor(self: CoreService) {
        this.self = self
        
        this.batchExecuteContracts = this.batchExecuteContracts.bind(this)
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
        // this.self.logger.debug('tx about to be batch executed', transactions)

        for (const transaction of transactions) {
            try {

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
            } catch(ex) {
                // console.log(ex)
            }
        }
    }

    async start() {
        this.network_id = this.self.config.get('network.id')
        if(this.self.mode !== 'lite') {
            setInterval(async() => {
                if(typeof this.self.witness.witnessSchedule !== 'undefined' && this.self.chainBridge.hiveStream.blockLag < 5 && this.self.chainBridge.syncedAt && typeof this.self.chainBridge.hiveStream.blockLag !== "undefined") {
                    const nodeInfo = await this.self.chainBridge.witnessDb.findOne({
                      did: this.self.identity.id,
                    })
                    if (nodeInfo) {
                        //   const scheduleSlot = this.self.witness.witnessSchedule?.find((e) => {
                        //     return e.bn === offsetBlock
                        //   })
                        
                        const scheduleSlot = this.self.witness.witnessSchedule.find(e => e.in_past !== true)
                        const isChoosen = scheduleSlot?.did === this.self.identity.id;
                        if (nodeInfo.enabled && isChoosen || this.self.config.get('debug.overrideSchedule')) {
                            await this.batchExecuteContracts()
                        }
                    }
                }
            }, 15 * 1000)
        }
    }
}