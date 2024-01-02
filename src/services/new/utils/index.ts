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