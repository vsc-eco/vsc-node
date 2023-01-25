


Interfaces:
- EJSON (more types can be represented in JSON) on top of CBOR
- Json Patch 
- Mongodb atomic operations
- Mongodb find
- Graphql


Tasks:
- Register contract with network
  - Find executor nodes that are allowed
- Contract indexing interface
  - Contract Oplog (json patch/tx stream)
  - Key/Value
  - Indexed search
  - Basic schema types
  - Graphql interface/schema
- Witnesses
  - Agree on list of transactions to approve
  - Fee account multi sig
- Node Base
  - Indexing identity links
  - List of contracts that exist (but not actual data)
  - List of operational executor nodes
  - List of witnesses + executors
  - List of transactions + status (auto pins relevant transctions)
- Identity
  - Register DID tied into a HIVE account

