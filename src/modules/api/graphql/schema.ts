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
        UNCONFIRMED
        CONFIRMED
        FAILED
        INCLUDED
        PROCESSED
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
        stateKeys(key: String): JSON
        state_merkle: String
    }
    type FindContractResult {
        status: String
        # More coming
    }
    type TransactionSubmitResult {
        status: String
        contract: Contract
    }
    type LocalNodeInfo {
        peer_id: String
        did: String
    }
    type WitnessNode {
        account: String
        did: String
        enabled: Boolean
        git_commit: String
        last_signed: String
        net_id: String
        peer_id: String
        plugins: JSON
        signing_keys: JSON
        disabled_at: Int
        disabled_reason: String
        enabled_at: Int
        trusted: Boolean
    }
    interface BalanceController {
        type: BalanceControllerType
        authority: String
        conditions: [BalanceAccessCondition]
    }
    enum BalanceControllerType {
        HIVE
        DID
        CONTRACT
    }
    interface BalanceAccessCondition {
        type: BalanceAccessConditionType
        value: String
    }
    enum BalanceAccessConditionType {
        TIME
        HASH
        WITHDRAW
    }
    interface DepositDrain {
        deposit_id: String
        amount: Float
    }
    type Deposit {
        from: String
        id: String
        orig_balance: Float
        active_balance: Float
        created_at: String
        last_interacted_at: String
        outputs: [DepositDrain]
        inputs: [DepositDrain]
        asset_type: String
        create_block: BlockRef
        controllers: [BalanceController]
        contract_id: String
        controllers_hash: String
    }
    interface BlockRef {
        block_ref: String
        included_block: Int
    }
    type Query {
        contractState(id: String): ContractState
        findTransaction(id: String): Transaction
        findContract(id: String): FindContractResult
        findDeposit(id: String): Deposit

        submitTransaction(id: String): TransactionSubmitResult
        localNodeInfo: LocalNodeInfo
        witnessNodes: [WitnessNode]
        nextWitnessSlot(local: Boolean): JSON
    }
`
