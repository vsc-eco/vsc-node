
import { INestApplication, Module } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import { createSchema, createYoga } from 'graphql-yoga'
import { IPFSHTTPClient } from 'kubo-rpc-client'
import { CoreService } from '../../services/index'
import { ApiController } from './api.controller'
import { Resolvers } from './graphql/resolvers'
import { schema } from './graphql/schema'

export const ipfsContainer: { self: IPFSHTTPClient } = {} as any
export const appContainer: { self: CoreService } = {} as any

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
  app: INestApplication
  constructor(
    private readonly listenPort: number,
    private readonly self: CoreService
  ) {
    appContainer.self = self;
  }

  public async listen() {
    this.app = await NestFactory.create(ControllerModule)
    const app = this.app

    // Bring back API docs when needed. Mostly use already documented graphql
    // const swaggerconfig = new DocumentBuilder().setTitle('VSC API').build()
    // const swaggerDocument = SwaggerModule.createDocument(app, swaggerconfig)
    // SwaggerModule.setup('swagger', app, swaggerDocument)
    // app.use(
    //   '/api/v1/graphql',
    //   graphqlHTTP({
    //     schema: buildSchema(schema),
    //     graphiql: true,
    //     rootValue: Resolvers,
    //   }),
    // )

    const yoga = createYoga({
      schema:  createSchema({
        typeDefs: schema,
        resolvers: {
          Query: Resolvers
        }
      }),
      graphqlEndpoint: `/api/v1/graphql`,
      graphiql: {
        //NOTE: weird string is for formatting on UI to look OK
        // defaultQuery: /* GraphQL */ "" +
        //   "query MyQuery {\n" +
        //   " latestFeed(limit: 10) {\n" +
        //   "   items {\n" +
        //   "      ... on HivePost {\n" +
        //   "        parent_permlink\n" +
        //   "        parent_author\n" +
        //   "        title\n" +
        //   "        body\n" +
        //   "      }\n" +
        //   "    }\n"+
        //   "  }\n"
      },
    })
 
    app.use('/api/v1/graphql', yoga)

    app.enableCors();

    await app.listen(this.listenPort)
  }

  async stop() {
    await this.app.close()
  }
}
