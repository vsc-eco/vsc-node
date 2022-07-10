/**
 * The gateway controller is designed to provide an API for 3rd party secondary nodes to interface with a central tasking/queue management node.
 * This handles job creation, job assignment, job tracking, managing clustered nodes, etc.
 */
import { BadRequestException, Body, HttpCode, HttpStatus, Post, Put, Query } from '@nestjs/common'
import { Controller, Get, Param } from '@nestjs/common'
import { coreContainer } from './index'

@Controller(`/api/v1/gateway`)
export class ApiController {
  constructor() {}

  @Post('submitTransaction')
  async submitTransaction(@Body() body) {
    console.log(body)
  }
}
