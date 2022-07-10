import { MongoClient } from 'mongodb'
import 'dotenv/config'


const MONGO_HOST = process.env.MONGO_HOST || '127.0.0.1:27017'

export const MONGODB_URL = `mongodb://${MONGO_HOST}`
export const mongo = new MongoClient(MONGODB_URL)