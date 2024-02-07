
import { MerkleTree } from 'merkletreejs'
import Crypto from 'crypto'
import BitSet from 'bitset'

function sha256(data) {
    // returns Buffer
    return Crypto.createHash('sha256').update(data).digest()
}

/**
 * Encode merkle proof into packed obj
 */
function encodeMerkleProof(arr: Array<{
    data: Buffer
}>, index: number) {

    let out = []
    for(let item of arr) {
        if(index % 2 === 1) {
            out.push({
                ...item,
                position: 'left'
            })
        } else {
            out.push({
                ...item,
                position: 'right'
            })
        }
        index >>= 1;
    }
    return out;
}
  

export function simpleMerkleTree(tree: Array<string | Uint8Array>) {
    const leaves = tree.map(x => {
        //Assume hex string
        let val;
        if(typeof x == 'string') {
            val = Buffer.from(x, 'hex');
        } else {
            val = Buffer.from(x)
        }
        return sha256(val)
    })
    const merkleTree = new MerkleTree(leaves, sha256)

    const root = merkleTree.getRoot().toString('base64url')
    return root
}

export class DidSig {
    
}



/**
 * Simple Multi-DID supporting secp256k1, ed25519, and BLS12-381
 */
export class MultiDID {

}