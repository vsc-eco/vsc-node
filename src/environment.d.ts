declare global {
  namespace NodeJS {
    interface ProcessEnv {
      HIVE_ACCOUNT: string
      HIVE_ACCOUNT_POSTING: string
      HIVE_ACCOUNT_ACTIVE: string
      MULTISIG_ACCOUNT: string
      MULTISIG_ANTI_HACK: string
      MULTISIG_ANTI_HACK_KEY: string
    }
    interface Global {
      state: {
        pull(key: string): Promise<any>
        update(key: string, value: any): Promise<void>
      }
    }
    type workplease = "test"
    
  }
}

interface StateInterface {
  pull(key: string): Promise<any>
  update(key: string, value: any): Promise<void>
  ls(key: string): Promise<Array<string>>
}
interface APInterface {
  input: {
    sender: {
      type: "DID",
      id: string
    },
    tx_id: string,
    included_in: string
  }
}

type actions = Record<string, Function>

declare global {
  var state: StateInterface 
  var actions: actions
  var api: APInterface
}

export {}
