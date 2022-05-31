async function startup(): Promise<void> {
  console.log(`startup`)
}

void startup()

process.on('unhandledRejection', (error: Error) => {
  console.log('unhandledRejection', error.message)
})
