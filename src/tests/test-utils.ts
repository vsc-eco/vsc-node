import { HiveClient } from "../utils";

export async function getBalance() {
    const [account] = await HiveClient.database.getAccounts([process.env.HIVE_ACCOUNT]);
    return +(account.balance as string).split(' ')[0];
}