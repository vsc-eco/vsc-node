import {
    ActivityType,
    Client,
    EmbedBuilder,
    GatewayIntentBits,
    Message,
    Partials,
    APIEmbedField
  } from 'discord.js'
import { Table } from 'embed-table';
import { CoreService } from '.'
import { HiveClient } from '../utils'
  
  export class DiscordBot {
    client: Client<boolean>
    self: CoreService
  
    constructor(self: CoreService) {
      this.self = self
  
      this.handleMessage = this.handleMessage.bind(this)
    }
  
  
    async handleMessage(msg: Message<boolean>) {
      if(msg.content.startsWith('!witnesslag')) {

        const table = new Table({
          titles: ['Level', 'Money', 'Wins'],
          titleIndexes: [0, 8, 16],
          columnIndexes: [0, 6, 14],
          start: '',
          end: '',
          padEnd: 3
        });
        
        table.addRow(['1', '$120', '2'], { override: 4 });
        table.addRow(['72', '$10', '25'], { override: 0 });
        table.addRow(['614', '$1220', '12']);

        const embed = new EmbedBuilder().setFields(table.toField());

          embed.setColor(0x0099ff).setTitle('VSC')
          msg.channel.send({ content: 'VSC Status', embeds: [embed] })
        
        return;
      }
      if (msg.content.startsWith('!tx')) {
        const [origin, arg, arg2] = msg.content.split(' ')
  
        const embedFields:Array<APIEmbedField> = []
         
        console.log(arg)
        // const txData = await this.self.transactionPool.transactionPool.findOne({
        //     id: arg
        // })
        // console.log(txData)
        // if(txData) {
        //     if(arg2 === "blockinfo") {
        //         const blockInfo = await this.self.chainBridge.blockHeaders.findOne({id:txData.included_in})

        //         console.log(blockInfo)
        //         const tx = await HiveClient.database.getTransaction(blockInfo.hive_ref_tx)
        //         const witnessName = tx.operations[0][1].required_posting_auths[0]
        //         console.log(witnessName)

        //         return;
        //     }
        //     embedFields.push({
        //         name: "status",
        //         value: txData.status,
        //         inline: true
        //     })
        //     embedFields.push({
        //         name: "Sender",
        //         value: `\`${txData.account_auth}\``,
        //         inline: true
        //     })
        //     embedFields.push({
        //         name: "Op type",
        //         value: txData.op,
        //         inline: true
        //     })
        //     embedFields.push({
        //         name: "Included in",
        //         value: txData.included_in,
        //         inline: true
        //     })
        //     if(txData.headers.contract_id) {
        //         embedFields.push({
        //             name: "contract_id",
        //             value: txData.headers.contract_id,
        //             inline: true
        //         })
        //     }
        // }
        //   console.log(nodeScores)
        //   for(let field in nodeScores) {
        //   }
        //   embedFields.push({
        //       name: "peer_id",
        //       value: nodeOwner.peer_id
        //   })
        //   embedFields.push({
        //       name: "Name",
        //       value: nodeOwner.name
        //   })
        //   embedFields.push({
        //       name: "last_seen",
        //       value: `${nodeOwner.last_seen.toISOString()}`
        //   })
        //   embedFields.push({
        //       name: "first_seen",
        //       value: `${nodeOwner.first_seen.toISOString()}`
        //   })
        //   embedFields.push({
        //       name: "Hive owner",
        //       value: `${nodeOwner.cryptoAccounts.hive}`
        //   })
          const embed = new EmbedBuilder()
          embed.setColor(0x0099ff).setTitle('VSC').addFields(...embedFields)
          msg.channel.send({ content: 'VSC Status', embeds: [embed] })
        
      }
    }
  
    async start() {
      this.client = new Client({
        intents: [
          GatewayIntentBits.Guilds,
          GatewayIntentBits.GuildMessages,
          GatewayIntentBits.MessageContent,
          GatewayIntentBits.DirectMessages,
          GatewayIntentBits.DirectMessageReactions,
          GatewayIntentBits.DirectMessageTyping,
        ],
        partials: [Partials.Channel],
      })
      if(process.env.DISCORD_TOKEN) {
          await this.client.login(process.env.DISCORD_TOKEN)
          await this.client.user.setPresence({
            activities: [{ name: 'Monitoring VSC transactions!' }],
            status: 'online',
          })
          this.client.on('messageCreate', this.handleMessage)
      }
    }
  }
  