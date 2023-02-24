import { CommitmentStatus } from "@/types/contracts";
import { CoreService } from "./index"

export class ContractWorker {
    self: CoreService

    constructor(self: CoreService) {
        this.self = self
    }

    async hasExecuterJoinedContract(contract_id: string): boolean {
        return await this.self.contractEngine.contractCommitmentDb.findOne({
          contract_id: contract_id,
          status: CommitmentStatus.active,
          node_identity: this.self.identity.id
    
        }) !== null ? true: false;
      }

    // pla: some regular occuring event needs to trigger this... on new vsc block received or smth?
    public async BatchExecuteContracts() {
        // pla: have a deterministic way of fetching the transactions out of the transactionpool DB
        const txToProcess = []

        // pla: procedurally execute contracts so we dont get state conflicts
        for (const tx in txToProcess) {
            results = this.self.contractEngine.contractExecuteRaw(contractInputTx.contract_id, [contractInputTx])
        }

        // ....
    }
}