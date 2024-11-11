/*
    MIT License
    Author: Fred Kyung-jin Rezeau <fred@litemint.com>, 2024
    Permission is granted to use, copy, modify, and distribute this software for any purpose
    with or without fee.
    THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND.
*/

#include <iostream>
#include <vector>
#include <array>
#include <cstdint>
#include <chrono>
#include <iomanip>
#include <atomic>
#include <thread>
#include <mutex>
#include <functional>
#include <sstream>
#include <algorithm>

#include "utils/keccak.h"
#include "utils/misc.h"

#define GPU_NONE 0
#define GPU_CUDA 1

#ifndef GPU
#define GPU GPU_NONE
#endif

#if GPU == GPU_CUDA
#include <cuda_runtime.h>
extern "C" int executeKernel(int deviceId, std::uint8_t* data, int dataSize, __uint128_t startNonce, int nonceOffset,
    std::uint64_t batchSize, int difficulty, int threadsPerBlock, std::uint8_t* output, __uint128_t* validNonce, bool showDeviceInfo);
#endif

static const std::uint64_t defaultBatchSize = 10000000;
static const int defaultMaxThreads = 4;
static const int hashRateInterval = 5000;
static std::atomic<bool> found(false);
static std::atomic<std::uint64_t> hashMetric(0);

bool check(const std::vector<std::uint8_t>& hash, int difficulty) {
    int zeros = 0;
    for (std::uint8_t byte : hash) {
        zeros += (byte == 0) ? 2 : ((byte >> 4) == 0 ? 1 : 0);
        if (byte != 0 || zeros >= difficulty)
            break;
    }
    return zeros >= difficulty;
}

std::vector<std::uint8_t> prepare(std::uint32_t block, __uint128_t nonce,
    const std::string& base64Hash, const std::string& miner, size_t& nonceOffset
) {
    auto blockXdr = i32ToBytes(block);
    auto nonceXdr = i128ToBytes(nonce);
    auto entropy = base64Decode(base64Hash);
    auto minerXdr = addressToXdr(miner);
    std::vector<std::uint8_t> truncated(minerXdr.end() - 32, minerXdr.end());
    std::vector<std::uint8_t> data;
    data.reserve(
        blockXdr.size() +
        nonceXdr.size() +
        entropy.size() +
        truncated.size()
    );
    data.insert(data.end(), blockXdr.begin(), blockXdr.end());
    data.insert(data.end(), nonceXdr.begin(), nonceXdr.end());
    data.insert(data.end(), entropy.begin(), entropy.end());
    data.insert(data.end(), truncated.begin(), truncated.end());
    nonceOffset = blockXdr.size();
    return data;
}

std::pair<std::vector<std::uint8_t>, __uint128_t> find(std::uint32_t block, const std::string& base64Hash,
    __uint128_t nonce, int difficulty, const std::string& miner,
    bool verbose, std::uint64_t batchSize) {
    std::uint64_t counter = 0;
    int hashRateCounter = 0;
    size_t nonceOffset = 0;
    std::vector<std::uint8_t> data = prepare(block, nonce, base64Hash, miner, nonceOffset);
    if (verbose) {
        std::cout << "[CPU] Mining batch: " << i128ToString(nonce) << " block: " << block
                  << " difficulty: " << difficulty << " hash: " << base64Hash << std::endl;
        std::cout.flush();
    }

    Keccak256 keccak;
    while (!found.load()) {
        auto nonceBytes = i128ToBytes(nonce);
        std::copy(nonceBytes.begin(), nonceBytes.end(), data.begin() + nonceOffset);

        keccak.reset();
        keccak.update(data.data(), data.size());
        std::vector<std::uint8_t> result(32);
        keccak.finalize(result.data());

        if (check(result, difficulty)) {
            return {result, nonce};
        }

        nonce++;
        counter++;
        if (counter == batchSize) {
            break;
        }

        hashRateCounter += 1;
        if (hashRateCounter == hashRateInterval) {
            hashMetric.fetch_add(hashRateCounter, std::memory_order_relaxed);
            hashRateCounter = 0;
        }
    }
    return {{}, 0};
}

void monitorHashRate(bool verbose, bool gpu) {
    auto startTime = std::chrono::high_resolution_clock::now();
    while (!found.load()) {
        std::this_thread::sleep_for(std::chrono::seconds(1));
        auto currentTime = std::chrono::high_resolution_clock::now();
        std::chrono::duration<double> elapsedTime = currentTime - startTime;
        double hashRate = gpu ? hashMetric.load() : hashMetric.load() / elapsedTime.count();
        hashMetric.store(0);
        startTime = currentTime;
        if (verbose && hashRate > 0) {
            std::cout << std::fixed << std::setprecision(2)
                      << (gpu ? "[GPU] Hash Rate: " : "[CPU] Hash Rate: ")
                      << formatHashRate(hashRate) << "\n";
            std::cout.flush();
        }
    }
}

int main(int argc, char* argv[]) {
    if (argc < 6) {
        std::cerr << "Usage: " << argv[0]
                  << " <block> <hash> <nonce> <difficulty> <miner_address>\n"
                  << "  [--max-threads <num> (default: " << defaultMaxThreads << ")]\n"
                  << "  [--batch-size <num> (default: " << defaultBatchSize << ")]\n"
                  << "  [--device <num> (default 0)] [--verbose]\n";
        return 1;
    }

    int64_t block = std::stoll(argv[1]);
    std::string hash = argv[2];
    int64_t nonce = std::stoll(argv[3]);
    int difficulty = std::stoi(argv[4]);
    std::string miner = argv[5];

    bool verbose = false;
    bool gpu = false;
    int deviceId = 0;
    std::uint64_t batchSize = defaultBatchSize;
    int maxThreads = defaultMaxThreads;
    for (int i = 6; i < argc; ++i) {
        if (std::strcmp(argv[i], "--max-threads") == 0 && i + 1 < argc) {
            maxThreads = std::stoi(argv[++i]);
        } else if (std::strcmp(argv[i], "--batch-size") == 0 && i + 1 < argc) {
            batchSize = std::stoll(argv[++i]);
        } else if (std::strcmp(argv[i], "--device") == 0 && i + 1 < argc) {
            deviceId = std::stoi(argv[++i]);
        }  else if (std::strcmp(argv[i], "--verbose") == 0) {
            verbose = true;
        } else if (std::strcmp(argv[i], "--gpu") == 0) {
        #if GPU == GPU_CUDA
            gpu = true;
        #else
            std::cerr << "GPU support not enabled in this build.\n";
            return 1;
        #endif
        }
    }

    try {
        std::thread monitorThread([=]() { monitorHashRate(verbose, gpu); });
        std::pair<std::vector<std::uint8_t>, std::uint64_t> result;
        if (gpu) {
            #if GPU == GPU_CUDA
            std::cout << "[GPU] CUDA" << std::endl;
            __uint128_t currentNonce = nonce;
            bool showDeviceInfo = verbose;
            while (!found.load()) {
                size_t nonceOffset = 0;
                std::vector<std::uint8_t> data = prepare(block, currentNonce, hash, miner, nonceOffset);
                std::vector<std::uint8_t> input(data.size());
                std::memcpy(input.data(), data.data(), data.size());
                std::vector<std::uint8_t> output(32);
                __uint128_t validNonce = 0;
                if (verbose) {
                    std::cout << "[GPU] Mining batch: " << i128ToString(nonce) << " block: " << block
                              << " difficulty: " << difficulty << " hash: " << hash << std::endl;
                    std::cout.flush();
                }
                auto gpuStartTime = std::chrono::high_resolution_clock::now();
                int res = executeKernel(deviceId, input.data(), data.size(), currentNonce, nonceOffset,
                                             batchSize, difficulty, maxThreads, output.data(), &validNonce, showDeviceInfo);
                showDeviceInfo = false;
                auto gpuEndTime = std::chrono::high_resolution_clock::now();
                std::chrono::duration<double> elapsedTime = gpuEndTime - gpuStartTime;
                hashMetric.store(batchSize / elapsedTime.count());
                if (res == 1) {
                    found.store(true);
                    result.first.assign(output.begin(), output.end());
                    result.second = validNonce;
                    break;
                }
                currentNonce += batchSize;
            }
            #endif
        } else {
            __uint128_t currentNonce = nonce;
            std::vector<std::thread> threads;
            std::mutex resultMutex;
            while (!found.load()) {
                while (static_cast<int>(threads.size()) < maxThreads && !found.load()) {
                    __uint128_t endNonce = currentNonce + batchSize;
                    threads.emplace_back([&, startNonce = currentNonce, endNonce]() {
                        auto localResult = find(block, hash, startNonce, difficulty, miner, verbose, batchSize);
                        if (!localResult.first.empty()) {
                            std::lock_guard<std::mutex> lock(resultMutex);
                            result = localResult;
                            found.store(true);
                        }
                    });
                    currentNonce = endNonce;
                }
                threads.erase(std::remove_if(threads.begin(), threads.end(),
                    [](std::thread& t) {
                        if (t.joinable()) {
                            t.join();
                            return true;
                        }
                        return false;
                    }), threads.end());
            }

            for (auto& t : threads) {
                if (t.joinable()) {
                    t.join();
                }
            }
        }

        if (!result.first.empty()) {
            std::cout << "{\n"
                      << "  \"hash\": \"";
            for (const auto& byte : result.first) {
                std::printf("%02x", byte);
            }
            std::cout << "\",\n"
                      << "  \"nonce\": " << result.second << "\n"
                      << "}\n";
        } else {
            std::cout << "No valid hash found.\n";
        }

        monitorThread.detach();
    }
    catch (const std::exception& e) {
        std::cerr << "Exception: " << e.what() << std::endl;
    }
    return 0;
}