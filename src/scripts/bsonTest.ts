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

const honak = EJSON.serialize(baseObj)
console.log(JSON.stringify(honak))
console.log(EJSON.deserialize(honak))
const observe = jsonpatch.observe(honak)
honak.date2 = {"$date":"2022-12-19T02:44:49.769Z"}
console.log(jsonpatch.generate(observe))