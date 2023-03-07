/**
 * The gateway controller is designed to provide an API for 3rd party secondary nodes to interface with a central tasking/queue management node.
 * This handles job creation, job assignment, job tracking, managing clustered nodes, etc.
 */
import { TransactionDbStatus } from '../../types'
import { unwrapDagJws } from '../../utils'
import { BadRequestException, Body, HttpCode, HttpStatus, Post, Put, Query } from '@nestjs/common'
import { Controller, Get, Param } from '@nestjs/common'
import { ObjectId } from 'bson'
import { CID } from 'ipfs-http-client'
import { appContainer } from './index'

@Controller(`/api/v1/gateway`)
export class ApiController {
  constructor() {}

  @Post('submit_transaction')
  async submitTransaction(@Body() body) {
    console.log(body)
    const signedTx = body.signedTx
    const cid = await appContainer.self.ipfs.dag.put({
      ...signedTx.jws,
      link: CID.parse(signedTx.jws['link']['/'].toString()), //Glich with dag.put not allowing CIDs to link
    })
    console.log(cid)
    await appContainer.self.ipfs.block.put(
      Buffer.from(Object.values(signedTx.linkedBlock as any) as any),
      {
        format: 'dag-cbor',
      },
    )

    const dagJws = await appContainer.self.ipfs.dag.get(cid)

    const decodedContent = await unwrapDagJws(
      dagJws.value,
      appContainer.self.ipfs,
      appContainer.self.identity,
    )

    console.log(decodedContent)

    await appContainer.self.transactionPool.transactionPool.insertOne({
      _id: new ObjectId(),
      id: cid.toString(),
      op: decodedContent.content.tx.op,
      account_auth: decodedContent.auths[0],
      local: true,
      lock_block: null,
      first_seen: new Date(),
      status: TransactionDbStatus.unconfirmed,
      type: 1, //Pull from transaction in the future
      accessible: true,

      included_in: null,
      executed_in: null,
      output: null,
      headers: {
        contract_id: decodedContent.content.tx.contract_id,
      },
    })

    return {
      id: cid.toString(),
    }
  }
}
