/*!
 * This file is part of kale-miner.
 * Author: Fred Kyung-jin Rezeau <fred@litemint.com>
 */

const { SorobanRpc, Horizon, xdr, Address, Operation, Asset, Contract, Networks, TransactionBuilder, StrKey, Memo, Keypair, nativeToScVal, scValToNative } = require('@stellar/stellar-sdk');
const config = require(process.env.CONFIG || './config.json');
const rpc = new SorobanRpc.Server(process.env.RPC_URL || config.stellar?.rpc, { allowHttp: true });
const horizon = new Horizon.Server(config.stellar?.horizon || 'https://horizon.stellar.org', { allowHttp: true });
const contractId = config.stellar?.contract;
const fees = config.stellar?.fees || 10000000;

const signers = config.farmers.reduce((acc, farmer) => {
    const keypair = Keypair.fromSecret(farmer.secret);
    const publicKey = keypair.publicKey();
    acc[publicKey] = {
        secret: farmer.secret,
        stake: farmer.stake || 0,
        difficulty: farmer.difficulty,
        minWorkTime: farmer.minWorkTime || 0,
        harvestOnly: farmer.harvestOnly || false,
        stats: { fees: 0, amount: 0, gaps: 0, workCount: 0, harvestCount: 0, feeCount: 0, diffs: 0 }
    };
    return acc;
}, {});

const blockData = {
    hash: null,
    block: 0
};

const balances = {}
const session = { log: [] };

const contractErrors = Object.freeze({
    1: 'HomesteadExists',
    2: 'HomesteadMissing',
    3: 'FarmBlockMissing',
    4: 'FarmPaused',
    5: 'FarmNotPaused',
    6: 'PlantAmountTooLow',
    7: 'ZeroCountTooLow',
    8: 'PailExists',
    9: 'PailMissing',
    10: 'WorkMissing',
    11: 'BlockMissing',
    12: 'BlockInvalid',
    13: 'HashInvalid',
    14: 'HarvestNotReady',
    15: 'GapCountTooLow'
});

const getError = (error) => {
    return contractErrors[parseInt((msg = error instanceof Error
        ? error.message
        : (typeof error === 'object'
            ? (JSON.stringify(error) || error.toString())
            : String(error)))
                .match(/Error\(Contract, #(\d+)\)/)?.[1] || 0, 10)] || msg; 
};

const getReturnValue = (resultMetaXdr) => {
    const txMeta = LaunchTube.isValid()
        ? xdr.TransactionMeta.fromXDR(resultMetaXdr, "base64")
        : xdr.TransactionMeta.fromXDR(resultMetaXdr.toXDR().toString("base64"), "base64");
    return txMeta.v3().sorobanMeta().returnValue();
};

async function getInstanceData() {
    const result = {};
    try {
        const { val } = await rpc.getContractData(
            contractId,
            xdr.ScVal.scvLedgerKeyContractInstance()
        );
        val.contractData()
            .val()
            .instance()
            .storage()
            ?.forEach((entry) => {
                switch(scValToNative(entry.key())[0]) {
                    case 'FarmIndex':
                        result.block = Number(scValToNative(entry.val()));
                        break;
                    case 'FarmEntropy':
                        result.hash = Buffer.from(scValToNative(entry.val())).toString('base64');
                        break;
                }
            });
    } catch (error) {
        console.error(error);
    }   
    return result;
}

async function getTemporaryData(key) {
    try {
        const data = xdr.LedgerKey.contractData(
            new xdr.LedgerKeyContractData({
                contract: new Address(contractId).toScAddress(),
                key,
                durability: xdr.ContractDataDurability.temporary(),
            })
        );
        const blockData = await rpc.getLedgerEntries(data);
        const entry = blockData.entries?.[0];
        if (entry) {
            return scValToNative(entry.val?._value.val());
        }
    } catch (error) {
        console.error(error);
    }
}

async function getPail(address, block) {
    const data = await getTemporaryData(xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("Pail"),
        new Address(address).toScVal(),
        nativeToScVal(Number(block), { type: "u32" })]));
    return data;
}

async function setupAsset(farmer) {
    const issuer = config.stellar?.assetIssuer;
    const code = config.stellar?.assetCode;
    if (code?.length && StrKey.isValidEd25519PublicKey(issuer)) {
        const account = await horizon.loadAccount(farmer);
        if (!account.balances.some(balance => 
            balance.asset_code === code && balance.asset_issuer === issuer
        )) {
            const transaction = new TransactionBuilder(account, { fee: fees.toString(), networkPassphrase: config.stellar?.networkPassphrase || Networks.PUBLIC })
                .addOperation(Operation.changeTrust({
                    asset: new Asset(code, issuer)
                }))
                .setTimeout(300)
                .build();
            transaction.sign(Keypair.fromSecret(signers[farmer].secret));
            const response = await getResponse(await rpc.sendTransaction(transaction));
            if (response.status !== 'SUCCESS') {
                throw new Error(`tx Failed: ${response.hash}`);
            }
            console.log(`Trustline set for ${farmer} to ${code}:${issuer}`);
        }
        const native = account.balances.find(balance => balance.asset_type === 'native')?.balance || '0';
        const asset = account.balances.find(balance => balance.asset_code === code && balance.asset_issuer === issuer);
        balances[farmer] = { XLM: native, [code]: asset?.balance || '0' };
        console.log(`Farmer ${farmer} balances: ${asset?.balance || 0} ${code} | ${native} XLM`);
    }
}

async function getResponse(response, launchTube) {
    const txId = response.hash;
    if (!launchTube) {
        while (response.status === "PENDING" || response.status === "NOT_FOUND") {
            await new Promise(resolve => setTimeout(resolve, 2000));
            response = await rpc.getTransaction(txId);
        }
    }
    if (config.stellar?.debug) {
        console.log(response);
    }
    response.feeCharged = (response.feeCharged || response.resultXdr?._attributes?.feeCharged || 0).toString();
    return response;
}

async function hoard() {
    const { account: destination, percent, memo } = config.hoard || {};
    const { assetCode: code, assetIssuer: issuer, networkPassphrase, debug } = config.stellar || {};
    if (+percent > 0 && +percent <= 100
        && code?.length && StrKey.isValidEd25519PublicKey(destination) && StrKey.isValidEd25519PublicKey(issuer)) {
        let builder;
        let totalSent = 0;
        for (const key in signers) {
            const account = await horizon.loadAccount(key);
            const amount = Math.floor(Number(account.balances.find(balance => balance.asset_code === code && balance.asset_issuer === issuer)?.balance || 0) * 0.01 * percent).toString();
            totalSent += +amount;
            builder ??= new TransactionBuilder(account, { fee: fees.toString(), networkPassphrase: networkPassphrase || Networks.PUBLIC });
            builder.addOperation(Operation.payment({ destination, asset: new Asset(code, issuer),
                amount,
                source: key }));
        }

        if (memo) {
            builder.addMemo(Memo.text(memo))
        }

        const transaction = builder.setTimeout(300).build();
        Object.values(signers).forEach(s => transaction.sign(Keypair.fromSecret(s.secret)));

        const response = await getResponse(await rpc.sendTransaction(transaction));
        const hash = transaction.hash().toString('hex');
        if (debug) console.log(response);
        if (response.status !== 'SUCCESS') {
            throw new Error(`tx Failed: ${hash}`);
        }
        return { hash, totalSent };
    }
}

async function invoke(method, data) {
    const farmer = signers[data.farmer] || {};
    if (!StrKey.isValidEd25519SecretSeed(farmer.secret)) {
        console.error("Unauthorized:", data.farmer);
        return null;
    }

    let args, source, params;
    const contract = new Contract(data.contract || contractId);
    switch (method) {
        case 'plant':
            args = contract.call('plant', new Address(data.farmer).toScVal(),
                nativeToScVal(data.amount, { type: 'i128' }));
            params = `with ${(data.amount / 10000000).toFixed(7)} KALE`;
            break;
        case 'work':
            args = contract.call('work', new Address(data.farmer).toScVal(), xdr.ScVal.scvBytes(Buffer.from(data.hash, 'hex')),
                nativeToScVal(data.nonce, { type: 'u64' }));
            params = `with ${data.hash}/${data.nonce}`;
            break;
        case 'harvest':
            source = StrKey.isValidEd25519SecretSeed(config.harvester?.account) ? Keypair.fromSecret(config.harvester?.account) : null;
            await setupAsset(data.farmer);
            args = contract.call('harvest', new Address(data.farmer).toScVal(),
                nativeToScVal(data.block, { type: 'u32' }));
            params = `for block ${data.block}`;
            break;
        case 'tractor':
            source = StrKey.isValidEd25519SecretSeed(config.harvester?.account) ? Keypair.fromSecret(config.harvester?.account) : null;
            await setupAsset(data.farmer);
            args = contract.call('harvest', new Address(data.farmer).toScVal(),
                nativeToScVal(data.blocks, { type: 'u32' }));
            params = `for blocks ${data.blocks}`;
            break;
    }

    const isLaunchTube = LaunchTube.isValid();
    let transaction = new TransactionBuilder(await rpc.getAccount(source?.publicKey() || data.farmer), { 
        fee: isLaunchTube ? '0' : fees.toString(),
        networkPassphrase: config.stellar?.networkPassphrase || Networks.PUBLIC
    }).addOperation(args).setTimeout(isLaunchTube ? 30 : 300).build();

    const sim = await rpc.simulateTransaction(transaction);
    if (config.stellar?.debug && sim.error) {
        console.error(JSON.stringify(sim.error));
    }
    transaction = SorobanRpc.assembleTransaction(transaction, sim).build();
    transaction.sign(Keypair.fromSecret(source?.secret() || farmer.secret));

    if (config.stellar?.debug) {
        console.log(transaction.toEnvelope().toXDR('base64'));
    }

    session.log.push({ stamp: Date.now(), msg: `Farmer ${data.farmer.slice(0, 4)}..${data.farmer.slice(-6)} invoked '${method}' ${params}`});
    session.log = session.log.slice(-50);

    if (isLaunchTube) {
        return await getResponse(await LaunchTube.send(transaction.toEnvelope().toXDR('base64'),
            config.stellar?.launchtube?.fees || transaction.fee, method), true);
    } else {
        return await getResponse(await rpc.sendTransaction(transaction));
    }
}

class LaunchTube {
    static isValid() {
        const jwt = /^[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+$/;
        return config.stellar?.launchtube?.url
            && jwt.test(config.stellar?.launchtube?.token)
            && config.stellar.launchtube.token.length > 30;
    }

    static async checkCredits(fee, headers, method) {
        const res = await fetch(config.stellar.launchtube.url + '/info', { method: 'GET', headers });
        if (!res.ok) {
            throw new Error('Launchtube: Could not retrieve token info');
        }
        const credits = Number((await res.json())?.credits || 0);
        session.launchTube = true;
        session.credits = credits / 10000000;
        console.log(`Launchtube: ${session.credits} XLM credits remaining`);
        if (method === 'plant'
            && credits < Math.max(config.stellar?.launchtube?.harvestReserve ?? 1000000, Number(fee))) {
            (config.harvester ??= {}).harvestOnly = true;
            console.log('Homestead harvestOnly = TRUE');
            throw new Error('Launchtube: No credits');
        }
    }

    static async send(xdr, fee, method) {
        const headers = {
            'Authorization': `Bearer ${config.stellar.launchtube.token}`,
            'X-Client-Name': 'cpp-kale-miner',
            'X-Client-Version': '1.0.0'
        };

        await this.checkCredits(fee, headers, method);

        const data = new FormData();
        data.append('xdr', xdr);
        data.append('fee', fee.toString());
        data.append('sim', false);
        const res = await fetch(config.stellar.launchtube.url, {
            method: 'POST',
            headers,
            body: data
        });
        if (res.ok) {
            return await res.json();
        } else {
            const errorText = await res.text();
            console.error(`Launchtube: Error ${res.status}:`, errorText);
            throw new Error(`Launchtube: ${errorText}`);
        }
    }
}

module.exports = { getInstanceData, getTemporaryData, getPail, getError, getReturnValue, invoke, hoard, LaunchTube, rpc, horizon, contractId, contractErrors, signers, blockData, balances, session };
