
export interface logEntry {

    type: string
    target?: Array<string>
    input_status: "unpaid" | "paid"
    out_status: "unprocessed" | "distributed"

    unit: string | "HBD" | "HIVE"
    amount: number
    reference_id?: string
}


/**
 * This system 
 */
export class AccountingSystem {

    
    async processTx() {

    }

    async mockstruct() {

    }

    async start() {

    }
}