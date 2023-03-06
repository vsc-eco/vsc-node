/**
 * The gateway controller is designed to provide an API for 3rd party secondary nodes to interface with a central tasking/queue management node.
 * This handles job creation, job assignment, job tracking, managing clustered nodes, etc.
 */
import { BadRequestException, Body, HttpCode, HttpStatus, Post, Put, Query } from '@nestjs/common'
import { Controller, Get, Param } from '@nestjs/common'
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
      link: CID.parse(signedTx.jws['link']['/'].toString()) //Glich with dag.put not allowing CIDs to link
    })
    console.log(cid)
    await appContainer.self.ipfs.block.put(Buffer.from(Object.values(signedTx.linkedBlock as any) as any), {
      format: 'dag-cbor'
    })
  }
}
