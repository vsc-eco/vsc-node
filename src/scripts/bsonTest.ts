import { getLogger } from "../logger";
import { EJSON } from "bson";
import jsonpatch from 'fast-json-patch'

let baseObj = {
    "test": "string",
    date: new Date(),
    info: 15,
    subObj: {
        hello: "world"
    }
} as any

const logger = getLogger({
    prefix: 'bson test',
    printMetadata: true,
    level: 'debug',
})

const honak = EJSON.serialize(baseObj)
logger.info(JSON.stringify(honak))
logger.info(EJSON.deserialize(honak))
const observe = jsonpatch.observe(honak)
honak.date2 = {"$date":"2022-12-19T02:44:49.769Z"}
logger.info(jsonpatch.generate(observe))