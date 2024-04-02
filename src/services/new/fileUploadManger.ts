import { CID, IPFSHTTPClient } from 'kubo-rpc-client'
import { NewCoreService } from './index.js'
import type { Message, SignedMessage } from '@libp2p/interface-pubsub'
import { BlsCircuit, BlsCircuitGenerator, PartialBlsCircuit } from './utils/crypto/bls-did.js'

const REQUEST_TOPIC = 'file-upload-request'
const REQUEST_DATA_TOPIC = 'file-upload-request-data'
const RESPONSE_TOPIC = 'file-upload-response'

const AUTO_REMOVE_REQUEST_TIMEOUT_MS = 10000

const REQUIRED_VERIFIERS = 6

type FileUploadRequest = {
  cid: CID
  autoRemoveTimeout: ReturnType<typeof setTimeout>
}

type FileUploadResponseInfo =
  | { type: 'error'; cid: string; error: string }
  | {
      type: 'success'
      cid: string
      signature: { s: string; p: string }
    }
  | {
      type: 'proof'
      data: string
      signature: { sig: string; bv: string }
      epochDefinitionHiveBlock: number // just some metadata for the client to aid verification
      cid: string
    }

type FileUploadLocalResponseState = {
  circuit: PartialBlsCircuit
  sigCid: Uint8Array
}

function parseFileUploadResponseInfo(data: string): FileUploadResponseInfo {
  const parsed: unknown = JSON.parse(data)
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('Invalid File Upload Response')
  }
  if ('type' in parsed) {
    if (parsed.type === 'error') {
      if (
        'error' in parsed &&
        typeof parsed.error === 'string' &&
        'cid' in parsed &&
        typeof parsed.cid === 'string'
      ) {
        return { type: 'error', cid: parsed.cid, error: parsed.error }
      }
    } else if (parsed.type === 'success') {
      if (
        'cid' in parsed &&
        'signature' in parsed &&
        typeof parsed.cid === 'string' &&
        typeof parsed.signature === 'object' &&
        parsed.signature !== null &&
        's' in parsed.signature &&
        'p' in parsed.signature &&
        typeof parsed.signature.s === 'string' &&
        typeof parsed.signature.p === 'string'
      ) {
        return {
          type: 'success',
          cid: parsed.cid,
          signature: { s: parsed.signature.s, p: parsed.signature.p },
        }
      }
    } else if (parsed.type === 'proof') {
      if (
        'data' in parsed &&
        'signature' in parsed &&
        'cid' in parsed &&
        typeof parsed.data === 'string' &&
        typeof parsed.signature === 'object' &&
        parsed.signature !== null &&
        'sig' in parsed.signature &&
        'bv' in parsed.signature &&
        typeof parsed.signature.sig === 'string' &&
        typeof parsed.signature.bv === 'string' &&
        typeof parsed.cid === 'string' &&
        'epochDefinitionHiveBlock' in parsed &&
        typeof parsed.epochDefinitionHiveBlock === 'number'
      ) {
        return {
          type: 'proof',
          data: parsed.data,
          signature: { sig: parsed.signature.sig, bv: parsed.signature.bv },
          cid: parsed.cid,
          epochDefinitionHiveBlock: parsed.epochDefinitionHiveBlock,
        }
      }
    }
  }
  throw new Error('Invalid File Upload Response')
}

function ignoreUnsignedMessages(handler: (msg: SignedMessage) => void): (msg: Message) => void {
  return (msg) => {
    if (msg.type === 'unsigned') {
      return
    }
    return handler(msg)
  }
}

function ignoreMessagesFromSelf(
  ipfs: IPFSHTTPClient,
  handler: (msg: SignedMessage) => void,
): (msg: SignedMessage) => void {
  return async (msg) => {
    if (msg.from.equals((await ipfs.id()).id)) {
      return
    }
    return handler(msg)
  }
}

export class FileUploadManger {
  constructor(private core: NewCoreService) {}

  async start() {
    const { ipfs, config, consensusKey, electionManager, chainBridge } = this.core
    const requests = new Map<string, FileUploadRequest>()
    const responses = new Map<string, FileUploadLocalResponseState>()

    const encoder = new TextEncoder()
    const decoder = new TextDecoder()

    const lastParsed = chainBridge.streamParser.lastParsed
    const lasestEpoch = lastParsed - (lastParsed % electionManager.epochLength)

    const multisig = new BlsCircuitGenerator(await electionManager.getMembersOfBlock(lasestEpoch))
    let epochDefinitionHiveBlock: number = lasestEpoch
    // TODO remove event listener on stop
    electionManager.eventEmitter.addListener('new-epoch', ({ hive_block, members }) => {
      multisig.updateMembers(members)
      epochDefinitionHiveBlock = hive_block
    })

    // Step 1 - Queue up requests
    await ipfs.pubsub.subscribe(
      `${config.get('network.id')}-${REQUEST_TOPIC}`,
      ignoreUnsignedMessages((msg) => {
        const rawRequest: unknown = JSON.parse(decoder.decode(msg.data))

        if (
          typeof rawRequest !== 'object' ||
          rawRequest === null ||
          !('cid' in rawRequest) ||
          typeof rawRequest.cid !== 'string'
        ) {
          return
        }

        const requestKey = msg.from.toString()
        const request: FileUploadRequest = {
          cid: CID.parse(rawRequest.cid),
          autoRemoveTimeout: setTimeout(() => {
            requests.delete(requestKey)
          }, AUTO_REMOVE_REQUEST_TIMEOUT_MS),
        }
        requests.set(requestKey, request)
      }),
    )

    // Step 2 - Wait for a file from a requester with a matching peer ID
    await ipfs.pubsub.subscribe(
      `${config.get('network.id')}-${REQUEST_DATA_TOPIC}`,
      ignoreUnsignedMessages(async (msg) => {
        const request = requests.get(msg.from.toString())

        // ignore files without a corresponing request
        if (!request) {
          return
        }

        const cid = await ipfs.dag.put(msg.data, { onlyHash: true })
        if (cid.equals(request.cid)) {
          // start BLS signing to generate a signature
          const sigCid = await ipfs.dag.put({
            type: 'data-availablity',
            cid: cid.toString(),
          })
          await ipfs.pin.add(sigCid, { recursive: false })
          const signRaw = sigCid.bytes
          const sigData = await consensusKey.signRaw(signRaw)

          // pin to ipfs
          await ipfs.dag.put(msg.data)
          await ipfs.pin.add(cid, { recursive: false })

          // send response
          const resp: FileUploadResponseInfo = {
            type: 'success',
            cid: cid.toString(),
            signature: sigData,
          }
          const bls = { circuit: multisig.generate({ hash: cid.bytes }), sigCid: sigCid.bytes }
          // don't need to check verifiction result here because we know it was just signed
          await bls.circuit.addAndVerify(sigData.p, sigData.s)
          responses.set(cid.toString(), bls)
          await ipfs.pubsub.publish(
            `${config.get('network.id')}-${RESPONSE_TOPIC}`,
            encoder.encode(JSON.stringify(resp)),
          )
        } else {
          const resp: FileUploadResponseInfo = {
            type: 'error',
            // @ts-ignore cid is not never here idk what ts is talking about
            cid: request.cid.toString(),
            error: 'data does not match cid',
          }
          await ipfs.pubsub.publish(
            `${config.get('network.id')}-${RESPONSE_TOPIC}`,
            encoder.encode(JSON.stringify(resp)),
          )
        }

        // remove the request from the queue
        clearTimeout(request.autoRemoveTimeout)
        requests.delete(msg.from.toString())
      }),
    )

    // Step 3 - Coordinate with other nodes to generate a valid signed response
    await ipfs.pubsub.subscribe(
      `${config.get('network.id')}-${RESPONSE_TOPIC}`,
      ignoreUnsignedMessages(
        ignoreMessagesFromSelf(ipfs, async (msg) => {
          const respInfo: FileUploadResponseInfo = parseFileUploadResponseInfo(
            decoder.decode(msg.data),
          )

          if (respInfo.type === 'error') {
            return
          }

          if (respInfo.type === 'proof') {
            const msg = CID.parse(respInfo.data).bytes
            const proof = BlsCircuit.deserialize(
              {
                hash: msg,
                signature: respInfo.signature,
              },
              multisig.circuitMap,
            )
            if (proof.aggPubKeys.size >= REQUIRED_VERIFIERS && (await proof.verify(msg))) {
              // got a valid proof stop trying to generate a new one
              responses.delete(respInfo.cid)
            }
            return
          }

          const bls = responses.get(respInfo.cid)

          if (!bls) {
            return
          }

          // if a valid signature already exists for this cid
          // then ignore this message
          const circuit = bls.circuit.finalize()
          if (circuit.aggPubKeys.size >= REQUIRED_VERIFIERS) {
            return
          }

          // validate signature
          // if invalid then ignore this message
          const valid = bls.circuit.addAndVerify(respInfo.signature.p, respInfo.signature.s)
          if (!valid) {
            return
          }

          if (circuit.aggPubKeys.size >= REQUIRED_VERIFIERS) {
            const sig = circuit.serialize(bls.circuit.circuitMap)
            const data = await ipfs.dag.put(
              {
                type: 'data-availablity',
                cid: respInfo.cid,
              },
              { onlyHash: true },
            )
            const resp: FileUploadResponseInfo = {
              type: 'proof',
              data: data.toString(),
              signature: sig,
              cid: respInfo.cid,
              epochDefinitionHiveBlock,
            }
            // TODO submit the deployer to submit to blockchain in create contract call
            await ipfs.pubsub.publish(
              `${config.get('network.id')}-${RESPONSE_TOPIC}`,
              encoder.encode(JSON.stringify(resp)),
            )
            return
          }
        }),
      ),
    )
  }
}
