/**
 * The gateway controller is designed to provide an API for 3rd party secondary nodes to interface with a central tasking/queue management node.
 * This handles job creation, job assignment, job tracking, managing clustered nodes, etc.
 */
import { TransactionDbStatus } from '../../types'
import { unwrapDagJws } from '../../utils'
import { BadRequestException, Body, HttpCode, HttpStatus, Post, Put, Query } from '@nestjs/common'
import { Controller, Get, Param } from '@nestjs/common'
import { ObjectId } from 'bson'
import { CID } from 'kubo-rpc-client'
import { appContainer } from './index'
import winston from 'winston'
import { getLogger } from '../../logger'

@Controller(`/api/v1/gateway`)
export class ApiController {
  logger: winston.Logger

  constructor() {
    this.logger = getLogger({
      prefix: 'api controller',
      printMetadata: true,
      level: 'debug',
    })
  }
}
