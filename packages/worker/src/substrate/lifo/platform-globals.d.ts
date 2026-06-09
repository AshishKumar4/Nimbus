interface Navigator {
	userAgent: string;
	hardwareConcurrency?: number;
	language?: string;
	clipboard?: {
		writeText(text: string): Promise<void>;
	};
	connection?: {
		effectiveType?: string;
		downlink?: number;
		rtt?: number;
		type?: string;
	};
}

declare const navigator: Navigator;

interface TextEncoder {
	encode(input?: string): Uint8Array;
}

declare const TextEncoder: {
	new(): TextEncoder;
};

interface TextDecoder {
	decode(input?: ArrayBuffer | ArrayBufferView, options?: { stream?: boolean }): string;
}

declare const TextDecoder: {
	new(label?: string, options?: { fatal?: boolean; ignoreBOM?: boolean }): TextDecoder;
};

declare const PerformanceObserver: {
	new(callback?: unknown): {
		observe(): void;
		disconnect(): void;
	};
} | undefined;

type CompressionFormat = 'gzip' | 'deflate' | 'deflate-raw';
