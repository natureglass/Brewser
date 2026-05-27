import { BrowserShell } from './browser-shell.js';

async function main() {
	const shell = new BrowserShell();
	await shell.run();
}

main().catch((error) => {
	console.debug('[switch-web-browser] fatal error:', error);
});
