// tps.ts

export interface TPSCalculationParams {
    maxWorkers: number;
    generationTimeSeconds: number;
    statusPollIntervalSeconds: number;
    imagesPerSession: number;
    ipLimitWindowMinutes?: number;
    maxStatusCallsOnInit?: number;
    averageThinkTimeSeconds?: number;
    safetyFactorPercent?: number;
    burstTrafficMultiplier?: number;
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
    sessionsPerIpWindow: number;
}

interface TPSLimits {
    runTPS: number;
    statusTPS: number;
    runTPSBurst: number;
    statusTPSBurst: number;
    ipRunLimit: number;
    ipStatusLimit: number;
}

interface TPSCalculationResult {
    limits: TPSLimits;
    details: {
        multipliers: TPSMultipliers;
        metrics: TPSMetrics;
        safetyFactor?: number;
        burstFactor?: number;
    };
    inputs: TPSCalculationParams;
}

export const calculateTPS = ({
    maxWorkers,
    generationTimeSeconds,
    statusPollIntervalSeconds,
    imagesPerSession,
    ipLimitWindowMinutes = 5, // This value comes from API gateway WAF, has to be 5
    maxStatusCallsOnInit = 50, // This is from browser metrics on loading larger model
    averageThinkTimeSeconds = 15,
    safetyFactorPercent = 0,
    burstTrafficMultiplier = 2,
}: TPSCalculationParams): TPSCalculationResult => {
    // Calculate base metrics
    const cycleTimeSeconds = generationTimeSeconds + averageThinkTimeSeconds;
    const sessionDurationSeconds = imagesPerSession * cycleTimeSeconds;
    const statusChecksPerGeneration =
        generationTimeSeconds / statusPollIntervalSeconds;

    // Calculate API calls per session
    const runCallsPerSession = imagesPerSession;
    const statusCallsPerSession = imagesPerSession * statusChecksPerGeneration;

    // Calculate calls per second per user
    const runCallsPerSecondPerUser =
        runCallsPerSession / sessionDurationSeconds;
    const statusCallsPerSecondPerUser =
        statusCallsPerSession / sessionDurationSeconds;

    // Calculate worker capacity and maximum supported users
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

    // Calculate IP-based limits
    const sessionsPerIpWindow = Math.max(
        1,
        Math.floor((ipLimitWindowMinutes * 60) / sessionDurationSeconds)
    );

    // Calculate total requests allowed per IP in the window based purely on session patterns
    const ipRunLimit = Math.max(
        1,
        Math.floor(safetyMultiplier * runCallsPerSession * sessionsPerIpWindow)
    );
    const ipStatusLimit = Math.max(
        1,
        maxStatusCallsOnInit +
            Math.floor(
                safetyMultiplier * statusCallsPerSession * sessionsPerIpWindow
            )
    );

    return {
        limits: {
            runTPS: Math.max(1, Number(runTPS.toFixed(2))),
            statusTPS: Math.max(1, Number(statusTPS.toFixed(2))),
            runTPSBurst: Math.max(1, Math.floor(runTPSBurst)),
            statusTPSBurst: Math.max(1, Math.floor(statusTPSBurst)),
            ipRunLimit: Math.max(1, Math.floor(ipRunLimit)),
            ipStatusLimit: Math.max(1, Math.floor(ipStatusLimit)),
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
                sessionsPerIpWindow,
            },
            safetyFactor: safetyFactorPercent,
            burstFactor: burstTrafficMultiplier,
        },
        inputs: {
            maxWorkers,
            generationTimeSeconds,
            statusPollIntervalSeconds,
            imagesPerSession,
            ipLimitWindowMinutes,
            maxStatusCallsOnInit,
            averageThinkTimeSeconds,
            safetyFactorPercent,
            burstTrafficMultiplier,
        },
    };
};
