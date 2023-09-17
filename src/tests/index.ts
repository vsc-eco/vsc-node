import { depositWithdrawWorkflowTest } from "./depositWithdrawWorkflowTest"

void (async () => {
    const nodeUrl = process.argv[2] || 'http://localhost:1337'

    const tests = [
        await depositWithdrawWorkflowTest(nodeUrl)
    ]

    console.log(`${tests.filter(e => e).length} tests passed out of ${tests.length}`)
})()