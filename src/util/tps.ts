// tps.ts

export interface TPSCalculationParams {
    generationTimeSeconds: number;
    statusPollIntervalSeconds: number;
    imagesPerSession: number;
    averageThinkTimeSeconds?: number;
    safetyFactorPercent?: number;
    burstTrafficMultiplier?: number;
    maxWorkers: number;
}

interface TPSMultipliers {
    runCallsPerSecondPerUser: number;
    statusCallsPerSecondPerUser: number;
}

interface TPSMetrics {
    statusChecksPerGeneration: number;
    sessionDurationSeconds: number;
    runCallsPerSession: number;
    statusCallsPerSession: number;
    cycleTimeSeconds: number;
    maxSupportedUsers: number;
    workerLimitedTPS: number;
}

interface TPSLimits {
    runTPS: number;
    statusTPS: number;
    runTPSBurst: number;
    statusTPSBurst: number;
}

interface TPSCalculationResult {
    limits: TPSLimits;
    details: {
        multipliers: TPSMultipliers;
        metrics: TPSMetrics;
        safetyFactor?: number;
        burstTrafficFactor?: number;
    };
    inputs: TPSCalculationParams;
}

export const calculateTPS = ({
    generationTimeSeconds,
    statusPollIntervalSeconds,
    imagesPerSession,
    averageThinkTimeSeconds = 15,
    safetyFactorPercent = 0,
    burstTrafficMultiplier = 2,
    maxWorkers,
}: TPSCalculationParams): TPSCalculationResult => {
    // Calculate base metrics
    const statusChecksPerGeneration =
        generationTimeSeconds / statusPollIntervalSeconds;
    const sessionDurationSeconds = imagesPerSession * generationTimeSeconds;

    // Calculate API calls per session
    const runCallsPerSession = imagesPerSession;
    const statusCallsPerSession = imagesPerSession * statusChecksPerGeneration;

    // Calculate calls per second per user
    const runCallsPerSecondPerUser =
        runCallsPerSession / sessionDurationSeconds;
    const statusCallsPerSecondPerUser =
        statusCallsPerSession / sessionDurationSeconds;

    // Calculate worker capacity and maximum supported users
    const cycleTimeSeconds = generationTimeSeconds + averageThinkTimeSeconds;
    const workerUtilizationRatio = generationTimeSeconds / cycleTimeSeconds;
    const maxSupportedUsers = maxWorkers / workerUtilizationRatio;

    // Calculate worker-limited TPS
    const workerLimitedTPS = Math.max(maxWorkers / generationTimeSeconds, 1);

    // Apply safety factor
    const safetyMultiplier = 1 + safetyFactorPercent / 100;

    // Calculate TPS based on max supported users
    const runTPS = Math.min(
        runCallsPerSecondPerUser * maxSupportedUsers * safetyMultiplier,
        workerLimitedTPS
    );

    const statusTPS =
        statusCallsPerSecondPerUser * maxSupportedUsers * safetyMultiplier;

    // Calculate burst limits
    const runTPSBurst = Math.min(
        workerLimitedTPS,
        runTPS * burstTrafficMultiplier
    );
    const statusTPSBurst = statusTPS * burstTrafficMultiplier;

    return {
        limits: {
            runTPS: Math.max(1, Number(runTPS.toFixed(2))),
            statusTPS: Math.max(1, Number(statusTPS.toFixed(2))),
            runTPSBurst: Math.max(1, Math.floor(runTPSBurst)),
            statusTPSBurst: Math.max(1, Math.floor(statusTPSBurst)),
        },
        details: {
            multipliers: {
                runCallsPerSecondPerUser,
                statusCallsPerSecondPerUser,
            },
            metrics: {
                statusChecksPerGeneration,
                sessionDurationSeconds,
                runCallsPerSession,
                statusCallsPerSession,
                cycleTimeSeconds,
                maxSupportedUsers,
                workerLimitedTPS,
            },
            safetyFactor: safetyFactorPercent,
            burstTrafficFactor: burstTrafficMultiplier,
        },
        inputs: {
            generationTimeSeconds,
            statusPollIntervalSeconds,
            imagesPerSession,
            averageThinkTimeSeconds,
            safetyFactorPercent,
            burstTrafficMultiplier,
            maxWorkers,
        },
    };
};
