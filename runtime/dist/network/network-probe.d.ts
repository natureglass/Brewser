export interface NetworkProbeAttempt {
    url: string;
    reachable: boolean;
    httpStatus: number | null;
    bytes: number | null;
    message: string;
    errorName?: string;
    errorType?: string;
    errorStack?: string;
    errorJson?: string;
    latencyMs: number;
}
export interface NetworkProbeResult {
    overallReachable: boolean;
    attempts: NetworkProbeAttempt[];
}
/**
 * Boot-time probe to surface whether the runtime fetch can actually reach
 * the internet on this device. Bypasses `BrowserPermissionPolicy` because
 * it runs before any app session is started; the result is purely
 * diagnostic and never executed as a page bundle.
 *
 * Probes HTTPS first, then plain HTTP, so we can isolate TLS-specific
 * failures from general "no network" failures.
 */
export declare function probeNetwork(): Promise<NetworkProbeResult>;
//# sourceMappingURL=network-probe.d.ts.map