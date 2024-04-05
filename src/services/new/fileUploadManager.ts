import { CID } from 'kubo-rpc-client'
import { NewCoreService } from './index.js'
import type { Message, SignedMessage } from '@libp2p/interface-pubsub'

const REQUEST_TOPIC = 'file-upload-request'
const REQUEST_DATA_TOPIC = 'file-upload-request-data'
const RESPONSE_TOPIC = 'file-upload-response'

const AUTO_REMOVE_REQUEST_TIMEOUT_MS = 100000

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

function ignoreUnsignedMessages(handler: (msg: SignedMessage) => void): (msg: Message) => void {
  return (msg) => {
    if (msg.type === 'unsigned') {
      return
    }
    return handler(msg)
  }
}

export class FileUploadManager {
  constructor(private core: NewCoreService) {}

  async start() {
    const { ipfs, config, consensusKey, electionManager, chainBridge } = this.core
    const requests = new Map<string, FileUploadRequest>()

    const encoder = new TextEncoder()
    const decoder = new TextDecoder()

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
          const sigCid = await ipfs.dag.put(
            {
              type: 'data-availability',
              cid: cid.toString(),
            },
            { pin: true },
          )
          const signRaw = sigCid.bytes
          const sigData = await consensusKey.signRaw(signRaw)

          // pin to ipfs
          await ipfs.dag.put(msg.data, { pin: true })

          // send response
          const resp: FileUploadResponseInfo = {
            type: 'success',
            cid: cid.toString(),
            signature: sigData,
          }
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

    // Step 3: Let Requester construct the BLS proof client side
  }

  async stop() {
    const { ipfs, config } = this.core
    await ipfs.pubsub.unsubscribe(`${config.get('network.id')}-${REQUEST_TOPIC}`)
    await ipfs.pubsub.unsubscribe(`${config.get('network.id')}-${REQUEST_DATA_TOPIC}`)
  }
}
