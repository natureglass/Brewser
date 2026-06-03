const KNOWN_SCHEMES = ['brewser', 'http', 'https'] as const;

function hasScheme(text: string): boolean {
	return /^[a-zA-Z][a-zA-Z\d+\-.]*:/.test(text);
}

function isKnownScheme(text: string): boolean {
	const match = text.match(/^([a-zA-Z][a-zA-Z\d+\-.]*):/);
	if (!match) return false;
	return (KNOWN_SCHEMES as readonly string[]).includes(match[1].toLowerCase());
}

function ensureRootTrailingSlash(url: string): string {
	const schemeEnd = url.indexOf('://');
	if (schemeEnd === -1) return url;
	const pathStart = url.indexOf('/', schemeEnd + 3);
	return pathStart === -1 ? `${url}/` : url;
}

/**
 * Holds the in-progress address-bar text and resolves it to a navigable URL.
 *
 * The resolver is intentionally tiny:
 *   - `brewser://`, `http://`, `https://` → use as-is (with a trailing slash
 *     on the root if missing).
 *   - any other recognized scheme → use as-is, untouched.
 *   - everything else → treat as a bare host and prepend `https://`.
 */
export class AddressBarInput {
	private value = '';

	get text(): string {
		return this.value;
	}

	setText(value: string): void {
		this.value = value;
	}

	clear(): void {
		this.value = '';
	}

	resolve(): string | null {
		const trimmed = this.value.trim();
		if (!trimmed) return null;

		if (isKnownScheme(trimmed)) {
			return ensureRootTrailingSlash(trimmed);
		}
		if (hasScheme(trimmed)) {
			return trimmed;
		}
		// Bare host → assume https. The browser permission policy will gate it.
		return `https://${trimmed}/`;
	}
}
