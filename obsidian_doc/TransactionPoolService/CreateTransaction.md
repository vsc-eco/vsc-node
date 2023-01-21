creates a transaction and injects it into the [[Transactionpool Table]] as an unconfirmed transaction. It also publishes the newly created transaction to the IPFS [[Pubsub]] topic thats responsible for broadcasting new un-included transactions to other nodes and puts the data on IPFS via the [[Data API]].

### next steps

The unconfirmed transaction will then be verified by the cylic execution of the [[VerifyMempool]] method. Afterwards the transaction will be included in a block via [[CreateBlock]] 

