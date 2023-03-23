import path from 'path'
import _get from 'dlv'
import mergeOptions from 'merge-options'
import { Key } from 'interface-datastore'
import { FsDatastore } from 'datastore-fs'
import fs from 'fs'

function obj_set(obj, props, value) {
  if (typeof props == 'string') {
    props = props.split('.')
  }
  if (typeof props == 'symbol') {
    props = [props]
  }
  const lastProp = props.pop()
  if (!lastProp) {
    return false
  }
  let thisProp
  while ((thisProp = props.shift())) {
    if (typeof obj[thisProp] == 'undefined') {
      obj[thisProp] = {}
    }
    obj = obj[thisProp]
    if (!obj || typeof obj != 'object') {
      return false
    }
  }
  obj[lastProp] = value
  return true
}
class ChildConfig {
  rootKey: any
  parentConfig: any
  constructor(parentConfig, rootKey) {
    this.parentConfig = parentConfig
    this.rootKey = rootKey
  }
  /**
   *
   * @param {String} key
   */
  get(key) {
    return this.parentConfig.get(`${this.rootKey}.${key}`)
  }
  /**
   *
   * @param {String} key
   * @param {*} value
   */
  set(key, value) {
    return this.parentConfig.set(`${this.rootKey}.${key}`, value)
  }
}
export class Config {
  config: any
  datastore: any
  modules: {}
  obj_set: (obj: any, props: any, value: any) => boolean
  path: string
  constructor(datastore) {
    if (typeof datastore === 'string') {
      this.datastore = new FsDatastore(datastore, {
        extension: '',
      })
    } else {
      this.datastore = datastore
    }

    this.modules = {}
    this.obj_set = obj_set
    this.get = this.get.bind(this)
    this.set = this.set.bind(this)
  }
  reload() {
    const buf = fs.readFileSync(this.path).toString()
    const obj = JSON.parse(buf)
    //patch
    this.config = mergeOptions(this.config, obj)
  }
  save() {
    const buf = Buffer.from(JSON.stringify(this.config, null, 2))
    this.datastore.put(new Key('config'), buf)
  }
  /**
   *
   * @param {String} key
   */
  get(key) {
    if (typeof key === 'undefined') {
      return this.config
    }
    if (typeof key !== 'string') {
      return new Error('Key ' + key + ' must be a string.')
    }
    return _get(this.config, key)
  }
  /**
   *
   * @param {String} key
   * @param {*} value
   */
  set(key, value) {
    obj_set(this.config, key, value)
    this.save()
  }
  async open() {
    if (!(await this.datastore.has(new Key('config')))) {
      this.init()
      return
    }
    const buf = await this.datastore.get(new Key('config'))
    this.config = JSON.parse(buf.toString())
  }
  child(key) {
    return new ChildConfig(this, key)
  }
  /**
   * Creates config with default settings
   * @param {Object} config custom config object
   */
  async init(config?) {
    const defaultConfig = {
      network: {
        id: 'testnet/ab8b6cf1-b344-4ad3-8f81-f2d72c61f6b2',
      },
      identity: {
        nodePrivate: null,
        nodePublic: null,
        walletPrivate: null,
        walletPublic: null,
      },
      //Contract executor
      witness: {
        enabled: false,
        batchExecutionSize: 100 // pla: max amount of tx to process in a single batch execution
        // is kinda a constant so it doesnt really belong here - maybe have a "version"/ "runtime params" data model
        // that houses constants for the current version of vsc which is propagated throughout the nodes,
        // so in theory you could dynamically adjust constant parameters for eg performance or something reasons (peaks/ lows in usage)
      },
      node: {
        storageType: "archive" //For now until chain state is properly replicated across many nodes.
      },
      ipfs: {
        apiAddr: '/ip4/127.0.0.1/tcp/5001',
      },
    }

    this.config = config || defaultConfig
    this.save()
  }
}
