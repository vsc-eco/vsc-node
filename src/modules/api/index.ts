
import { Module } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger'
import { graphqlHTTP } from 'express-graphql'
import { buildSchema } from 'graphql'
import { IPFSHTTPClient } from 'ipfs-http-client'
import { CoreService } from '../../services/index'
import { ApiController } from './api.controller'
import { Resolvers } from './graphql/resolvers'
import { schema } from './graphql/schema'

export const ipfsContainer: { self: IPFSHTTPClient } = {} as any
export const coreContainer: { self: CoreService } = {} as any

export const INDEXER_API_BASE_URL = '/api/v0/node'

@Module({
  imports: [],
  controllers: [ApiController],
  providers: [],
})
class ControllerModule {}

/**
 * see api requirements here https://github.com/3speaknetwork/research/discussions/3
 */
export class ApiModule {
  constructor(
    private readonly listenPort: number,
    private readonly self: CoreService
  ) {
    coreContainer.self = self;
  }

  public async listen() {
    const app = await NestFactory.create(ControllerModule)

    const swaggerconfig = new DocumentBuilder().setTitle('SPK encoder node').build()
    const swaggerDocument = SwaggerModule.createDocument(app, swaggerconfig)
    SwaggerModule.setup('swagger', app, swaggerDocument)
    app.use(
      '/api/v1/graphql',
      graphqlHTTP({
        schema: buildSchema(schema),
        graphiql: true,
        rootValue: Resolvers,
      }),
    )

    await app.listen(this.listenPort)
  }
}
