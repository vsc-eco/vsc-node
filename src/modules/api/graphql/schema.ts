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
        decoded_tx: JSON
        redeem: JSON
    }
    type ContractState {
        id: String
        state(key: String): JSON
        stateQuery(key: String, query: JSON): JSON
        stateKeys(key: String): JSON
        state_merkle: String
    }
    type FindContractResult {
        status: String
        # More coming
    }
    type TransactionSubmitResult {
        id: String
    }
    type AccountNonceResult {
        nonce: Int
    }
    type AccountInfoResult {
        rc_max: Int
        rc_current: Int
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
        token: String
        owner: String
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
    type GetBalanceTokens {
        HBD: Float
        HIVE: Float
    }
    type GetBalanceResult {
        account: String
        block_height: Int


        tokens: GetBalanceTokens
    }
    type FindtransactionResult {
        txs: [Transaction]
    }
    input FindTransactionFilter {
        byId: String
        byAccount: String
        byContract: String
        byStatus: String
        byOpCategory: String
        byAction: String
    }
    
    type Query {
        contractState(id: String): ContractState
        findTransaction(filterOptions: FindTransactionFilter, decodedFilter: JSON): FindtransactionResult
        findDeposit(id: String): Deposit
        findLedgerTXs(byContractId: String, byToFrom: String): FindtransactionResult

        getAccountBalance(account: String): GetBalanceResult
        
        # Need Revision
        
        findContract(id: String): FindContractResult

        # End Need Revision
        
        submitTransactionV1(tx: String!, sig: String!): TransactionSubmitResult
        getAccountNonce(keyGroup: [String]!): AccountNonceResult

        localNodeInfo: LocalNodeInfo
        witnessNodes(height: Int!): [WitnessNode]
        activeWitnessNodes: JSON
        witnessSchedule(height: Int): JSON
        nextWitnessSlot(self: Boolean): JSON
    }
`
