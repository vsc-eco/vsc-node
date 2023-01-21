used to settle the state of the VSC network with the Hive chain

currently houses the following methods
- [[CountHeight]]
- [[CreateBlock]]
- [[ProcessTransaction]]
- [[VerifyMempool]]

### Initialization

besides some basic configurations the start method does the following

- start the [[WitnessService]]
- starts a cyclic execution of the mempool verification [[VerifyMempool]]
- subscribe to the [[FastStream (hive block fetch)]] service that is fetching the latest (all) blocks of the hive chain
- the transactions of the blocks that are received by the subscription are processed via the [[ProcessTransaction]] method
- creates an interval that executes the [[CreateBlock]] block when the condition to create a block is met