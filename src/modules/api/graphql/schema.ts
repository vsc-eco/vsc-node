export const schema = `
    scalar JSON
    type JsonPatchOp {
        op: String
        path: String
        value: JSON
    }
    type Contract {
        id: String
        code: String
        creation_ts: String
    }
    enum TransactionStatus {
        UNCOFIRMED
        CONFIRMED
        FAILED
        INCLUDED
    }
    enum TransactionType {
        NULL
        INPUT
        OUTPUT
        VIRTUAL
        CORE
    }
    type Transaction {
        id: String
        op: String
        status: TransactionStatus
        local: Boolean
        first_seen: String
        type: TransactionType
        included_in: String
        executed_in: String
    }
    type ContractState {
        id: String
        state(key: String): JSON
        state_merkle: String
    }
    type FindContractResult {
        status: String
    }
    type TransactionSubmitResult {
        status: String
        contract: Contract
    }
    type LocalNodeInfo {
        peer_id: String
        did: String
    }
    type Query {
        contractState(id: String): ContractState
        findTransaction(id: String): Transaction
        findContract(id: String): FindContractResult

        submitTransaction(id: String): TransactionSubmitResult
        localNodeInfo: LocalNodeInfo
    }
`