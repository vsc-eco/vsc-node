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
        tx_id: String
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
    type findCIDResult {
        type: String
        data: JSON
        link: String
        payload: String
        signatures: JSON
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
    interface BlockRef {
        block_ref: String
        included_block: Int
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
    type FindtransactionResult {
        txs: [Transaction]
    }
    input FindTransactionFilter {
        byId: String
        byAccount: String
        byContract: String
        byStatus: String
    }
    
    type Query {
        contractState(id: String): ContractState
        findTransaction(filterOptions: FindTransactionFilter, decodedFilter: JSON): FindtransactionResult
        findContract(id: String): FindContractResult
        findCID(id: String): findCIDResult
        findDeposit(id: String): Deposit

        submitTransaction(blob: String): TransactionSubmitResult
        localNodeInfo: LocalNodeInfo
        witnessNodes: [WitnessNode]
        nextWitnessSlot(local: Boolean): JSON
    }
`
