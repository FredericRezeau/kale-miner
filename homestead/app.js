/*!
 * This file is part of kale-miner.
 * Author: Fred Kyung-jin Rezeau <fred@litemint.com>
 */

const express = require('express');
const cors = require('cors');
const { xdr, StrKey, nativeToScVal, scValToNative } = require('@stellar/stellar-sdk');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const routes = require('./routes');
const config = require(process.env.CONFIG || './config.json');
const strategy = require('./strategy.js');
const { signers, blockData, session, invoke, getError, getReturnValue, getInstanceData, getTemporaryData, getPail } = require('./contract');
const { Harvester, parseRange } = require('./harvester');
const app = express();
const PORT = process.env.PORT || 3002;
const pollInterval = 5 * 1000;
let elapsedBlock = 0;

app.use(cors());

const FarmerStatus = Object.freeze({
    PLANTING: 1,
    WORKING: 2,
    IDLE: 4
});

const deepCopy = obj => JSON.parse(JSON.stringify(obj,
    (_key, value) => typeof value === 'bigint' ? value.toString() : value));

async function plant(key, blockData, next) {
    const data = deepCopy(blockData);
    data.block = data.block + (next ? 1 : 0);
    try {
        if (signers[key].status !== FarmerStatus.PLANTING) {
            return;
        }
        const status = await getPail(key, data.block);
        if (!status) {
            const amount = (await strategy.stake(key, data)) || signers[key].stake || 0;
            const response = await invoke('plant', { farmer: key, amount });
            if (response.status !== 'SUCCESS') {
                throw new Error(`tx Failed: ${response.hash}`);
            }
            const fee = Number(response.feeCharged || 0);
            signers[key].stats.fees += fee;
            signers[key].stats.feeCount += 1;
            signers[key].stats.minFee = Math.min(signers[key].stats.minFee || Number.MAX_VALUE, fee);
            signers[key].stats.maxFee = Math.max(signers[key].stats.maxFee || 0, fee);
            signers[key].stats.stake = Number(amount) / 10000000;
            signers[key].stats.stakeBlock = blockData.block;
            signers[key].stats.minStake = Math.min(signers[key].stats.minStake || Number.MAX_VALUE, signers[key].stats.stake);
            signers[key].stats.maxStake = Math.max(signers[key].stats.maxStake || 0, signers[key].stats.stake);
            console.log(`Farmer ${key} planted ${blockData.block} with ${Number(amount) / 10000000} KALE`);
        }
    } catch(err) {
        const error = getError(err);
        console.error(`Farmer ${key} could not plant ${data.block} (next: ${next}): ${error}`);
        await new Promise(resolve => setTimeout(resolve, pollInterval));
    }
}
async function work(mining, key, blockData, onStart) {
    if (signers[key].status !== FarmerStatus.WORKING) {
        return;
    }
    const {
        difficulty,
        nonce,
        gpu,
        maxThreads,
        batchSize,
        verbose,
        device,
        platform,
        executable,
        continuous
    } = config.miner;

    if (mining && (!signers[key].work || continuous)) {
        try {
            const workDiff = signers[key].work?.difficulty ? signers[key].work.difficulty + 1 : 0;
            const workNonce = signers[key].work?.nonce ? signers[key].work.nonce + 1 : 0;
            const diff = workDiff || (await strategy.difficulty(key, deepCopy(blockData))) || signers[key].difficulty || difficulty || 6;
            const { work } = await mine(executable, blockData.block, blockData.hash, workNonce || nonce,
                diff, key, maxThreads, batchSize, platform, device, gpu, verbose, onStart);
            signers[key].work = { ...work, difficulty: diff };
            signers[key].stats.lastDiff = diff;
            signers[key].stats.minDiff = Math.min(signers[key].stats.minDiff || Number.MAX_VALUE, diff);
            signers[key].stats.maxDiff = Math.max(signers[key].stats.maxDiff || 0, diff);
            console.log(`Farmer ${key} worked [${work.hash}, ${work.nonce}] for ${blockData.block}`);
            return true;
        } catch (error) {
            if (!continuous) {
                delete signers[key].work;
            }
            const errorCode = getError(error);
            console.error(`Farmer ${key} failed to work for ${blockData.block}: ${errorCode}`);
            await new Promise(resolve => setTimeout(resolve, pollInterval));
        }
    } else if (!mining && signers[key].work) {
        try {
            const response = await invoke('work', { farmer: key, hash: signers[key].work.hash, nonce: signers[key].work.nonce });
            if (response.status !== 'SUCCESS') {
                throw new Error(`tx Failed: ${response.hash}`);
            }
            const value = Number(scValToNative(getReturnValue(response.resultMetaXdr)) || 0);
            const fee = Number(response.feeCharged || 0);
            signers[key].stats.fees += fee;
            signers[key].stats.feeCount += 1;
            signers[key].stats.minFee = Math.min(signers[key].stats.minFee || Number.MAX_VALUE, fee);
            signers[key].stats.maxFee = Math.max(signers[key].stats.maxFee || 0, fee);
            signers[key].stats.workGap = value;
            signers[key].stats.gaps += value;
            signers[key].stats.workCount += 1;
            signers[key].stats.minGap = Math.min(signers[key].stats.minGap || Number.MAX_VALUE, value);
            signers[key].stats.maxGap = Math.max(signers[key].stats.maxGap || 0, value);
            signers[key].stats.diffs += signers[key].difficulty;
            signers[key].stats.minDiff = Math.min(signers[key].stats.minDiff || Number.MAX_VALUE, signers[key].difficulty);
            signers[key].stats.maxDiff = Math.max(signers[key].stats.maxDiff || 0, signers[key].difficulty);
            console.log(`Farmer ${key} submitted work [hash: ${signers[key].work.hash}, nonce: ${signers[key].work.nonce}, gap: ${value}] for ${blockData.block}`);
        } catch(err) {
            delete signers[key].work;
            const error = getError(err);
            console.error(`Farmer ${key} could not submit work for block ${blockData.block}: ${error}`);
            await new Promise(resolve => setTimeout(resolve, pollInterval));
        }
    }
}

async function mine(minerExec, block, hash, nonce, difficulty, key, maxThreads, batchSize, platform, device, gpu, verbose, onStart = null) {

    const tmpFile = path.join(os.tmpdir(), 'kale_miner.json');
    const unserialize = () => {
        try {
            return config.miner?.serialize && fs.existsSync(tmpFile)
                ? JSON.parse(fs.readFileSync(tmpFile, 'utf-8')) : null;
        } catch {
            return null;
        }
    };
    const serialize = (data) => {
        try {
            if (config.miner?.serialize) {
                fs.writeFileSync(tmpFile, JSON.stringify(data));
            }
        } catch (err) {
            console.error(`Failed to serialize work: ${err}`);
        }
    };

    let data = unserialize();
    const farmer = data?.[key];
    if (farmer && farmer.block === block && farmer.hash === hash) {
        console.log(`Farmer ${key} using serialized mining result for block ${block}`);
        return { work: farmer.work };
    }

    return new Promise((resolve, reject) => {
        const args = [
            block, hash, nonce, difficulty, key,
            '--max-threads', maxThreads,
            '--batch-size', batchSize,
            '--device', device
        ];
        if (gpu) args.push('--gpu');
        if (verbose) args.push('--verbose');
        if (platform) {
            args.push('--platform');
            args.push(platform);
        }

        session.gpu = gpu;

        console.log(`Farmer ${key} process started with command: ${args}\n====MINING JOB=====\n`);
        let output = '';
        const miner = path.resolve(minerExec);
        const minerProc = spawn(miner, args, { cwd: path.dirname(miner) });
        if (typeof onStart === 'function') {
            onStart(minerProc);
        }
        minerProc.stdout.on('data', (data) => {
            const lines = `${data}`.split('\n');
            lines.forEach((line) => {
                if (line.trim()) {
                    console.log(line);
                    output += line + '\n';
                    if (/Hash Rate/.test(line)) {
                        session.hashrate = line.match(/([\d.]+\s*[KMGT]?H\/s)/)?.[1] || '';
                    }
                }
            });
        });

        minerProc.stderr.on('data', (data) => {
            console.error(`${data}`);
        });

        minerProc.on('close', async (code) => {
            console.log(`====END MINING JOB=====\nFarmer ${key} process completed: code(${code})`);
            try {
                const result = output.match(/{[\s\S]*?}/);
                if (result) {
                    const work = JSON.parse(result[0]);
                    data = data || {};
                    data[key] = { block, hash, work };
                    serialize(data);
                    resolve({ work });
                } else {
                    reject(new Error(`No result found`));
                }
            } catch (error) {
                reject(error);
            }
        });

        minerProc.on('error', (error) => {
            reject(error);
        });
    });
}

async function runFarm(interval) {
    session.time = Date.now();
    const asyncHarvest = StrKey.isValidEd25519SecretSeed(config.harvester?.account);
    if (asyncHarvest) {
        Harvester.run();
    }

    let count = 0;
    let harvested = false;
    while (true) {
        const result = await getInstanceData();
        if (!result?.block) {
            await new Promise(resolve => setTimeout(resolve, interval));
            continue;
        }

        const computeElapsed = () => {
            const now = BigInt(Math.floor(Date.now() / 1000));
            return Number(now - BigInt(blockData.details?.timestamp || now));
        };

        let elapsedTime = computeElapsed();
        const hasElapsed = elapsedTime > 60 * 5 + 15;
        const changed = +result.block > blockData.block;
        if (changed || hasElapsed) {
            if (changed) {
                console.log(`New block detected ${result.block}`);
                blockData.block = result.block;
                delete blockData.hash;
                const tmpData = await getTemporaryData(xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("Block"),
                nativeToScVal(Number(blockData.block), { type: "u32" })]));
                if (tmpData) {
                    blockData.hash = Buffer.from(tmpData.entropy).toString('base64');
                    delete tmpData.entropy;
                    blockData.details = tmpData;
                    console.log(`${JSON.stringify(blockData,
                        (_key, value) => typeof value === 'bigint' ? value.toString() : value)}`);
                }
            }
            if (changed || elapsedBlock !== blockData.block) {
                if (!changed) {
                    elapsedBlock = blockData.block;
                }
                for (const key in signers) {
                    console.log(`Farmer ${key} is READY`);
                    signers[key].status = FarmerStatus.PLANTING;
                    delete signers[key].work;
                }
                elapsedTime = computeElapsed();
            }
        }
        if (!harvested && config.harvester?.range) {
            harvested = true;
            const { range, count } = parseRange(config.harvester.range);
            for (const key in signers) {
                if (range) {
                    const [start, end] = range;
                    for (let block = end; block >= start; block--) {
                        console.log(`Farmer ${key} checking block ${block} for harvest`);
                        Harvester.add(key, block, Date.now());
                    }
                } else if (count) {
                    for (let i = 1; i <= count; i++) {
                        console.log(`Farmer ${key} checking block ${blockData.block - 1 - i} for harvest`);
                        Harvester.add(key, blockData.block - 1 - i, Date.now());
                    }
                }
            }
            await Harvester.flush(true);
            continue;
        }

        const { harvestOnly } = config.harvester;

        // Plant ASAP to increase returns.
        for (const key in signers) {
            if (harvestOnly || signers[key].harvestOnly) {
                continue;
            }
            await plant(key, blockData, hasElapsed);
            if (hasElapsed) {
                break;
            }
            await updateStatus(key, blockData.block);
        }

        // Harvest prev block.
        const harvestTime = ((isNaN(config.harvester?.delay) || !asyncHarvest)
            ? 0 : Date.now() + config.harvester.delay * 1000 + Math.floor(Math.random() * 20000));
        for (const key in signers) {
            Harvester.add(key, blockData.block - 1, harvestTime);
        }

        if (!asyncHarvest) {
            await Harvester.flush();
        }

        // Complete work.
        for (const key in signers) {
            elapsedTime = computeElapsed();
            if (hasElapsed) {
                break;
            }

            let killTimer, killed;
            const value = (await strategy.minWorkTime(key, deepCopy(blockData))) || signers[key].minWorkTime;
            const minWorkTime = isNaN(value) ? 0 : value;
            if ((minWorkTime - 15 > elapsedTime || !signers[key].work) && await work(true, key, blockData, (proc) => {
                if (!signers[key].work || !config.miner?.continuous) {
                    return;
                }
                const killTime = Math.max(10, (minWorkTime - elapsedTime) * 1000);
                console.log(`Farmer ${key} killing mining process in ${killTime.toFixed(2)}ms`);
                killTimer = setTimeout(() => {
                    try {
                        killed = true;
                        proc.kill('SIGTERM');
                        console.log(`Farmer ${key} killed mining process after ${killTime.toFixed(0)}ms`);
                    } catch (e) {
                        console.error(`Farmer ${key} failed to kill mining process: ${e}`);
                    }
                }, killTime);
            })) {
                if (!killed) {
                    const timeLeft = minWorkTime - elapsedTime;
                    console.log(`Farmer ${key} submitting work ${timeLeft <= 0 ? 'immediately' : `later (minimum time: ${timeLeft.toFixed(0)} sec)`}`);
                    signers[key].stats.workTime = Date.now() + Math.max(0, timeLeft * 1000);
                    signers[key].stats.workBlock = blockData.block;
                }
            }
            clearTimeout(killTimer);
            if (minWorkTime <= elapsedTime || (killed && signers[key].work)) {
                await work(false, key, blockData);
                await updateStatus(key, blockData.block);
            }
        }

        if (elapsedTime) {
            if (count === 0 || count % 7 === 0) {
                console.log(`Current block is ${blockData.block}, elapsed ${`${Math.floor(elapsedTime / 60)} min ${elapsedTime % 60} sec`}`);
            }
            count += 1;
        }

        await new Promise(resolve => setTimeout(resolve, interval));
    }
}

async function updateStatus(key, block) {
    try {
        if (signers[key].status !== FarmerStatus.IDLE) {
            const status = await getPail(key, block);
            if (status?.zeros) {
                signers[key].status = FarmerStatus.IDLE;
                logStatus(key);
            } else if (status?.sequence && signers[key].status !== FarmerStatus.WORKING) {
                signers[key].status = FarmerStatus.WORKING;
                logStatus(key);
            }
        }
    } catch(err) {
        console.error(`Farmer ${key} status check failure ${block}: ${getError(err)}`);
    }
}

function logStatus(key) {
    const labels = {
        [FarmerStatus.PLANTING]: 'PLANTING',
        [FarmerStatus.WORKING]: 'WORKING',
        [FarmerStatus.IDLE]: 'DONE'
    };
    console.log(`Farmer ${key} is ${labels[signers[key].status]}`);
}

app.use('/', routes);

app.listen(PORT, () => {
    console.log(`Homestead server running on ${PORT}`);
    runFarm(pollInterval);
});
