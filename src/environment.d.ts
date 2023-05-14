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
  }
}

export {}
