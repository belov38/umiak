export interface TransferProgress {
	verifiedBytes: number;
	transferredBytes: number;
	totalBytes: number;
	elapsedSeconds?: number;
	wireBytes?: number;
	processedBytes?: number;
}
