// do deposit with very low amount of hive

import { withdraw } from "../transactions/withdraw";
import { deposit } from "../transactions/deposit";
import { HiveClient, createMongoDBClient, sleep } from "../utils";
import { getBalance } from "./test-utils";
import { init } from "../transactions/core";

export async function depositWithdrawWorkflowTest(nodeUrl: string) {
    const execGraphQlQuery = async (query: string, validateFunction: (data: object) => boolean) => {
        while (true) {
            await sleep(5_000)
            try {
                const response = await fetch(`${nodeUrl}/api/v1/graphql`, {
                    method: 'POST',   
                    headers: {
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify({
                        query: query
                    })
                })
                const data = await response.json(); 
                if (validateFunction(data)) {
                    break
                }
            } catch (error) {
                console.log('database not in desired state, yet')
            }
            if (isCancelled) {
                return false 
            }
        }
        
        return true
    }

    const waitForDepositConfirmation = async (depositId: string) => {
        return await execGraphQlQuery(`{
            findDeposit(id: "${depositId}") {
                id
            }
        }`, 
        (data: any) => data.data.findDeposit.id === depositId);
    }

    const waitForBalanceDrain = async (depositId: string, desiredActiveBalance: number) => {
        return await execGraphQlQuery(`{
            findDeposit(id: "${depositId}") {
                active_balance
            }
        }`, 
        (data: any) => data.data.findDeposit.active_balance === desiredActiveBalance);
    }

    const setup: {identity, config, ipfsClient, logger} = await init()

    // timeout in case of error
    const timeoutPeriod = 1000 * 60 * 5
    let isCancelled = false
    setTimeout(() => isCancelled = true, timeoutPeriod)

    const originalBalance = getBalance()
    let originalArgs = process.argv;

    process.argv = [
        ...originalArgs,
        // '--contract_id=Qmf9AN5ToxZ5Ck1GUikv4nvzNQoVxcBJ8iQGk4cM6jeNyR',
        // '--to=sudokurious',
        '0.001'
    ]
    const resultDeposit = await deposit(setup)

    if (!await waitForDepositConfirmation(resultDeposit.id)) {
        console.error('depositWithdrawWorkflowTest failed, took too long to finish')
        return false
    }

    process.argv = [
        ...originalArgs,
        // '--contract_id=Qmf9AN5ToxZ5Ck1GUikv4nvzNQoVxcBJ8iQGk4cM6jeNyR',
        // '--to=sudokurious',
        '0.001'
    ]
    const resultWithdraw = await withdraw(setup)

    if (!await waitForDepositConfirmation(resultWithdraw.id)) {
        console.error('depositWithdrawWorkflowTest failed, took too long to finish')
        return false
    }

    // wait until multisig nodes have processed the withdraw request
    await waitForBalanceDrain(resultWithdraw.id, 0)

    const finalBalance = getBalance()

    if (finalBalance !== originalBalance) {
        console.error('depositWithdrawWorkflowTest failed, final balance is not the same as original balance')
        return false
    }

    return true
}