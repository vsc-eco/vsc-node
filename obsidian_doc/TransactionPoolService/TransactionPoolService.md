used to handle everything related to transactions

currently houses the following methods
- [[CreateTransaction]]
- [[CreateContract]]
- [[UpdateContract]]

### Initialization

the start method does the following

- initialize the mempool
- subscribe to the IPFS [[Pubsub]] mempool topic
- create a node announciation transaction