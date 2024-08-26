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
        id: String!
        status: String!
        headers: Headers
        required_auths: [Auth!]
        data: TransactionData
        sig_hash: String
        src: String
        first_seen: String
        local: Boolean
        accessible: Boolean
        anchored_block: String
        anchored_height: Int
        anchored_id: String
        anchored_index: Int
        anchored_op_index: Int
        output: TransactionOutput
    }
    type Headers {
        nonce: Int
    }
    type Auth {
        value: String!
    }
    type TransactionData {
        op: String!
        action: String
        payload: JSON
        contract_id: String
    }
    type TransactionOutput {
        index: Int
        id: String
    }
    type ContractOutput {
        id: String!
        anchored_block: String
        anchored_height: Int
        anchored_id: String
        anchored_index: Int
        contract_id: String
        gas: Gas
        inputs: [String!]!
        results: [JSON]!
        side_effects: JSON
        state_merkle: String
    }
    type Gas {
        IO: Int
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
    type HiveKeys {
        posting: String
        active: String
        owner: String
    }
    type WitnessNode {
        ` +
        // account: String
        // did: String
        // enabled: Boolean
        // git_commit: String
        // last_signed: String
        // net_id: String
        // peer_id: String
        // plugins: JSON
        // signing_keys: JSON
        // disabled_at: Int
        // disabled_reason: String
        // enabled_at: Int
        // trusted: Boolean
        `account: String
        ipfs_peer_id: String
        last_signed: Int
        net_id: String
        version_id: String
        signing_keys: HiveKeys
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
    type GetBalanceTokens {
        HBD: Float
        HIVE: Float
    }
    type GetBalanceResult {
        account: String
        block_height: Int


        tokens: GetBalanceTokens
    }
    type FindTransactionResult {
        txs: [Transaction]
    }
    type FindContractOutputResult {
        outputs: [ContractOutput]
    }
    type AnchorProducer {
        nextSlot(account: String): JSON
    }
    type LedgerOp {
        id: String!
        amount: Int!
        block_height: Int!
        from: String
        memo: String
        owner: String!
        t: String!
        tk: String!
        status: String!
    }
    type LedgerResults {
        txs: [LedgerOp!]
    }
    input LedgerTxFilter {
        byToFrom: String
        byTxId: String
        offset: Int
        limit: Int
    }
    input FindTransactionFilter {
        byId: String
        byAccount: String
        byContract: String
        byStatus: String
        byOpCategory: String
        byAction: String
        limit: Int
    }
    input FindContractOutputFilter {
        byInput: String
        byOutput: String
        byContract: String
        limit: Int
    }
    type Query {
        contractState(id: String): ContractState
        findTransaction(filterOptions: FindTransactionFilter, decodedFilter: JSON): FindTransactionResult
        findContractOutput(filterOptions: FindContractOutputFilter, decodedFilter: JSON): FindContractOutputResult
        findLedgerTXs(filterOptions: LedgerTxFilter): LedgerResults

        getAccountBalance(account: String): GetBalanceResult
        
        # Need Revision
        
        findContract(id: String): FindContractResult

        # End Need Revision
        
        submitTransactionV1(tx: String!, sig: String!): TransactionSubmitResult
        getAccountNonce(keyGroup: [String]!): AccountNonceResult

        localNodeInfo: LocalNodeInfo
        witnessNodes(height: Int): [WitnessNode]
        activeWitnessNodes: JSON
        witnessSchedule(height: Int): JSON
        nextWitnessSlot(self: Boolean): JSON

        witnessActiveScore(height: Int): JSON
        mockGenerateElection: JSON

        anchorProducer: AnchorProducer
    }
`
