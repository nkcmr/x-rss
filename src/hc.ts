export async function reportHealthcheck<R = unknown>(env: Env, ctx: ExecutionContext, hcID: string, fn: () => R): Promise<Awaited<R>> {
	const r = await fn();
	ctx.waitUntil(reportFinish(env, hcID));
	return r;
}

const MAX_ATTEMPTS = 5;

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

async function reliableFetch(env: Env, input: RequestInfo, init?: RequestInit<RequestInitCfProperties>): Promise<boolean> {
	const init2: RequestInit = {
		...(init || {}),
	};
	const headers = new Headers(init?.headers);
	headers.set('User-Agent', `x-rss.reliableFetch`);
	init2.headers = headers;
	for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
		const ac = new AbortController();
		try {
			const response = await Promise.race([
				fetch(input, {
					...init2,
					signal: ac.signal,
				}),
				sleep(2_500),
			]);
			if (!response) {
				ac.abort('timeout');
				console.log('reliableFetch: timeout');
				// timeout
				continue;
			}
			if (!response.ok) {
				await sleep(100);
				console.log('reliableFetch: non-ok reponse');
				continue;
			}
			return true;
		} catch (e) {
			console.log(`reliableFetch: fetch failure: ${e}`);
		} finally {
			ac.abort();
		}
	}
	return false;
}

async function reportFinish(env: Env, id: string): Promise<void> {
	if (!id) {
		console.warn('healtcheck/reportFinish: healthcheck id not configured');
		return;
	}

	const ok = await reliableFetch(env, `https://hc-ping.com/${id}`);
	if (!ok) {
		throw new Error(`healtcheck.io: reportFinish failed`);
	}
}
