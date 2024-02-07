import canonicalizeData from 'canonicalize'
import { encodePayload } from 'dag-jose-utils'
import { DID } from "dids";

export function verifyNodeInfo() {
    
}


export async function verifyTx(txData, did: DID) {
    const txDataOut = {
        ...txData
    }
    const signatures = txData.signatures
    delete txDataOut.signatures
    
    try {
        const verifyResult = await did.verifyJWS({
            payload: Buffer.from(canonicalizeData(txDataOut)).toString('base64'),
            signatures: signatures.map(e => {
                return {
                    protected: e.p,
                    signature: e.s
                }
            })
        })
        
        for(let auth of txDataOut.headers.required_auths) {
            if(auth.value !== verifyResult.kid.split('#')[0]) {
                return {
                    valid: false,
                    validDid: null,
                }
            }
        }
  
        return {
            valid: true,
            validDid: verifyResult.kid.split('#')[0],
            errs: []
        }
    } catch(ex) {
        return {
            valid: false,
            validDid: null,
            errs: [ex.message]
        }
    }
  }

/**
 * Sort transactions according to sort key.
 */
export function sortTransactions(rawTransactions: Array<any>, vrfSeed: string) {
    const preOrder = ShuffleSeed.shuffle(rawTransactions.sort((a, b) => {
        return a.id - b.id
    }).map(e => {
        return {
            act: e.act
        }
    }), vrfSeed)
    let dividedArray = {}
    rawTransactions.forEach(e => {
        if(dividedArray[e.act]) {
            dividedArray[e.act].push(e)
        } else {
            dividedArray[e.act] = [e]
        }
    })
    for(let key in dividedArray) {
        dividedArray[key] = dividedArray[key].sort((a, b) => {
            return a.nonce - b.nonce
        })
    }
    const txOut = []
    for(let tx of preOrder) {
        txOut.push(dividedArray[tx.act].shift())
    }
    return txOut;
}


/**
 * Computes key ID of multiple keys, or passes through single key if not.
 */
export async function computeKeyId(keyGroup: Array<string>) {
    if(keyGroup.length === 1) {
        return keyGroup[0]
    } else {
        const objMap = {}
        keyGroup.forEach(e => {
            objMap[e] = null
        })
        
        return (await encodePayload(objMap)).cid.toString()
    }
}

/**
 * Converts TX format to dag JWS for verification
 */
export function convertTxJws(args: {
    sig: string
    tx: string
}) {
    const tx = Buffer.from(args.tx, 'base64url')
    const sig = DagCbor.util.deserialize(Buffer.from(args.sig, 'base64url')) as {
        __t: 'vsc-sig',
        sigs: [
            {
                alg: string
                kid: string
                sig: Buffer
            }
        ]
    }

    


    let jwsDag = {
        jws: {
            signatures: [
                {
                    protected: JSON.stringify({
                        alg: sig.sigs[0].alg,
                        kid: [sig.sigs[0].kid, sig.sigs[0].kid].join('#')
                    }),
                    signature: Buffer.from(sig.sigs[0].sig).toString('base64url')
                }
            ]
        },
        linkedBlock: tx
    }
    return jwsDag
}