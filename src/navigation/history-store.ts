/**
 * Persistent history of visited URLs. Backed by a JSONL file on the SD card
 * (one record per line), loaded into memory on construction and rewritten
 * synchronously on every `record()`. Capped to keep the file bounded.
 */
export interface HistoryEntry {
	url: string;
	title: string;
	visitedAt: number;
}

const DEFAULT_MAX_ENTRIES = 100;
const decoder = new TextDecoder();

export interface HistoryStoreOptions {
	/** Absolute SD-card path to the journal file. */
	path: string;
	/** Cap on stored entries. Older ones are dropped when exceeded. */
	maxEntries?: number;
}

export class HistoryStore {
	private readonly path: string;
	private readonly maxEntries: number;
	private entries: HistoryEntry[] = [];

	constructor(options: HistoryStoreOptions) {
		this.path = options.path;
		this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
		this.load();
	}

	/**
	 * Append a navigation event. If the most recent entry shares the same
	 * URL, just refresh its timestamp (no duplicate row). Persists synchronously.
	 */
	record(entry: HistoryEntry): void {
		const last = this.entries[this.entries.length - 1];
		if (last && last.url === entry.url) {
			last.visitedAt = entry.visitedAt;
			last.title = entry.title || last.title;
		} else {
			this.entries.push(entry);
			if (this.entries.length > this.maxEntries) {
				this.entries = this.entries.slice(-this.maxEntries);
			}
		}
		this.persist();
	}

	/** Most-recent first, capped to `limit`. */
	recent(limit = 50): HistoryEntry[] {
		const slice = this.entries.slice(-limit);
		slice.reverse();
		return slice;
	}

	/** Empty the journal and rewrite the file. */
	clear(): void {
		this.entries = [];
		this.persist();
	}

	private load(): void {
		try {
			const buffer = Switch.readFileSync(this.path);
			if (!buffer) return;
			const text = decoder.decode(buffer);
			for (const line of text.split('\n')) {
				const trimmed = line.trim();
				if (!trimmed) continue;
				try {
					const parsed = JSON.parse(trimmed);
					if (
						parsed &&
						typeof parsed.url === 'string' &&
						typeof parsed.visitedAt === 'number'
					) {
						this.entries.push({
							url: parsed.url,
							title: typeof parsed.title === 'string' ? parsed.title : parsed.url,
							visitedAt: parsed.visitedAt,
						});
					}
				} catch {
					// skip malformed lines
				}
			}
			// Truncate to the cap if a hand-edited file is too long.
			if (this.entries.length > this.maxEntries) {
				this.entries = this.entries.slice(-this.maxEntries);
			}
		} catch (error) {
			console.debug(`[switch-web-browser] history load failed: ${error}`);
		}
	}

	private persist(): void {
		try {
			const body = this.entries.map((e) => JSON.stringify(e)).join('\n');
			Switch.writeFileSync(this.path, body ? `${body}\n` : '');
		} catch (error) {
			console.debug(`[switch-web-browser] history persist failed: ${error}`);
		}
	}
}
