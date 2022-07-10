
import { DID } from 'dids'
import { Ed25519Provider } from 'key-did-provider-ed25519'
import { getResolver } from 'key-did-resolver'
import DocID from "@ceramicnetwork/docid";


const docId = 'k2t6wyfsu4pfxy78bw9ocy7af5bpecbnjxmh7ujm6nnqyaaamp2trmhx6m6wb0'


void (async () => {
    const { TileDocument } = await import('@ceramicnetwork/stream-tile')
    const {CeramicClient} = await import('@ceramicnetwork/http-client')
    const ceramic = new CeramicClient('https://ceramic.3speak.tv')

    const tilDoc = await TileDocument.load(ceramic, docId)
    console.log(tilDoc.allCommitIds)
    for(let commit of tilDoc.allCommitIds) {
        const {state} = await TileDocument.load(ceramic, commit)
        console.log(state.content)
    }
    //const fetchDoc = DocID.fromOther(DocID.fromString(docId), commitId)
})()