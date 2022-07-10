
interface ContractGenesis {

    id: string //Random uuid
    
    code_url: string //IPFS CID 
    stream_id: string //Stream ID of the manifest
    creators: string[] //list of DIDs that created the contract
}

interface ContractManifest {
    code_url: string //
    name: string //Arbitrary name of the contract. Not unique

}

//TBD. Define entry points that the contract can interact with
interface EntryPoints {

    
}

interface CoreState {
    stateMap: string //IPFS URL to map of all state variables
}