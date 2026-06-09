export declare function createOs(env: Record<string, string>): {
    arch: () => string;
    platform: () => string;
    type: () => string;
    release: () => string;
    hostname: () => string;
    homedir: () => string;
    tmpdir: () => string;
    cpus: () => {
        model: string;
        speed: number;
        times: {
            user: number;
            nice: number;
            sys: number;
            idle: number;
            irq: number;
        };
    }[];
    totalmem: () => number;
    freemem: () => number;
    uptime: () => number;
    loadavg: () => number[];
    networkInterfaces: () => {};
    userInfo: () => {
        uid: number;
        gid: number;
        username: string;
        homedir: string;
        shell: string;
    };
    EOL: string;
    endianness: () => "LE";
    constants: {
        signals: Record<string, number>;
        errno: Record<string, number>;
    };
};
//# sourceMappingURL=os.d.ts.map