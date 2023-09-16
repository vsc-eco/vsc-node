// do deposit with very low amount of hive

import { withdraw } from "../transactions/withdraw";
import { deposit } from "../transactions/deposit";
import { HiveClient } from "../utils";
import { getBalance } from "./test-utils";

export async function depositWithdrawWorkflowTest() {
    const originalBalance = getBalance()
    let originalArgs = process.argv;

    process.argv = [
        ...originalArgs,
        // '--contract_id=Qmf9AN5ToxZ5Ck1GUikv4nvzNQoVxcBJ8iQGk4cM6jeNyR',
        // '--to=sudokurious',
        '0.001'
    ]
    const resultDeposit = await deposit()

    // TODO in a loop with sleep, check if the deposit is confirmed in the _BalanceDB_

    process.argv = [
        ...originalArgs,
        // '--contract_id=Qmf9AN5ToxZ5Ck1GUikv4nvzNQoVxcBJ8iQGk4cM6jeNyR',
        // '--to=sudokurious',
        '0.001'
    ]
    const resultWithdraw = withdraw()

    // TODO in a loop with sleep, check if the withdraw is confirmed in the _BalanceDB_

    const finalBalance = getBalance()

    if (finalBalance !== originalBalance) {
        console.error('depositWithdrawWorkflowTest failed, final balance is not the same as original balance')
    }
}

// go into a wait loop until the deposit is confirmed

// do withdraw with same amount of hive

// go into a wait loop until the withdraw is confirmed

// check if the amount of hive is the same as before