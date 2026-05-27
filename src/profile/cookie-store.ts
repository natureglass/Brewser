/**
 * Cookie jar scoped to one `BrowserProfile`.
 *
 * Placeholder. The eventual implementation parses Set-Cookie, applies
 * SameSite/Secure/HttpOnly rules, and persists to disk.
 */
export interface CookieRecord {
	name: string;
	value: string;
	domain: string;
	path: string;
	expires?: number;
	secure?: boolean;
	httpOnly?: boolean;
	sameSite?: 'Strict' | 'Lax' | 'None';
}

export class CookieStore {
	private cookies: CookieRecord[] = [];

	get(domain: string): CookieRecord[] {
		return this.cookies.filter((c) => c.domain === domain);
	}

	set(cookie: CookieRecord): void {
		this.cookies.push(cookie);
	}

	clear(): void {
		this.cookies = [];
	}
}
